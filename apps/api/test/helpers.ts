import { loadConfig } from "../src/config/config.js";
import { MemoryRepository } from "../src/db/memory-repository.js";
import { previewIdentity, validateCreateRequest } from "../src/domain/validation.js";
import { RuntimeUnavailableError, type RuntimeAdapter, type RuntimeContainer, type RuntimeOptions } from "../src/runtime/runtime.js";

export const config = loadConfig({
  DATABASE_URL: "postgres://preview:preview@localhost:5432/preview_platform",
  DEPLOYMENT_TOKEN: "test-token-1234567890123456", ALLOWED_IMAGE_NAMESPACE: "acme/frontend",
  ROUTES_DIR: "/tmp/omnirush/preview-test-routes", HEALTH_CHECK_TIMEOUT_MS: "100",
});
export const body = {
  repository: "acme/frontend", pullRequestNumber: 3, commitSha: "a".repeat(40),
  image: `ghcr.io/acme/frontend/app@sha256:${"b".repeat(64)}`,
};
export function queue(repo: MemoryRepository, overrides: Partial<typeof body> = {}) {
  const request = validateCreateRequest({ ...body, ...overrides }, config);
  return repo.createDeployment({ ...request, previewId: previewIdentity(request.repository, request.pullRequestNumber).id }, 10);
}
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export class FakeRuntime implements RuntimeAdapter {
  readonly containers = new Map<string, RuntimeContainer>();
  readonly routes = new Map<string, string>();
  readonly events: string[] = [];
  readonly stopped = new Set<string>();
  readonly removedImages: string[] = [];
  healthy = true;
  pullHook = async () => {};
  healthHook = async () => {};
  activateHook = async () => {};
  removeHook = async () => {};
  async pull(_image: string) { this.events.push("pull"); await this.pullHook(); }
  async run(options: RuntimeOptions) {
    const container = { id: options.name.replace("preview-", "").replaceAll("-", "").padEnd(64, "0"), name: options.name, previewId: options.previewId };
    this.events.push(`run:${container.id}`); this.containers.set(container.id, container); return container;
  }
  async endpoint(container: RuntimeContainer, port: number) {
    if (!this.containers.has(container.id)) throw new RuntimeUnavailableError("missing");
    if (this.stopped.has(container.id)) throw new RuntimeUnavailableError("stopped");
    return `http://172.18.0.${[...this.containers.keys()].indexOf(container.id) + 2}:${port}`;
  }
  async healthCheck(_endpoint: string, _path: string, _attempts: number, _interval: number) {
    this.events.push("health"); await this.healthHook(); return this.healthy;
  }
  async remove(container: RuntimeContainer) {
    await this.removeHook(); this.events.push(`remove:${container.id}`); this.containers.delete(container.id);
  }
  async listManaged() { return [...this.containers.values()]; }
  async activate(id: string, _host: string, endpoint: string) {
    this.events.push(`activate:${endpoint}`); this.routes.set(id, endpoint); await this.activateHook();
  }
  async deactivate(id: string) { this.events.push(`deactivate:${id}`); this.routes.delete(id); }
  async listRoutes() { return [...this.routes.keys()]; }
  async removeImage(image: string) { this.removedImages.push(image); }
}
