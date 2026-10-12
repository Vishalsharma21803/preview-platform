import { Pool } from "pg";
import { loadConfig } from "./config/config.js";
import { migrate } from "./db/migrate.js";
import { PostgresRepository } from "./db/postgres-repository.js";
import { createApp } from "./http/app.js";
import { DockerRuntime } from "./runtime/runtime.js";
import { DeploymentWorker } from "./worker/worker.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000 });
// pg emits errors for disconnected idle clients; never let its raw Error dump credentials.
pool.on("error", () => console.error("Database idle connection lost; health checks will report availability"));
await migrate(pool);
// A session lock enforces one runtime writer across API processes, not only timer callbacks.
const workerLock = await pool.connect();
if (!(await workerLock.query("SELECT pg_try_advisory_lock(7312603) AS acquired")).rows[0]?.acquired) {
  workerLock.release(); await pool.end(); throw new Error("A preview worker is already running");
}
const repository = new PostgresRepository(pool);
const worker = new DeploymentWorker(repository, new DockerRuntime(config), config);
const app = createApp({ config, repository, worker });
const server = app.listen(config.PORT, () => console.log(`preview API listening on ${config.PORT}`));
worker.start();
const shutdown = async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await worker.stop();
  await workerLock.query("SELECT pg_advisory_unlock(7312603)"); workerLock.release(); await pool.end();
};
// Losing the session lock invalidates the single-writer guarantee. Fail closed; next process recovers.
workerLock.on("error", () => process.exit(1));
let shuttingDown = false;
const onShutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdown().catch(() => { console.error("Preview API shutdown failed"); process.exit(1); });
};
process.once("SIGTERM", onShutdown); process.once("SIGINT", onShutdown);
