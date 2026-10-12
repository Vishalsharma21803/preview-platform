import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().url().refine(value => /^postgres(ql)?:/.test(value)),
  DEPLOYMENT_TOKEN: z.string().min(24).max(512),
  ALLOWED_IMAGE_NAMESPACE: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  ROUTES_DIR: z.string().startsWith("/").min(2),
  WORKER_LEASE_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  DOCKER_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  DOCKER_PULL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(1800000).default(300000),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(2000),
  PREVIEW_BASE_DOMAIN: z.string().max(190).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/).default("preview.localhost"),
  PREVIEW_SCHEME: z.enum(["http", "https"]).default("http"),
  PREVIEW_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  TRAEFIK_NETWORK: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/).default("traefik-public"),
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  MAX_ACTIVE_PREVIEWS: z.coerce.number().int().min(1).max(100).default(10),
  DEFAULT_TTL_HOURS: z.coerce.number().positive().max(168).default(24),
  MAX_TTL_HOURS: z.coerce.number().positive().max(168).default(168),
  PREVIEW_MEMORY: z.string().regex(/^(?:[6-9][4-9]|[1-9][0-9]{2,3})m$/).default("256m"),
  PREVIEW_CPUS: z.coerce.number().min(0.1).max(4).default(0.5),
  PREVIEW_PIDS_LIMIT: z.coerce.number().int().min(16).max(1024).default(128),
  HEALTH_CHECK_PATH: z.string().regex(/^\/[a-zA-Z0-9/_-]*$/).default("/healthz"),
  HEALTH_CHECK_ATTEMPTS: z.coerce.number().int().min(1).max(60).default(20),
  HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().min(10).max(5000).default(1000),
  MUTATION_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(30),
}).refine(config => config.DEFAULT_TTL_HOURS <= config.MAX_TTL_HOURS, {
  message: "DEFAULT_TTL_HOURS must not exceed MAX_TTL_HOURS",
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  // Never include environment values (especially the bearer token) in errors.
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(issue => issue.path.join(".") || "TTL settings").join(", ")}`);
  return result.data;
}
