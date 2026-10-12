import { randomUUID } from "node:crypto";
import type { DeploymentRepository, DeploymentRecord, NewDeployment, PreviewRecord } from "../domain/types.js";
import { CapacityError, previewIdentity } from "../domain/validation.js";
import { publicDeploymentError } from "../domain/errors.js";

/** Test repository: mirrors transaction-level invariants of PostgresRepository. */
export class MemoryRepository implements DeploymentRepository {
  readonly deployments = new Map<string, DeploymentRecord>();
  readonly previews = new Map<string, PreviewRecord>();
  private imageGate: Promise<unknown> = Promise.resolve();
  private exclusive<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.imageGate.then(action);
    this.imageGate = result.catch(() => undefined);
    return result;
  }
  async health() { return true; }

  async createDeployment(input: NewDeployment, maximum: number) {
    return this.exclusive(() => {
      const previous = this.previews.get(input.previewId);
      if (previous?.status === "deleting") throw new CapacityError("preview cleanup in progress");
      const duplicate = [...this.deployments.values()].find(d =>
        d.id === previous?.requestedDeploymentId && d.previewId === input.previewId && d.commitSha === input.commitSha && d.image === input.image &&
        d.containerPort === input.containerPort && d.ttlHours === input.ttlHours &&
        ["queued", "pulling", "starting", "healthy"].includes(d.status) && (d.status !== "healthy" || previous?.health === "healthy") && previous?.status !== "deleted");
      if (duplicate) return structuredClone(duplicate);
      if ((!previous || previous.status === "deleted") && [...this.previews.values()].filter(p => p.status !== "deleted").length >= maximum) {
        throw new CapacityError("maximum active previews reached");
      }
      const now = new Date();
      const record: DeploymentRecord = { ...input, id: randomUUID(), status: "queued", createdAt: now, updatedAt: now };
      this.deployments.set(record.id, record);
      this.previews.set(input.previewId, {
        ...previous, id: input.previewId, repository: input.repository, pullRequestNumber: input.pullRequestNumber,
        pathPrefix: previewIdentity(input.repository, input.pullRequestNumber).pathPrefix,
        status: "queued", health: previous?.containerId ? previous.health : "unknown", requestedDeploymentId: record.id,
        deploymentId: previous?.containerId ? previous.deploymentId : undefined,
        commitSha: previous?.containerId ? previous.commitSha : undefined,
        image: previous?.containerId ? previous.image : undefined,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + input.ttlHours * 3600000),
      });
      return structuredClone(record);
    });
  }
  async getDeployment(id: string) { return structuredClone(this.deployments.get(id)); }
  async listActivePreviews() { return structuredClone([...this.previews.values()].filter(p => p.status !== "deleted")); }
  async getPreview(id: string) { return structuredClone(this.previews.get(id)); }
  async claimNext(owner: string, leaseMs: number) {
    const now = new Date();
    for (const d of this.deployments.values()) {
      if (["pulling", "starting"].includes(d.status) && d.leaseUntil && d.leaseUntil <= now) d.status = "queued";
    }
    if ([...this.deployments.values()].some(d => ["pulling", "starting"].includes(d.status))) return undefined;
    for (const d of this.deployments.values()) {
      if (d.status !== "queued") continue;
      const p = this.previews.get(d.previewId);
      if (!p || ["deleting", "deleted"].includes(p.status)) { d.status = "deleted"; continue; }
      d.status = "pulling"; d.leaseOwner = owner; d.leaseUntil = new Date(now.getTime() + leaseMs); d.updatedAt = now;
      return structuredClone(d);
    }
    return undefined;
  }
  async heartbeat(id: string, owner: string, leaseMs: number) {
    const d = this.deployments.get(id);
    if (!d || d.leaseOwner !== owner || !d.leaseUntil || d.leaseUntil <= new Date() || !["pulling", "starting"].includes(d.status)) return false;
    d.leaseUntil = new Date(Date.now() + leaseMs); return true;
  }
  async setStarting(id: string, owner: string) {
    const d = this.deployments.get(id);
    if (!d || d.leaseOwner !== owner || !d.leaseUntil || d.leaseUntil <= new Date() || d.status !== "pulling") return false;
    d.status = "starting"; d.updatedAt = new Date(); return true;
  }
  async complete(id: string, owner: string, containerId: string, expiresAt: Date) {
    const d = this.deployments.get(id);
    const p = d && this.previews.get(d.previewId);
    if (!d || !p || d.leaseOwner !== owner || !d.leaseUntil || d.leaseUntil <= new Date() || d.status !== "starting" || p.requestedDeploymentId !== id || ["deleted", "deleting"].includes(p.status)) return false;
    d.status = "healthy"; d.expiresAt = expiresAt; d.updatedAt = new Date(); d.leaseUntil = undefined;
    Object.assign(p, { status: "healthy", health: "healthy", runtimeState: "running", deploymentId: id,
      commitSha: d.commitSha, image: d.image, containerId, containerPort: d.containerPort, expiresAt, updatedAt: new Date() }); return true;
  }
  async fail(id: string, owner: string, message: string) {
    const d = this.deployments.get(id);
    if (!d || d.leaseOwner !== owner || !["pulling", "starting"].includes(d.status)) return;
    Object.assign(d, { status: "failed", error: publicDeploymentError(message), updatedAt: new Date(), leaseUntil: undefined });
    const p = this.previews.get(d.previewId);
    if (p?.requestedDeploymentId === id && !["deleted", "deleting"].includes(p.status)) {
      p.status = "failed"; p.health = p.containerId && p.runtimeState === "running" ? "healthy" : "unhealthy"; p.updatedAt = new Date();
    }
  }
  async requestDelete(id: string) {
    const p = this.previews.get(id);
    if (!p) return undefined;
    if (p.status !== "deleted") { p.status = "deleting"; p.updatedAt = new Date(); }
    for (const d of this.deployments.values()) if (d.previewId === id && d.status !== "deleted") d.status = "deleted";
    return structuredClone(p);
  }
  async finishDelete(id: string) {
    const p = this.previews.get(id);
    if (p?.status === "deleting") Object.assign(p, { status: "deleted", health: "unknown", runtimeState: "unknown",
      containerId: undefined, containerPort: undefined, deploymentId: undefined, commitSha: undefined, image: undefined, updatedAt: new Date() });
  }
  async expire(now: Date) {
    for (const p of this.previews.values()) if (p.status !== "deleted" && p.expiresAt && p.expiresAt <= now) await this.requestDelete(p.id);
  }
  async liveContainerIds() { return new Set([...this.previews.values()].flatMap(p => p.containerId && p.status !== "deleted" ? [p.containerId] : [])); }
  async recordRuntimeState(id: string, containerId: string, state: "running" | "missing" | "stopped") {
    const p = this.previews.get(id);
    if (!p || p.containerId !== containerId || ["deleted", "deleting"].includes(p.status)) return;
    p.runtimeState = state; p.health = state === "running" ? "healthy" : "unhealthy";
    if (state !== "running" && p.status === "healthy") p.status = "failed";
    p.updatedAt = new Date();
  }
  async unusedImages(repository: string) {
    const images = new Set([...this.deployments.values()].filter(d => d.repository === repository).map(d => d.image));
    for (const d of this.deployments.values()) if (["queued", "pulling", "starting"].includes(d.status)) images.delete(d.image);
    for (const p of this.previews.values()) if (p.status !== "deleted" && p.image) images.delete(p.image);
    return [...images];
  }
  async collectImageIfUnused(repository: string, image: string, collect: () => Promise<void>) {
    await this.exclusive(async () => { if ((await this.unusedImages(repository)).includes(image)) await collect(); });
  }
}
