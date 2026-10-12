export const deploymentStatuses = ["queued", "pulling", "starting", "healthy", "failed", "deleting", "deleted"] as const;
export type DeploymentStatus = (typeof deploymentStatuses)[number];

export interface CreateDeploymentRequest {
  /** Must match the API's ALLOWED_IMAGE_NAMESPACE (one owner/repository). */
  repository: string;
  pullRequestNumber: number;
  commitSha: string;
  /** Immutable ghcr.io/<configured owner/repository>[/path]@sha256:<64 hex> reference. */
  image: string;
  containerPort?: number;
  ttlHours?: number;
}

export interface DeploymentResponse {
  id: string;
  previewId: string;
  status: DeploymentStatus;
  repository: string;
  pullRequestNumber: number;
  commitSha: string;
  image: string;
  previewUrl: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface PreviewResponse {
  id: string;
  repository: string;
  pullRequestNumber: number;
  hostname: string;
  previewUrl: string;
  deploymentId?: string;
  status: DeploymentStatus;
  health: "unknown" | "healthy" | "unhealthy";
  commitSha?: string;
  image?: string;
  expiresAt?: string;
  updatedAt: string;
}

export interface HealthResponse { status: "ok" | "degraded"; database: "ok" | "down"; worker: "ok" | "down"; }
