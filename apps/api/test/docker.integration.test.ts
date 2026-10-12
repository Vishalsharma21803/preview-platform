import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";
import { PostgresRepository } from "../src/db/postgres-repository.js";
import { previewIdentity, validateCreateRequest } from "../src/domain/validation.js";
import { DockerRuntime } from "../src/runtime/runtime.js";
import { body, config } from "./helpers.js";

const exec = promisify(execFile);
async function docker(...args: string[]) {
  return (await exec("docker", args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}
const enabled = process.env.RUN_DOCKER_TESTS === "1";

test("real PostgreSQL migrations, capacity, leases, completion, failure sanitization and deletion", { skip: !enabled, timeout: 120000 }, async t => {
  const name = `preview-pg-test-${randomUUID()}`;
  // Ephemeral test database; no credential stored or printed. Test never touches existing databases.
  const password = randomUUID();
  const id = await docker("run", "-d", "--name", name, "--env", `POSTGRES_PASSWORD=${password}`, "postgres:16");
  let pool: Pool | undefined;
  t.after(async () => { await pool?.end(); await docker("rm", "-f", "-v", id); });
  const inspected = JSON.parse(await docker("inspect", id));
  const ip = inspected[0].NetworkSettings.Networks.bridge.IPAddress;
  pool = new Pool({ host: ip, port: 5432, user: "postgres", password, database: "postgres", connectionTimeoutMillis: 1000 });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { await pool.query("SELECT 1"); ready = true; break; } catch { await delay(250); }
  }
  assert.ok(ready, "temporary PostgreSQL started");
  await migrate(pool); await migrate(pool);
  const repo = new PostgresRepository(pool);
  const validated = validateCreateRequest(body, config);
  const input = { ...validated, previewId: previewIdentity(body.repository, body.pullRequestNumber).id };
  const first = await repo.createDeployment(input, 1);
  assert.equal((await repo.createDeployment(input, 1)).id, first.id);
  await assert.rejects(repo.createDeployment({ ...input, pullRequestNumber: 4, previewId: previewIdentity(body.repository, 4).id }, 1));
  const owner = randomUUID();
  assert.equal((await repo.claimNext(owner, 1000))?.id, first.id);
  assert.ok(await repo.heartbeat(first.id, owner, 1000));
  assert.equal(await repo.claimNext(randomUUID(), 1000), undefined);
  assert.ok(await repo.setStarting(first.id, owner));
  assert.ok(await repo.complete(first.id, owner, "f".repeat(64), new Date(Date.now() + 10000)));
  assert.equal((await repo.getPreview(first.previewId))?.containerPort, 3000);
  const replacementImage = body.image.replace("b".repeat(64), "c".repeat(64));
  const replacement = await repo.createDeployment({ ...input, image: replacementImage, containerPort: 8080, commitSha: "e".repeat(40) }, 1);
  assert.equal((await repo.getPreview(first.previewId))?.image, first.image);
  assert.equal((await repo.getPreview(first.previewId))?.commitSha, first.commitSha);
  assert.equal((await repo.getPreview(first.previewId))?.deploymentId, first.id);
  assert.deepEqual(await repo.unusedImages(body.repository), []);
  await repo.claimNext(owner, 1000); await repo.fail(replacement.id, owner, "private Docker output");
  assert.equal((await repo.getDeployment(replacement.id))?.error, "deployment failed");
  assert.equal((await repo.getPreview(first.previewId))?.containerPort, 3000, "failed attempt preserves old serving port");
  assert.equal((await repo.getPreview(first.previewId))?.image, first.image);
  assert.deepEqual(await repo.unusedImages(body.repository), [replacementImage]);
  assert.deepEqual(await repo.unusedImages("other/repository"), []);
  const collected: string[] = [];
  await repo.collectImageIfUnused(body.repository, replacementImage, async () => { collected.push(replacementImage); });
  await repo.collectImageIfUnused(body.repository, first.image, async () => { collected.push(first.image); });
  assert.deepEqual(collected, [replacementImage]);
  await repo.recordRuntimeState(first.previewId, "f".repeat(64), "missing");
  assert.equal((await repo.getPreview(first.previewId))?.health, "unhealthy");
  assert.equal((await repo.getPreview(first.previewId))?.runtimeState, "missing");
  await repo.expire(new Date(Date.now() + 48 * 3600000));
  assert.equal((await repo.getPreview(first.previewId))?.status, "deleting");
  await repo.finishDelete(first.previewId);
  assert.deepEqual(await repo.listActivePreviews(), []);
});

test("real Docker bridge health and Traefik atomic file-provider activation/deactivation", { skip: !enabled, timeout: 180000 }, async t => {
  const suffix = randomUUID(); const image = `preview-api-fixture:${suffix}`; const network = `preview-test-${suffix}`;
  const directory = await mkdtemp("/tmp/omnirush/preview-docker-");
  let imageCreated = false; let networkCreated = false; let containerId: string | undefined; let proxyId: string | undefined;
  t.after(async () => {
    if (proxyId) await docker("rm", "-f", proxyId);
    if (containerId) await docker("rm", "-f", containerId);
    if (networkCreated) await docker("network", "rm", network);
    if (imageCreated) await docker("image", "rm", image);
    await rm(directory, { recursive: true, force: true });
  });
  await docker("build", "-t", image, fileURLToPath(new URL("./fixtures/", import.meta.url)));
  imageCreated = true;
  await docker("network", "create", network);
  networkCreated = true;
  const localConfig = { ...config, ROUTES_DIR: directory, TRAEFIK_NETWORK: network };
  const runtime = new DockerRuntime(localConfig);
  const volumeCandidateName = `preview-volume-test-${suffix}`;
  await assert.rejects(runtime.run({ name: volumeCandidateName, previewId: "integration-volume", image: "postgres:16",
    network, memory: "64m", cpus: 0.1, pidsLimit: 32 }), /image declares volumes/);
  assert.equal(await docker("ps", "-a", "--filter", `name=${volumeCandidateName}`, "--format", "{{.ID}}"), "");
  // docker run can create the named container before an OCI startup failure.
  containerId = `preview-${suffix}`;
  const container = await runtime.run({ name: `preview-${suffix}`, previewId: "integration-pr-1", image,
    network, memory: "64m", cpus: 0.1, pidsLimit: 32 });
  containerId = container.id;
  const endpoint = await runtime.endpoint(container, 3000);
  assert.ok(await runtime.healthCheck(endpoint, "/healthz", 10, 100));
  const inspected = JSON.parse(await docker("inspect", container.id))[0];
  assert.deepEqual(inspected.HostConfig.PortBindings, {});
  assert.equal(inspected.Config.Labels["traefik.enable"], "false");
  assert.ok((await runtime.listManaged()).some(item => item.id === container.id));
  proxyId = await docker("run", "-d", "--name", `preview-proxy-test-${suffix}`, "--network", network,
    "--mount", `type=bind,source=${directory},target=/routes,readonly`, "traefik:v3.3",
    "--providers.file.directory=/routes", "--providers.file.watch=true", "--providers.providersThrottleDuration=100ms", "--entrypoints.web.address=:8080");
  const proxyIp = JSON.parse(await docker("inspect", proxyId))[0].NetworkSettings.Networks[network].IPAddress;
  const routeStatus = () => new Promise<number>((resolve, reject) => {
    // http.request permits an explicit Host independently of the target IP on all supported Node versions.
    const request = httpRequest(`http://${proxyIp}:8080/healthz`, { headers: { Host: "pr-1.preview.localhost" }, timeout: 1000 }, response => {
      response.resume(); resolve(response.statusCode ?? 0);
    });
    request.on("error", reject); request.on("timeout", () => request.destroy(new Error("proxy timeout"))); request.end();
  });
  const waitForStatus = async (expected: number) => {
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { lastStatus = await routeStatus(); if (lastStatus === expected) return; } catch { /* proxy is starting */ }
      await delay(100);
    }
    const logs = await exec("docker", ["logs", proxyId!]);
    assert.fail(`Traefik did not return ${expected}; last status ${lastStatus}; fixture proxy logs: ${logs.stdout}${logs.stderr}`);
  };
  await waitForStatus(404);
  await runtime.activate(container.previewId, "pr-1.preview.localhost", endpoint);
  assert.deepEqual(await runtime.listRoutes(), [container.previewId]);
  await waitForStatus(200);
  await runtime.deactivate(container.previewId);
  await waitForStatus(404);
  await docker("stop", "--time", "0", container.id);
  await assert.rejects(runtime.endpoint(container, 3000), /runtime container stopped/);
  await runtime.remove(container); containerId = undefined;
  await assert.rejects(runtime.endpoint(container, 3000), /runtime container missing/);
});

test("real owned GHCR digest GC preserves unrelated stopped-container use then removes only the digest", { skip: !enabled, timeout: 180000 }, async t => {
  const tag = "ghcr.io/stefanprodan/podinfo:6.9.0";
  const existingIds = new Set((await docker("image", "ls", "--no-trunc", "--quiet")).split("\n"));
  let digest: string | undefined; let owned = false; let unrelated: string | undefined;
  t.after(async () => {
    if (unrelated) await docker("rm", unrelated);
    if (owned) {
      // Remove only references introduced by this isolated fixture; never force or prune user images.
      for (const reference of [tag, digest]) if (reference) {
        try { await docker("image", "inspect", reference); } catch { continue; }
        await docker("image", "rm", "--no-prune", reference);
      }
    }
  });
  await docker("pull", tag);
  const image = JSON.parse(await docker("image", "inspect", tag))[0];
  if (existingIds.has(image.Id)) { t.skip("Fixture image already existed; do not mutate existing image references"); return; }
  owned = true;
  digest = image.RepoDigests.find((reference: string) => reference.startsWith("ghcr.io/stefanprodan/podinfo@sha256:"));
  assert.ok(digest);
  // Create a digest-only local reference, as the deployment worker does.
  await docker("image", "rm", "--no-prune", tag);
  await docker("pull", digest!);
  assert.ok(JSON.parse(await docker("image", "inspect", digest!))[0].RepoTags.every((reference: string) => reference === digest));
  unrelated = await docker("create", "--name", `unrelated-gc-test-${randomUUID()}`, digest!);
  const runtime = new DockerRuntime({ ...config, ALLOWED_IMAGE_NAMESPACE: "stefanprodan/podinfo" });
  await runtime.removeImage(digest!);
  assert.equal(JSON.parse(await docker("image", "inspect", digest!))[0].Id, image.Id);
  assert.equal(JSON.parse(await docker("container", "inspect", unrelated))[0].Image, image.Id);
  await docker("rm", unrelated); unrelated = undefined;
  await runtime.removeImage(digest!);
  await assert.rejects(docker("image", "inspect", digest!));
  await runtime.removeImage(digest!); // already missing is benign
});
