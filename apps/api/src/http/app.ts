import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Config } from "../config/config.js";
import { CapacityError, RequestError, previewIdentity, previewUrl, validateCreateRequest } from "../domain/validation.js";
import { deploymentToResponse, previewToResponse, type DeploymentRepository } from "../domain/types.js";
import { bearerAuth } from "./auth.js";
import type { DeploymentWorker } from "../worker/worker.js";

export function createApp(deps: { config: Config; repository: DeploymentRepository; worker: DeploymentWorker }): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb", strict: true }));
  const param = (value: string | string[] | undefined): string => Array.isArray(value) ? value[0] ?? "" : value ?? "";
  let windowStart = Date.now(); let mutationCount = 0;
  const mutationRateLimit: express.RequestHandler = (_req, res, next) => {
    if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); mutationCount = 0; }
    mutationCount += 1;
    if (mutationCount > deps.config.MUTATION_RATE_LIMIT) return res.status(429).json({ error: "mutation rate limit exceeded" });
    next();
  };
  const auth: express.RequestHandler[] = [mutationRateLimit, bearerAuth(deps.config.DEPLOYMENT_TOKEN)];
  app.get("/healthz", async (_req, res) => {
    const database = await deps.repository.health(); const worker = deps.worker.isHealthy();
    res.status(database && worker ? 200 : 503).json({ status: database && worker ? "ok" : "degraded", database: database ? "ok" : "down", worker: worker ? "ok" : "down" });
  });
  app.get("/api/previews", async (_req, res, next) => { try { res.json((await deps.repository.listActivePreviews()).map(p => previewToResponse(p, deps.config))); } catch (e) { next(e); } });
  app.get("/api/previews/:previewId", async (req, res, next) => { try { const p = await deps.repository.getPreview(param(req.params.previewId)); if (!p || p.status === "deleted") return res.status(404).json({ error: "preview not found" }); res.json(previewToResponse(p, deps.config)); } catch (e) { next(e); } });
  app.get("/api/deployments/:deploymentId", async (req, res, next) => {
    const id = param(req.params.deploymentId);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
      return res.status(400).json({ error: "invalid deployment ID" });
    }
    try {
      const d = await deps.repository.getDeployment(id);
      if (!d) return res.status(404).json({ error: "deployment not found" });
      const identity = previewIdentity(d.repository, d.pullRequestNumber);
      return res.json(deploymentToResponse(d, previewUrl(identity.hostname, deps.config)));
    } catch (error) { next(error); }
  });
  app.post("/api/deployments", auth, async (req: Request, res: Response, next: NextFunction) => {
    try { const input = validateCreateRequest(req.body, deps.config); const identity = previewIdentity(input.repository, input.pullRequestNumber); const d = await deps.repository.createDeployment({ ...input, previewId: identity.id, containerPort: input.containerPort, ttlHours: input.ttlHours }, deps.config.MAX_ACTIVE_PREVIEWS); res.status(202).json(deploymentToResponse(d, previewUrl(identity.hostname, deps.config))); }
    catch (e) { if (e instanceof CapacityError) return res.status(429).json({ error: e.message }); if (e instanceof RequestError || e instanceof SyntaxError) return res.status(400).json({ error: e.message }); next(e); }
  });
  app.delete("/api/previews/:previewId", auth, async (req: Request, res: Response, next: NextFunction) => { try { const id = param(req.params.previewId); if (!(await deps.worker.removePreview(id))) return res.status(404).json({ error: "preview not found" }); res.status(202).json({ id, status: "deleted" }); } catch (e) { next(e); } });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const tooLarge = (error as { type?: string } | null)?.type === "entity.too.large";
    const status = tooLarge ? 413 : error instanceof SyntaxError ? 400 : 500;
    return res.status(status).json({ error: tooLarge ? "request body too large" : status === 400 ? "invalid JSON body" : "internal server error" });
  });
  return app;
}
