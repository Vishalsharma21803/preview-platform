import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DockerRuntime, RuntimeUnavailableError } from "../src/runtime/runtime.js";
import { FileRoutes } from "../src/runtime/routes.js";
import { config, body } from "./helpers.js";

test("Docker candidates are private, constrained, unrouted, and commands bounded", async () => {
  const calls: { args: string[]; timeout: number }[] = [];
  const id = "a".repeat(64);
  const runtime = new DockerRuntime(config, async (args, timeout) => {
    calls.push({ args, timeout });
    if (args[0] === "ps") return `${id}\tpreview-candidate\tpreview-id`;
    if (args[0] === "image" && args[1] === "inspect") return JSON.stringify([{ Id: "sha256:test", RepoDigests: [body.image], RepoTags: [], Config: {} }]);
    if (args[0] === "container" && args[1] === "inspect") return JSON.stringify([{ State: { Running: true }, NetworkSettings: { Networks: { "traefik-public": { IPAddress: "172.18.0.2" } } } }]);
    return id;
  });
  await runtime.pull(body.image);
  const container = await runtime.run({ name: "preview-candidate", previewId: "preview-id", image: body.image,
    network: config.TRAEFIK_NETWORK, memory: config.PREVIEW_MEMORY, cpus: config.PREVIEW_CPUS, pidsLimit: config.PREVIEW_PIDS_LIMIT });
  assert.equal(await runtime.endpoint(container, 3000), "http://172.18.0.2:3000");
  assert.deepEqual(await runtime.listManaged(), [container]);
  const args = calls.find(call => call.args[0] === "run")!.args;
  for (const flag of ["-p", "-P", "--publish", "--privileged", "--volume", "-v", "--mount", "exec"]) assert.ok(!args.includes(flag));
  for (const flag of ["--read-only", "--cap-drop", "ALL", "--pids-limit", "--memory-swap", "traefik.enable=false"]) assert.ok(args.includes(flag));
  assert.ok(calls.find(call => call.args[0] === "ps")!.args.includes("--no-trunc"));
  assert.equal(calls[0]!.timeout, config.DOCKER_PULL_TIMEOUT_MS);
  assert.ok(calls.slice(1).every(call => call.timeout === config.DOCKER_COMMAND_TIMEOUT_MS));
});

test("rm ignores only missing container; daemon and command timeout errors propagate sanitized", async () => {
  const container = { id: "a".repeat(64), name: "candidate", previewId: "preview-id" };
  const missing = new DockerRuntime(config, async () => { throw { stderr: `Error response from daemon: No such container: ${container.id}\n` }; });
  await missing.remove(container);
  for (const error of [{ stderr: "Cannot connect to Docker secret socket" }, { killed: true, stderr: "" }]) {
    const runtime = new DockerRuntime(config, async () => { throw error; });
    await assert.rejects(runtime.remove(container), /^Error: runtime operation failed$/);
  }
});

test("HTTP health is host-side, rejects redirects, bounds timeouts and cancels response bodies", async t => {
  let redirectDestinationHits = 0;
  const server = createServer((req, res) => {
    if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); }
    else if (req.url === "/redirect") { res.writeHead(302, { location: "/destination" }); res.end(); }
    else if (req.url === "/destination") { redirectDestinationHits += 1; res.end("ok"); }
    // /hang deliberately never writes headers.
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runtime = new DockerRuntime(config, async () => { throw new Error("Docker exec must not be used"); });
  assert.ok(await runtime.healthCheck(endpoint, "/healthz", 1, 10));
  assert.equal(await runtime.healthCheck(endpoint, "/redirect", 1, 10), false);
  assert.equal(redirectDestinationHits, 0);
  const start = Date.now();
  assert.equal(await runtime.healthCheck(endpoint, "/hang", 2, 10), false);
  assert.ok(Date.now() - start < 1500);
});

test("file-provider route publishes valid atomic YAML, replaces, lists, and removes", async t => {
  const directory = await mkdtemp("/tmp/omnirush/routes-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const routes = new FileRoutes(directory);
  await routes.activate("pr-1", "pr-1.preview.localhost", "http://172.18.0.2:3000");
  const first = JSON.parse(await readFile(join(directory, "preview-pr-1.yml"), "utf8"));
  assert.equal(first.http.routers["preview-pr-1"].rule, "Host(`pr-1.preview.localhost`)");
  await routes.activate("pr-1", "pr-1.preview.localhost", "http://172.18.0.3:3000");
  const replaced = JSON.parse(await readFile(join(directory, "preview-pr-1.yml"), "utf8"));
  assert.equal(replaced.http.services["preview-pr-1"].loadBalancer.servers[0].url, "http://172.18.0.3:3000");
  assert.deepEqual(await readdir(directory), ["preview-pr-1.yml"]);
  assert.deepEqual(await routes.list(), ["pr-1"]);
  await routes.deactivate("pr-1"); await routes.deactivate("pr-1");
  assert.deepEqual(await routes.list(), []);
});

test("image-declared volumes are rejected before docker run, even with read-only policy", async () => {
  const calls: string[][] = [];
  const runtime = new DockerRuntime(config, async args => {
    calls.push(args);
    return JSON.stringify([{ Id: "sha256:test", RepoDigests: [], RepoTags: [], Config: { Volumes: { "/data": {} } } }]);
  });
  await assert.rejects(runtime.run({ name: "candidate", image: body.image, previewId: "pr-1",
    network: config.TRAEFIK_NETWORK, memory: "256m", cpus: 0.5, pidsLimit: 128 }), /image declares volumes/);
  assert.deepEqual(calls, [["image", "inspect", body.image]]);
});

test("missing and stopped runtime states are distinct from daemon failures", async () => {
  const container = { id: "abc", name: "candidate", previewId: "pr-1" };
  const missing = new DockerRuntime(config, async () => { throw { stderr: "Error: No such container: abc\n" }; });
  await assert.rejects(missing.endpoint(container, 3000), error => error instanceof RuntimeUnavailableError && error.state === "missing");
  const stopped = new DockerRuntime(config, async () => JSON.stringify([{ State: { Running: false } }]));
  await assert.rejects(stopped.endpoint(container, 3000), error => error instanceof RuntimeUnavailableError && error.state === "stopped");
  const daemon = new DockerRuntime(config, async () => { throw { stderr: "Cannot connect to Docker" }; });
  await assert.rejects(daemon.endpoint(container, 3000), error => error instanceof Error && !(error instanceof RuntimeUnavailableError));
});

test("image GC checks all container image IDs, allows only owned digests, never force-removes/prunes", async () => {
  const calls: string[][] = [];
  let used = true;
  const runtime = new DockerRuntime(config, async args => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "inspect") return JSON.stringify([{ Id: "sha256:abc", RepoDigests: [body.image], RepoTags: [], Config: {} }]);
    if (args[0] === "ps") return "unrelated-stopped-container";
    if (args[0] === "container") return used ? "sha256:abc" : "sha256:other";
    return "";
  });
  await runtime.removeImage("ghcr.io/acme/frontend:latest");
  await runtime.removeImage(body.image.replace("acme", "other"));
  assert.equal(calls.length, 0);
  await runtime.removeImage(body.image);
  assert.ok(!calls.some(args => args[1] === "rm"));
  assert.ok(calls.some(args => args[0] === "ps" && !args.includes("--filter")));
  used = false; await runtime.removeImage(body.image);
  assert.deepEqual(calls.find(args => args[1] === "rm"), ["image", "rm", "--no-prune", body.image]);
  const missing = new DockerRuntime(config, async () => { throw { stderr: `Error response from daemon: No such image: ${body.image}\n` }; });
  await missing.removeImage(body.image);
});

test("image GC preserves foreign tags and digest aliases even when no container uses image", async () => {
  for (const references of [
    { RepoTags: ["unrelated/app:keep"], RepoDigests: [body.image] },
    { RepoTags: [], RepoDigests: [body.image, body.image.replace("acme", "other")] },
  ]) {
    const calls: string[][] = [];
    const runtime = new DockerRuntime(config, async args => {
      calls.push(args);
      return JSON.stringify([{ Id: "sha256:abc", Config: {}, ...references }]);
    });
    await runtime.removeImage(body.image);
    assert.deepEqual(calls, [["image", "inspect", body.image]]);
  }
});
