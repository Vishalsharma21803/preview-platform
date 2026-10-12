import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config/config.js";

const requestSchema = z.object({
  repository: z.string().max(200).regex(/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/).transform(value => value.toLowerCase()),
  pullRequestNumber: z.number().int().min(1).max(2147483647),
  commitSha: z.string().regex(/^[A-Fa-f0-9]{40}$/).transform(value => value.toLowerCase()),
  image: z.string().max(512),
  containerPort: z.number().int().min(1).max(65535).default(3000),
  ttlHours: z.number().positive().optional(),
}).strict();

export class RequestError extends Error {}
export class CapacityError extends Error {}

export function validateImage(image: string, namespace: string): boolean {
  const match = /^ghcr\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)@sha256:[a-f0-9]{64}$/.exec(image);
  return !!match && (match[1] === namespace || match[1]!.startsWith(`${namespace}/`));
}

export function validateCreateRequest(value: unknown, config: Config) {
  const result = requestSchema.safeParse(value);
  if (!result.success) throw new RequestError(`Invalid request fields: ${result.error.issues.map(issue => issue.path.join(".") || "body").join(", ")}`);
  const parsed = result.data;
  if (parsed.repository !== config.ALLOWED_IMAGE_NAMESPACE) throw new RequestError("repository must match the configured owner/repository scope");
  if (!validateImage(parsed.image, config.ALLOWED_IMAGE_NAMESPACE)) throw new RequestError("image must be a digest-pinned GHCR image in the approved namespace");
  const ttlHours = parsed.ttlHours ?? config.DEFAULT_TTL_HOURS;
  if (ttlHours > config.MAX_TTL_HOURS) throw new RequestError(`ttlHours cannot exceed ${config.MAX_TTL_HOURS}`);
  return { ...parsed, ttlHours };
}

export function previewIdentity(repository: string, pullRequestNumber: number) {
  const normalized = repository.toLowerCase();
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  const safe = normalized.replace(/[^a-z0-9]+/g, "-").slice(0, 32).replace(/-$/, "");
  const id = `${safe}-${hash}-pr-${pullRequestNumber}`;
  return { id, hostname: id, containerName: `preview-${id}` };
}

export function previewUrl(hostname: string, config: Pick<Config, "PREVIEW_SCHEME" | "PREVIEW_BASE_DOMAIN" | "PREVIEW_PORT">) {
  return `${config.PREVIEW_SCHEME}://${hostname}.${config.PREVIEW_BASE_DOMAIN}${config.PREVIEW_PORT ? `:${config.PREVIEW_PORT}` : ""}`;
}
