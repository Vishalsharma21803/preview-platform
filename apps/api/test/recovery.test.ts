import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/db/memory-repository.js";
import { DeploymentWorker } from "../src/worker/worker.js";
import { body, config, deferred, FakeRuntime, queue } from "./helpers.js";

test("preview reports serving metadata throughout queued/failed replacement; complete switches it", async () => {
  const repo = new MemoryRepository(); const runtime = new FakeRuntime(); const worker = new DeploymentWorker(repo, runtime, config);
  const first = await queue(repo); await worker.processOne();
  const secondInput = { commitSha: "c".repeat(40), image: body.image.replace("b".repeat(64), "d".repeat(64)) };
  const second = await queue(repo, secondInput);
  for (const stage of ["queued", "failed"] as const) {
    if (stage === "failed") { runtime.healthy = false; await worker.processOne(); }
    const preview = await repo.getPreview(first.previewId);
    assert.equal(preview?.status, stage); assert.equal(preview?.commitSha, first.commitSha);
    assert.equal(preview?.image, first.image); assert.equal(preview?.deploymentId, first.id);
    assert.equal((await repo.getDeployment(second.id))?.image, secondInput.image);
  }
  assert.ok(runtime.removedImages.includes(secondInput.image));
  assert.ok(!runtime.removedImages.includes(first.image));
  runtime.healthy = true;
  const retry = await queue(repo, secondInput); await worker.processOne();
  const switched = await repo.getPreview(first.previewId);
  assert.equal(switched?.image, secondInput.image); assert.equal(switched?.commitSha, secondInput.commitSha);
  assert.equal(switched?.deploymentId, retry.id);
  assert.ok(runtime.removedImages.includes(first.image));
});

for (const state of ["missing", "stopped"] as const) {
  test(`restart with externally ${state} container records unhealthy state and permits other/new deployments`, async () => {
    const repo = new MemoryRepository(); const runtime = new FakeRuntime(); const worker = new DeploymentWorker(repo, runtime, config);
    const first = await queue(repo); await worker.processOne();
    const containerId = (await repo.getPreview(first.previewId))!.containerId!;
    if (state === "missing") runtime.containers.delete(containerId); else runtime.stopped.add(containerId);
    const next = await queue(repo, { pullRequestNumber: body.pullRequestNumber + 1 });
    const restarted = new DeploymentWorker(repo, runtime, config);
    await restarted.processOne();
    assert.equal((await repo.getPreview(first.previewId))?.runtimeState, state);
    assert.equal((await repo.getPreview(first.previewId))?.health, "unhealthy");
    assert.ok(!runtime.routes.has(first.previewId));
    assert.equal((await repo.getDeployment(next.id))?.status, "healthy");
    const newFirst = await queue(repo); assert.notEqual(newFirst.id, first.id); await restarted.processOne();
    assert.equal((await repo.getDeployment(newFirst.id))?.status, "healthy");
    assert.equal((await repo.getPreview(first.previewId))?.runtimeState, "running");
    assert.ok(runtime.routes.has(first.previewId));
  });
}

test("GC protects queued/serving images, excludes foreign history, and serializes eligibility with enqueue", async () => {
  const repo = new MemoryRepository(); const runtime = new FakeRuntime(); const worker = new DeploymentWorker(repo, runtime, config);
  const first = await queue(repo); await worker.processOne();
  const unusedImage = body.image.replace("b".repeat(64), "c".repeat(64));
  const failed = await queue(repo, { image: unusedImage });
  assert.deepEqual(await repo.unusedImages(body.repository), []);
  await repo.claimNext("owner", 1000); await repo.fail(failed.id, "owner", "deployment failed");
  assert.deepEqual(await repo.unusedImages(body.repository), [unusedImage]);
  const entered = deferred(); const finish = deferred();
  const collection = repo.collectImageIfUnused(body.repository, unusedImage, async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  let enqueued = false;
  const enqueue = queue(repo, { image: unusedImage, commitSha: "d".repeat(40) }).then(() => { enqueued = true; });
  await Promise.resolve(); assert.equal(enqueued, false);
  finish.resolve(); await Promise.all([collection, enqueue]);
  let removed = false;
  await repo.collectImageIfUnused(body.repository, unusedImage, async () => { removed = true; });
  assert.equal(removed, false);
  assert.ok(!runtime.removedImages.includes(first.image));
  assert.deepEqual(await repo.unusedImages("other/repository"), []);
});
