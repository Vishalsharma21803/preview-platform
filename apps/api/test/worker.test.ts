import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { MemoryRepository } from "../src/db/memory-repository.js";
import { DeploymentWorker } from "../src/worker/worker.js";
import { body, config, deferred, FakeRuntime, queue } from "./helpers.js";

function setup() {
  const repo = new MemoryRepository(); const runtime = new FakeRuntime();
  const worker = new DeploymentWorker(repo, runtime, { ...config, WORKER_LEASE_MS: 1000, WORKER_POLL_MS: 100 });
  return { repo, runtime, worker };
}
test("failed replacement preserves old container and route; candidate never routed before health", async () => {
  const { repo, runtime, worker } = setup();
  const first = await queue(repo); await worker.processOne();
  const previous = await repo.getPreview(first.previewId); const oldRoute = runtime.routes.get(first.previewId);
  const healthStarted = deferred(); const healthFinish = deferred();
  runtime.healthHook = async () => { healthStarted.resolve(); await healthFinish.promise; };
  runtime.healthy = false;
  const second = await queue(repo, { commitSha: "c".repeat(40) });
  const deploy = worker.processOne(); await healthStarted.promise;
  assert.equal(runtime.routes.get(first.previewId), oldRoute);
  assert.equal(runtime.containers.size, 2);
  healthFinish.resolve(); await deploy;
  assert.equal((await repo.getDeployment(second.id))?.status, "failed");
  assert.equal(runtime.containers.size, 1); assert.ok(runtime.containers.has(previous!.containerId!));
  assert.equal(runtime.routes.get(first.previewId), oldRoute);
  await worker.reconcile(); assert.ok(runtime.containers.has(previous!.containerId!));
});

test("successful replacement routes healthy candidate before deleting old", async () => {
  const { repo, runtime, worker } = setup();
  const first = await queue(repo); await worker.processOne();
  const old = (await repo.getPreview(first.previewId))!.containerId!;
  runtime.events.length = 0;
  const second = await queue(repo, { commitSha: "d".repeat(40) }); await worker.processOne();
  assert.equal((await repo.getDeployment(second.id))?.status, "healthy");
  assert.ok(runtime.events.indexOf("health") < runtime.events.findIndex(event => event.startsWith("activate:")));
  assert.ok(runtime.events.findIndex(event => event.startsWith("activate:")) < runtime.events.indexOf(`remove:${old}`));
  assert.equal(runtime.containers.size, 1); assert.ok(!runtime.containers.has(old));
});

test("delete during deployment cancels publish and serialized reconciliation removes both containers", async () => {
  const { repo, runtime, worker } = setup();
  const first = await queue(repo); await worker.processOne();
  const started = deferred(); const finish = deferred();
  runtime.healthHook = async () => { started.resolve(); await finish.promise; };
  const second = await queue(repo, { commitSha: "e".repeat(40) });
  const deploy = worker.processOne(); await started.promise;
  const deletion = worker.removePreview(first.previewId);
  const reconciliation = worker.reconcile();
  await delay(10);
  assert.equal(runtime.containers.size, 2, "reconciliation waits for runtime owner");
  assert.equal((await repo.getPreview(first.previewId))?.status, "deleting");
  finish.resolve(); await Promise.all([deploy, deletion, reconciliation]);
  assert.equal(runtime.containers.size, 0); assert.equal(runtime.routes.size, 0);
  assert.equal((await repo.getPreview(first.previewId))?.status, "deleted");
  assert.equal((await repo.getDeployment(second.id))?.status, "deleted");
});

test("expiry completes deletion; unrelated healthy preview survives reconciliation and restart", async () => {
  const { repo, runtime, worker } = setup();
  const first = await queue(repo); await worker.processOne();
  const second = await queue(repo, { pullRequestNumber: body.pullRequestNumber + 1 }); await worker.processOne();
  const liveId = (await repo.getPreview(second.previewId))!.containerId!;
  repo.previews.get(first.previewId)!.expiresAt = new Date(0);
  await new DeploymentWorker(repo, runtime, config).reconcile();
  assert.equal((await repo.getPreview(first.previewId))?.status, "deleted");
  assert.equal(runtime.containers.size, 1); assert.ok(runtime.containers.has(liveId));
  assert.ok(runtime.routes.has(second.previewId)); assert.ok(!runtime.routes.has(first.previewId));
});

test("long pull renews lease and reports healthy beyond original five-second window", async () => {
  const { repo, runtime, worker } = setup();
  const started = deferred(); const finish = deferred();
  let beats = 0;
  const heartbeat = repo.heartbeat.bind(repo);
  repo.heartbeat = async (...args) => { beats += 1; return heartbeat(...args); };
  runtime.pullHook = async () => { started.resolve(); await finish.promise; };
  const job = await queue(repo); const deploy = worker.processOne(); await started.promise;
  await delay(5200);
  assert.ok(beats >= 10); assert.ok(worker.isHealthy());
  assert.ok((await repo.getDeployment(job.id))!.leaseUntil! > new Date());
  assert.equal(await repo.claimNext("another-owner", 1000), undefined);
  finish.resolve(); await deploy;
  assert.equal((await repo.getDeployment(job.id))?.status, "healthy");
});

test("supersession during route activation restores old route and clears active state", async () => {
  const { repo, runtime, worker } = setup();
  const first = await queue(repo); await worker.processOne();
  const oldId = (await repo.getPreview(first.previewId))!.containerId!;
  const oldRoute = runtime.routes.get(first.previewId);
  const second = await queue(repo, { commitSha: "d".repeat(40) });
  runtime.activateHook = async () => {
    runtime.activateHook = async () => {};
    await queue(repo, { commitSha: "e".repeat(40) });
  };
  await worker.processOne();
  assert.equal((await repo.getDeployment(second.id))?.status, "failed");
  assert.equal(runtime.routes.get(first.previewId), oldRoute); assert.ok(runtime.containers.has(oldId));
  await worker.processOne();
  assert.equal((await repo.getPreview(first.previewId))?.status, "healthy");
});

test("complete false terminates attempt; ambiguous committed acknowledgement preserves committed container", async () => {
  const { repo, runtime, worker } = setup();
  const originalComplete = repo.complete.bind(repo);
  repo.complete = async () => false;
  const job = await queue(repo); await worker.processOne();
  assert.equal((await repo.getDeployment(job.id))?.status, "failed");
  assert.equal(runtime.containers.size, 0); assert.equal(runtime.routes.size, 0);
  repo.complete = async (...args) => { await originalComplete(...args); throw new Error("connection lost after COMMIT"); };
  const next = await queue(repo, { commitSha: "f".repeat(40) }); await worker.processOne();
  assert.equal((await repo.getDeployment(next.id))?.status, "healthy");
  assert.equal(runtime.containers.size, 1); assert.equal(runtime.routes.size, 1);
});

test("cleanup failure remains retryable; repository sanitizes arbitrary failure messages", async () => {
  const { repo, runtime, worker } = setup();
  const job = await queue(repo); await worker.processOne();
  runtime.removeHook = async () => { throw new Error("daemon unavailable"); };
  await assert.rejects(worker.removePreview(job.previewId));
  assert.equal((await repo.getPreview(job.previewId))?.status, "deleting");
  runtime.removeHook = async () => {}; await worker.reconcile();
  assert.equal((await repo.getPreview(job.previewId))?.status, "deleted");
  const next = await queue(repo, { commitSha: "e".repeat(40) });
  await repo.claimNext("owner", 1000); await repo.fail(next.id, "owner", "secret docker stderr");
  assert.equal((await repo.getDeployment(next.id))?.error, "deployment failed");
});

test("timer failures are caught and scheduler recovers", async () => {
  const { repo, worker } = setup();
  const health = repo.listActivePreviews.bind(repo); let calls = 0;
  repo.listActivePreviews = async () => { calls += 1; if (calls === 1) throw new Error("db down"); return health(); };
  worker.start(); await delay(250); await worker.stop();
  assert.ok(calls >= 2);
});
