import { randomUUID } from "node:crypto";
import type { Config } from "../config/config.js";
import type { DeploymentRepository, DeploymentRecord } from "../domain/types.js";
import { publicDeploymentError } from "../domain/errors.js";
import { validateCreateRequest, validateImage } from "../domain/validation.js";
import { RuntimeUnavailableError, type RuntimeAdapter } from "../runtime/runtime.js";

/** One runtime writer. API deletion records intent immediately; its runtime work joins this queue. */
export class DeploymentWorker {
  private timer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private stopped = false;
  private recovered = false;
  private lastSuccessfulCycle = Date.now();
  private readonly owner = randomUUID();
  constructor(private readonly repository: DeploymentRepository, private readonly runtime: RuntimeAdapter, private readonly config: Config) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(operation);
    this.tail = result.catch(() => { this.recovered = false; }).finally(() => { this.pending -= 1; });
    return result;
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    const tick = () => { if (!this.pending && !this.stopped) void this.processOne().catch(() => undefined); };
    this.timer = setInterval(tick, this.config.WORKER_POLL_MS);
    this.reconcileTimer = setInterval(() => {
      if (!this.pending && !this.stopped) void this.reconcile().catch(() => undefined);
    }, this.config.RECONCILE_INTERVAL_MS);
    tick();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer); clearInterval(this.reconcileTimer);
    this.timer = undefined; this.reconcileTimer = undefined;
    // Keep heartbeat alive until bounded in-flight runtime work has unwound.
    await this.tail;
  }
  isHealthy() {
    return !this.stopped && Date.now() - this.lastSuccessfulCycle < Math.max(this.config.WORKER_POLL_MS * 5, this.config.WORKER_LEASE_MS);
  }
  processOne(): Promise<void> {
    return this.serialize(async () => {
      if (this.stopped) return;
      if (!this.recovered) { await this.reconcileInternal(); this.recovered = true; }
      const deployment = await this.repository.claimNext(this.owner, this.config.WORKER_LEASE_MS);
      this.lastSuccessfulCycle = Date.now();
      if (deployment) await this.deploy(deployment);
      this.lastSuccessfulCycle = Date.now();
    });
  }

  private async deploy(deployment: DeploymentRecord) {
    let leaseLost = false;
    let heartbeatStopped = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatInFlight: Promise<void> = Promise.resolve();
    const scheduleHeartbeat = () => {
      if (heartbeatStopped) return;
      heartbeatTimer = setTimeout(() => {
        heartbeatInFlight = (async () => {
          try {
            if (!(await this.repository.heartbeat(deployment.id, this.owner, this.config.WORKER_LEASE_MS))) leaseLost = true;
            this.lastSuccessfulCycle = Date.now();
          } catch { leaseLost = true; }
          if (!leaseLost) scheduleHeartbeat();
        })();
      }, Math.floor(this.config.WORKER_LEASE_MS / 3));
    };
    const stopHeartbeat = async () => {
      heartbeatStopped = true; clearTimeout(heartbeatTimer); await heartbeatInFlight;
    };
    const ensureCurrent = async () => {
      if (leaseLost) throw new Error("deployment lease lost");
      const current = await this.repository.getPreview(deployment.previewId);
      if (!current || current.requestedDeploymentId !== deployment.id || ["deleted", "deleting"].includes(current.status) ||
        (current.expiresAt && current.expiresAt <= new Date())) throw new Error("deployment superseded or cancelled");
    };
    scheduleHeartbeat();
    try {
      // Persisted jobs also cross the image/repository policy boundary on recovery.
      validateCreateRequest({ repository: deployment.repository, pullRequestNumber: deployment.pullRequestNumber,
        commitSha: deployment.commitSha, image: deployment.image, containerPort: deployment.containerPort, ttlHours: deployment.ttlHours }, this.config);
      await ensureCurrent();
      await this.runtime.pull(deployment.image);
      await ensureCurrent();
      if (!(await this.repository.setStarting(deployment.id, this.owner))) throw new Error("deployment lease lost");
      const container = await this.runtime.run({
        name: `preview-${deployment.id}`, image: deployment.image, previewId: deployment.previewId,
        network: this.config.TRAEFIK_NETWORK, memory: this.config.PREVIEW_MEMORY,
        cpus: this.config.PREVIEW_CPUS, pidsLimit: this.config.PREVIEW_PIDS_LIMIT,
      });
      const endpoint = await this.runtime.endpoint(container, deployment.containerPort);
      if (!(await this.runtime.healthCheck(endpoint, this.config.HEALTH_CHECK_PATH,
        this.config.HEALTH_CHECK_ATTEMPTS, this.config.HEALTH_CHECK_INTERVAL_MS))) throw new Error("preview health check failed");
      await ensureCurrent();
      const current = await this.repository.getPreview(deployment.previewId);
      await this.runtime.activate(deployment.previewId, `${current!.hostname}.${this.config.PREVIEW_BASE_DOMAIN}`, endpoint);
      await ensureCurrent();
      await stopHeartbeat();
      // A false result (including a concurrent supersession/delete) is terminal for this attempt.
      if (!(await this.repository.complete(deployment.id, this.owner, container.id,
        new Date(Date.now() + deployment.ttlHours * 3600000)))) throw new Error("deployment superseded or cancelled");
    } catch (error) {
      await stopHeartbeat();
      await this.repository.fail(deployment.id, this.owner,
        publicDeploymentError(error instanceof Error ? error.message : "deployment failed"));
    } finally { await stopHeartbeat(); }
    // DB is authoritative after both success and ambiguous commit failures. Restore its route
    // before removing any unreferenced candidate. If DB/routes are unavailable, retain containers.
    await this.reconcileInternal();
  }

  async removePreview(id: string) {
    if (!(await this.repository.requestDelete(id))) return false;
    await this.serialize(() => this.reconcileInternal());
    return true;
  }
  reconcile(): Promise<void> { return this.serialize(() => this.reconcileInternal()); }

  private async reconcileInternal() {
    await this.repository.expire(new Date());
    const previews = await this.repository.listActivePreviews();
    const managed = await this.runtime.listManaged();
    for (const preview of previews) {
      if (preview.status === "deleting") {
        await this.runtime.deactivate(preview.id);
        const containers = managed.filter(container => container.previewId === preview.id);
        if (preview.containerId && !containers.some(container => container.id === preview.containerId)) {
          containers.push({ id: preview.containerId, name: "", previewId: preview.id });
        }
        for (const container of containers) await this.runtime.remove(container);
        await this.repository.finishDelete(preview.id);
      } else if (preview.containerId) {
        // Never infer live ownership from names, status of the latest attempt, or short IDs.
        if (!preview.containerPort) throw new Error("runtime operation failed");
        try {
          const endpoint = await this.runtime.endpoint({ id: preview.containerId, name: "", previewId: preview.id }, preview.containerPort);
          await this.runtime.activate(preview.id, `${preview.hostname}.${this.config.PREVIEW_BASE_DOMAIN}`, endpoint);
          await this.repository.recordRuntimeState(preview.id, preview.containerId, "running");
        } catch (error) {
          if (!(error instanceof RuntimeUnavailableError)) throw error;
          await this.runtime.deactivate(preview.id);
          await this.repository.recordRuntimeState(preview.id, preview.containerId, error.state);
          // A lost/stopped container is local to this preview, not a reason to block every queued job.
        }
      } else {
        await this.runtime.deactivate(preview.id);
      }
    }
    const live = await this.repository.liveContainerIds();
    const activeIds = new Set((await this.repository.listActivePreviews()).map(preview => preview.id));
    for (const route of await this.runtime.listRoutes()) if (!activeIds.has(route)) await this.runtime.deactivate(route);
    for (const container of managed) if (!live.has(container.id)) await this.runtime.remove(container);
    const scope = this.config.ALLOWED_IMAGE_NAMESPACE;
    for (const image of await this.repository.unusedImages(scope)) {
      if (!validateImage(image, scope)) continue;
      try { await this.repository.collectImageIfUnused(scope, image, () => this.runtime.removeImage(image)); }
      catch { console.warn("Owned image cleanup deferred"); }
    }
    this.lastSuccessfulCycle = Date.now();
  }
}
