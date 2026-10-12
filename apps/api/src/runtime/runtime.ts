import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIPv4 } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../config/config.js";
import { FileRoutes } from "./routes.js";
import { validateImage } from "../domain/validation.js";
const exec = promisify(execFile);

export interface RuntimeContainer { id: string; name: string; previewId: string; }
export class RuntimeUnavailableError extends Error {
  constructor(readonly state: "missing" | "stopped") { super(`runtime container ${state}`); }
}
export interface RuntimeOptions {
  name: string; image: string; previewId: string;
  network: string; memory: string; cpus: number; pidsLimit: number;
}
export interface RuntimeAdapter {
  pull(image: string): Promise<void>;
  run(options: RuntimeOptions): Promise<RuntimeContainer>;
  endpoint(container: RuntimeContainer, port: number): Promise<string>;
  healthCheck(endpoint: string, path: string, attempts: number, intervalMs: number): Promise<boolean>;
  remove(container: RuntimeContainer): Promise<void>;
  listManaged(): Promise<RuntimeContainer[]>;
  activate(previewId: string, hostname: string, endpoint: string): Promise<void>;
  deactivate(previewId: string): Promise<void>;
  listRoutes(): Promise<string[]>;
  removeImage(image: string): Promise<void>;
}

export type DockerCommand = (args: string[], timeoutMs: number) => Promise<string>;

/** No shell, published ports, image-side tools, or caller-supplied Docker flags. */
export class DockerRuntime implements RuntimeAdapter {
  private readonly routes: FileRoutes;
  constructor(private readonly config: Config, private readonly execute: DockerCommand = async (args, timeout) => {
    const result = await exec("docker", args, { maxBuffer: 1024 * 1024, timeout, killSignal: "SIGKILL" });
    return result.stdout.trim();
  }) { this.routes = new FileRoutes(config.ROUTES_DIR); }

  private command(args: string[], timeout = this.config.DOCKER_COMMAND_TIMEOUT_MS) {
    return this.execute(args, timeout);
  }
  async pull(image: string) {
    try { await this.command(["pull", image], this.config.DOCKER_PULL_TIMEOUT_MS); }
    catch { throw new Error("image pull failed"); }
  }
  async run(options: RuntimeOptions) {
    // --read-only does not prohibit writable anonymous volumes declared in an image.
    const image = await this.inspectImage(options.image);
    if (!image) throw new Error("runtime operation failed");
    if (Object.keys(image.Config.Volumes ?? {}).length) throw new Error("image declares volumes");
    try {
      const id = await this.command(["run", "-d", "--name", options.name, "--network", options.network,
        "--memory", options.memory, "--memory-swap", options.memory, "--cpus", String(options.cpus),
        "--pids-limit", String(options.pidsLimit), "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--restart", "no",
        "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=2",
        "--label", "preview.platform=managed", "--label", `preview.repository=${this.config.ALLOWED_IMAGE_NAMESPACE}`,
        "--label", `preview.id=${options.previewId}`, "--label", "traefik.enable=false", options.image]);
      return { id, name: options.name, previewId: options.previewId };
    } catch { throw new Error("runtime operation failed"); }
  }
  async endpoint(container: RuntimeContainer, port: number) {
    try {
      let output: string;
      try { output = await this.command(["container", "inspect", container.id]); }
      catch (error) {
        if (this.isMissing(error, "container")) throw new RuntimeUnavailableError("missing");
        throw error;
      }
      const data: unknown = JSON.parse(output);
      const entries = data as { State?: { Running?: boolean }; NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }[];
      const entry = entries[0];
      const ip = entry?.NetworkSettings?.Networks?.[this.config.TRAEFIK_NETWORK]?.IPAddress;
      if (entry?.State?.Running === false) throw new RuntimeUnavailableError("stopped");
      if (!entry?.State?.Running || !ip || !isIPv4(ip) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
      return `http://${ip}:${port}`;
    } catch (error) {
      if (error instanceof RuntimeUnavailableError) throw error;
      throw new Error("runtime operation failed");
    }
  }
  async healthCheck(endpoint: string, path: string, attempts: number, intervalMs: number) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(`${endpoint}${path}`, {
          redirect: "manual", signal: AbortSignal.timeout(this.config.HEALTH_CHECK_TIMEOUT_MS),
        });
        await response.body?.cancel();
        if (response.ok) return true;
      } catch { /* bounded retries; no response bodies or Docker output reach public state */ }
      if (attempt + 1 < attempts) await delay(intervalMs);
    }
    return false;
  }
  async remove(container: RuntimeContainer) {
    try { await this.command(["rm", "-f", container.id]); }
    catch (error) {
      // Missing container is the only benign rm failure. Daemon/access/timeouts must be retried.
      const stderr = (error as { stderr?: unknown }).stderr;
      if (typeof stderr === "string" && /^Error response from daemon: No such container: [^\r\n]+\s*$/.test(stderr)) return;
      throw new Error("runtime operation failed");
    }
  }
  async listManaged() {
    try {
      const output = await this.command(["ps", "-a", "--no-trunc", "--filter", "label=preview.platform=managed",
        "--filter", `label=preview.repository=${this.config.ALLOWED_IMAGE_NAMESPACE}`,
        "--format", '{{.ID}}\t{{.Names}}\t{{.Label "preview.id"}}']);
      return output ? output.split("\n").map(line => {
        const [id, name, previewId = ""] = line.split("\t");
        if (!id || !name) throw new Error();
        return { id, name, previewId };
      }) : [];
    } catch { throw new Error("runtime operation failed"); }
  }
  activate(previewId: string, hostname: string, endpoint: string) { return this.routes.activate(previewId, hostname, endpoint); }
  deactivate(previewId: string) { return this.routes.deactivate(previewId); }
  listRoutes() { return this.routes.list(); }
  private isMissing(error: unknown, kind: "image" | "container") {
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    return typeof stderr === "string" && new RegExp(`^(?:Error response from daemon:|Error:) No such ${kind}: [^\\r\\n]+\\s*$`).test(stderr);
  }
  private async inspectImage(reference: string): Promise<{ Id: string; RepoDigests: string[]; RepoTags: string[]; Config: { Volumes?: Record<string, unknown> | null } } | undefined> {
    try {
      const image = JSON.parse(await this.command(["image", "inspect", reference]))[0];
      if (typeof image?.Id !== "string" || !image.Config || !Array.isArray(image.RepoDigests) || !Array.isArray(image.RepoTags)) throw new Error();
      return image;
    } catch (error) {
      if (this.isMissing(error, "image")) return undefined;
      throw new Error("runtime operation failed");
    }
  }
  async removeImage(reference: string) {
    if (!validateImage(reference, this.config.ALLOWED_IMAGE_NAMESPACE)) return;
    const image = await this.inspectImage(reference);
    if (!image || !image.RepoDigests.includes(reference)) return;
    // Docker may also untag aliases when removing a digest. Keep shared/tagged images untouched.
    // Docker's containerd image store may also list the digest itself in RepoTags.
    if (image.RepoTags.some(tag => tag !== reference) || image.RepoDigests.some(digest => digest !== reference)) return;
    // Inspect ALL containers, including unrelated and stopped ones; tags alone do not identify use.
    const ids = (await this.command(["ps", "-a", "--no-trunc", "--format", "{{.ID}}"])).split("\n").filter(Boolean);
    if (ids.length) {
      const usedImageIds = (await this.command(["container", "inspect", "--format", "{{.Image}}", ...ids])).split("\n");
      if (usedImageIds.includes(image.Id)) return;
    }
    try {
      // Delete only the exact owned digest reference. Never force, remove by ID, or globally prune.
      await this.command(["image", "rm", "--no-prune", reference]);
    } catch (error) {
      if (this.isMissing(error, "image")) return;
      // Docker's non-forced removal is the final guard against a concurrent external container create.
      throw new Error("image cleanup failed");
    }
  }
}
