// Real local integration: public GHCR -> Express -> PostgreSQL -> worker -> Docker -> Traefik.
// Owns only UUID-named disposable resources. Requires native Linux Docker networking.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { loadConfig } from '../apps/api/dist/config/config.js';
import { migrate } from '../apps/api/dist/db/migrate.js';
import { PostgresRepository } from '../apps/api/dist/db/postgres-repository.js';
import { createApp } from '../apps/api/dist/http/app.js';
import { DockerRuntime } from '../apps/api/dist/runtime/runtime.js';
import { DeploymentWorker } from '../apps/api/dist/worker/worker.js';

const execute = promisify(execFile);
const docker = async (...args) => (await execute('docker', args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const suffix = randomUUID();
const network = `preview-e2e-${suffix}`;
const routes = await mkdtemp('/tmp/omnirush/preview-e2e-');
const token = randomUUID() + randomUUID();
const password = randomUUID();
const image = 'ghcr.io/stefanprodan/podinfo@sha256:862ca45e61b32392f7941a1bdfdbe5ff8b6899070135f1bdca1c287d0057fc94';
let networkCreated = false, database, proxy, pool, server, worker, runtime;
const inspect = async id => JSON.parse(await docker('inspect', id))[0];
const waitUntil = async (label, check, attempts = 150) => {
  for (let i = 0; i < attempts; i++) { if (await check()) return; await delay(200); }
  throw new Error(`Timed out: ${label}`);
};

try {
  await docker('network', 'create', network); networkCreated = true;
  database = await docker('run', '-d', '--name', `preview-e2e-db-${suffix}`, '--network', network,
    '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:16-alpine');
  const dbIP = (await inspect(database)).NetworkSettings.Networks[network].IPAddress;
  pool = new Pool({ host: dbIP, user: 'postgres', password, database: 'postgres', connectionTimeoutMillis: 1000 });
  await waitUntil('PostgreSQL startup', async () => { try { await pool.query('SELECT 1'); return true; } catch { return false; } });
  await migrate(pool);
  await migrate(pool);
  const config = loadConfig({ DATABASE_URL: `postgres://postgres:${password}@${dbIP}/postgres`,
    DEPLOYMENT_TOKEN: token, ALLOWED_IMAGE_NAMESPACE: 'stefanprodan/podinfo', ROUTES_DIR: routes,
    TRAEFIK_NETWORK: network, WORKER_POLL_MS: '100', RECONCILE_INTERVAL_MS: '1000',
    HEALTH_CHECK_ATTEMPTS: '2', HEALTH_CHECK_INTERVAL_MS: '100', HEALTH_CHECK_TIMEOUT_MS: '500' });
  const repository = new PostgresRepository(pool);
  runtime = new DockerRuntime(config);
  worker = new DeploymentWorker(repository, runtime, config);
  const services = { config, repository, worker };
  server = createApp(services).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  worker.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, method = 'GET', body, authenticated = true) => {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const input = { repository: 'stefanprodan/podinfo', pullRequestNumber: 42, commitSha: 'a'.repeat(40), image, containerPort: 9898 };
  assert.equal((await api('/api/deployments', 'POST', input, false)).status, 401);
  assert.equal((await api('/api/deployments', 'POST', { ...input, image: 'docker.io/library/nginx:latest' })).status, 400);
  assert.equal((await api('/api/previews', 'GET', undefined, false)).status, 200);
  console.log('PASS public reads, protected mutations, namespace/digest policy');

  proxy = await docker('run', '-d', '--name', `preview-e2e-proxy-${suffix}`, '--network', network,
    '--mount', `type=bind,source=${routes},target=/routes,readonly`, 'traefik:v3.6',
    '--providers.file.directory=/routes', '--providers.file.watch=true', '--providers.providersThrottleDuration=100ms', '--entrypoints.web.address=:80');
  const proxyIP = (await inspect(proxy)).NetworkSettings.Networks[network].IPAddress;
  const first = await api('/api/deployments', 'POST', input);
  assert.equal(first.status, 202);
  assert.equal(first.body.previewUrl, 'http://13.63.54.222/pr-42/');
  const previewPath = new URL(first.body.previewUrl).pathname;
  const routeStatus = () => new Promise((resolve, reject) => {
    const req = httpRequest(`http://${proxyIP}${previewPath}healthz`, { timeout: 1000 }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('route timeout'))); req.end();
  });
  const waitStatus = (id, expected) => waitUntil(`deployment ${expected}`, async () => {
    const result = await api(`/api/deployments/${id}`);
    if (result.body.status === 'failed' && expected !== 'failed') throw new Error(`Deployment failed: ${result.body.error}`);
    return result.body.status === expected;
  }, 600);
  await waitStatus(first.body.id, 'healthy');
  await waitUntil('public preview route', async () => { try { return await routeStatus() === 200; } catch { return false; } });
  const duplicate = await api('/api/deployments', 'POST', input);
  assert.equal(duplicate.body.id, first.body.id);
  console.log('PASS actual GHCR pull, asynchronous deployment, PostgreSQL state, Traefik HTTP 200, idempotency');

  const second = await api('/api/deployments', 'POST', { ...input, commitSha: 'b'.repeat(40) });
  await waitStatus(second.body.id, 'healthy');
  await waitUntil('old container cleanup', async () => (await runtime.listManaged()).length === 1);
  await waitUntil('replacement route', async () => await routeStatus() === 200);
  assert.equal(second.body.previewUrl, first.body.previewUrl);
  const candidate = (await runtime.listManaged())[0];
  const details = await inspect(candidate.id);
  assert.deepEqual(details.HostConfig.PortBindings, {});
  assert.equal(details.HostConfig.Privileged, false);
  assert.equal(details.HostConfig.ReadonlyRootfs, true);
  assert.equal(details.HostConfig.Memory, 256 * 1024 * 1024);
  console.log('PASS stable URL replacement, old-container removal, real container constraints');

  const failed = await api('/api/deployments', 'POST', { ...input, commitSha: 'c'.repeat(40), containerPort: 65534 });
  await waitStatus(failed.body.id, 'failed');
  await waitUntil('failed candidate cleanup', async () => (await runtime.listManaged()).length === 1);
  assert.equal((await runtime.listManaged())[0].id, candidate.id);
  assert.equal(await routeStatus(), 200);
  console.log('PASS unhealthy replacement preserves last healthy container and route');

  await worker.stop();
  worker = new DeploymentWorker(new PostgresRepository(pool), runtime, config);
  services.worker = worker;
  worker.start();
  await waitUntil('restart recovery', async () => (await api('/healthz')).status === 200);
  assert.equal(await routeStatus(), 200);
  console.log('PASS worker restart recovers committed route from PostgreSQL');
  assert.equal((await api(`/api/previews/${first.body.previewId}`, 'DELETE')).status, 202);
  await waitUntil('route deletion', async () => await routeStatus() === 404);
  assert.deepEqual(await runtime.listManaged(), []);
  assert.deepEqual((await api('/api/previews')).body, []);
  const reopened = await api('/api/deployments', 'POST', { ...input, commitSha: 'd'.repeat(40) });
  await waitStatus(reopened.body.id, 'healthy');
  await pool.query("UPDATE previews SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [first.body.previewId]);
  await worker.reconcile();
  await waitUntil('expiry route removal', async () => await routeStatus() === 404);
  assert.deepEqual(await runtime.listManaged(), []);
  console.log('PASS authenticated delete, reopened PR, expiry reconciliation, no orphan containers');
  console.log('Local live end-to-end checks passed. GitHub Actions, EC2, public DNS and TLS were not exercised.');
} finally {
  if (worker) await worker.stop();
  if (server) await new Promise(resolve => server.close(resolve));
  await pool?.end();
  // Network filter guarantees only this test run can be removed.
  if (networkCreated) {
    const ids = await docker('ps', '-aq', '--filter', `network=${network}`);
    for (const id of ids.split('\n').filter(Boolean)) await docker('rm', '-f', id);
  }
  if (networkCreated) await docker('network', 'rm', network);
  await rm(routes, { recursive: true, force: true });
}
