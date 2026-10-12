import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** JSON is valid YAML. Traefik watches the directory, never a single bind-mounted file. */
export class FileRoutes {
  constructor(private readonly directory: string) {}
  private path(id: string) {
    if (!/^[a-z0-9-]{1,100}$/.test(id)) throw new Error("route operation failed");
    return join(this.directory, `preview-${id}.yml`);
  }
  async activate(id: string, hostname: string, endpoint: string) {
    const destination = this.path(id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true });
      if (!/^[a-z0-9.-]+$/.test(hostname) || !/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(endpoint)) throw new Error();
      const key = `preview-${id}`;
      await writeFile(temporary, JSON.stringify({ http: {
        routers: { [key]: { rule: `Host(\`${hostname}\`)`, entryPoints: ["web"], service: key } },
        services: { [key]: { loadBalancer: { servers: [{ url: endpoint }] } } },
      } }), { flag: "wx", mode: 0o644 });
      await rename(temporary, destination);
    } catch { throw new Error("route operation failed"); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  async deactivate(id: string) {
    try { await unlink(this.path(id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("route operation failed"); }
  }
  async list() {
    try {
      return (await readdir(this.directory)).flatMap(name => {
        const match = /^preview-([a-z0-9-]+)\.yml$/.exec(name);
        return match ? [match[1]!] : [];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("route operation failed");
    }
  }
}
