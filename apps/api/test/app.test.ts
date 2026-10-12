import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryRepository } from "../src/db/memory-repository.js";
import { createApp } from "../src/http/app.js";
import { DeploymentWorker } from "../src/worker/worker.js";
import { body, config, FakeRuntime } from "./helpers.js";

async function setup(t: import("node:test").TestContext) {
  const repo = new MemoryRepository(); const runtime = new FakeRuntime();
  const worker = new DeploymentWorker(repo, runtime, config);
  const server = createServer(createApp({ config, repository: repo, worker }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await worker.stop(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (method: string, path: string, data?: unknown, token?: string) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { repo, runtime, worker, request };
}

test("public reads, bearer protection, digest policy, async deployment, idempotency and delete", async t => {
  const { request, worker, runtime } = await setup(t);
  assert.equal((await request("GET", "/api/previews")).status, 200);
  assert.equal((await request("POST", "/api/deployments", body)).status, 401);
  assert.equal((await request("POST", "/api/deployments", body, "wrong")).status, 403);
  assert.equal((await request("POST", "/api/deployments", { ...body, image: "ghcr.io/acme/frontend:latest" }, config.DEPLOYMENT_TOKEN)).status, 400);
  const response = await request("POST", "/api/deployments", body, config.DEPLOYMENT_TOKEN);
  assert.equal(response.status, 202);
  const created = await response.json();
  assert.equal(created.status, "queued");
  assert.equal(created.previewUrl, "http://13.63.54.222/pr-3/");
  const duplicate = await (await request("POST", "/api/deployments", body, config.DEPLOYMENT_TOKEN)).json();
  assert.equal(duplicate.id, created.id);
  await worker.processOne();
  const ready = await (await request("GET", `/api/deployments/${created.id}`)).json();
  assert.equal(ready.status, "healthy");
  const preview = await (await request("GET", `/api/previews/${created.previewId}`)).json();
  assert.equal(preview.path, "/pr-3");
  assert.equal(preview.previewUrl, "http://13.63.54.222/pr-3/");
  assert.equal((await request("POST", "/api/deployments", { ...body, pullRequestNumber: body.pullRequestNumber + 1 }, config.DEPLOYMENT_TOKEN)).status, 429);
  assert.equal((await request("DELETE", `/api/previews/${created.previewId}`)).status, 401);
  assert.equal((await request("DELETE", `/api/previews/${created.previewId}`, undefined, config.DEPLOYMENT_TOKEN)).status, 202);
  assert.equal(runtime.containers.size, 0); assert.equal(runtime.routes.size, 0);
  assert.equal((await request("GET", `/api/previews/${created.previewId}`)).status, 404);
});

test("public GET sanitizes legacy/raw deployment failures and database errors", async t => {
  const { request, repo } = await setup(t);
  const created = await (await request("POST", "/api/deployments", body, config.DEPLOYMENT_TOKEN)).json();
  repo.deployments.get(created.id)!.error = "docker stderr secret credential";
  assert.equal((await (await request("GET", `/api/deployments/${created.id}`)).json()).error, "deployment failed");
  repo.getDeployment = async () => { throw new Error("postgres://secret"); };
  const response = await request("GET", `/api/deployments/${created.id}`);
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: "internal server error" });
});

test("malformed IDs and oversized bodies fail validation; mutation rate is bounded", async t => {
  const { request } = await setup(t);
  assert.equal((await request("GET", "/api/deployments/not-a-uuid")).status, 400);
  assert.equal((await request("GET", "/api/deployments/00000000-0000-0000-0000-000000000000")).status, 404);
  assert.equal((await request("POST", "/api/deployments", { payload: "x".repeat(40000) }, config.DEPLOYMENT_TOKEN)).status, 413);
  for (let i = 0; i < config.MUTATION_RATE_LIMIT; i++) {
    assert.equal((await request("POST", "/api/deployments", {}, config.DEPLOYMENT_TOKEN)).status, 400);
  }
  assert.equal((await request("POST", "/api/deployments", {}, config.DEPLOYMENT_TOKEN)).status, 429);
  assert.equal((await request("GET", "/api/previews")).status, 200);
});

test("public preview keeps serving commit/image while failed replacement details stay on deployment endpoint", async t => {
  const { request, worker, runtime } = await setup(t);
  const first = await (await request("POST", "/api/deployments", body, config.DEPLOYMENT_TOKEN)).json();
  await worker.processOne();
  const nextBody = { ...body, commitSha: "d".repeat(40), image: body.image.replace("b".repeat(64), "e".repeat(64)) };
  const second = await (await request("POST", "/api/deployments", nextBody, config.DEPLOYMENT_TOKEN)).json();
  for (const stage of ["queued", "failed"]) {
    if (stage === "failed") { runtime.healthy = false; await worker.processOne(); }
    const preview = await (await request("GET", `/api/previews/${first.previewId}`)).json();
    assert.equal(preview.status, stage); assert.equal(preview.commitSha, body.commitSha);
    assert.equal(preview.image, body.image); assert.equal(preview.deploymentId, first.id);
  }
  const attempt = await (await request("GET", `/api/deployments/${second.id}`)).json();
  assert.equal(attempt.commitSha, nextBody.commitSha); assert.equal(attempt.image, nextBody.image);
});
