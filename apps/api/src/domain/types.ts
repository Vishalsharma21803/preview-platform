import type { DeploymentResponse, DeploymentStatus, PreviewResponse } from "@preview/contracts";
import type { Config } from "../config/config.js";
import { previewUrl } from "./validation.js";
import { publicDeploymentError } from "./errors.js";

export interface DeploymentRecord {
  id: string;
  previewId: string;
  repository: string;
  pullRequestNumber: number;
  commitSha: string;
  image: string;
  containerPort: number;
  ttlHours: number;
  status: DeploymentStatus;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
}

export interface PreviewRecord {
  id: string;
  repository: string;
  pullRequestNumber: number;
  pathPrefix: string;
  status: DeploymentStatus;
  health: "unknown" | "healthy" | "unhealthy";
  deploymentId?: string;
  requestedDeploymentId?: string;
  runtimeState?: "unknown" | "running" | "missing" | "stopped";
  containerId?: string;
  containerPort?: number;
  commitSha?: string;
  image?: string;
  expiresAt?: Date;
  updatedAt: Date;
}

export type NewDeployment = Pick<DeploymentRecord, "previewId" | "repository" | "pullRequestNumber" | "commitSha" | "image" | "containerPort" | "ttlHours">;

export interface DeploymentRepository {
  health(): Promise<boolean>;
  createDeployment(input: NewDeployment, maximum: number): Promise<DeploymentRecord>;
  getDeployment(id: string): Promise<DeploymentRecord | undefined>;
  listActivePreviews(): Promise<PreviewRecord[]>;
  getPreview(id: string): Promise<PreviewRecord | undefined>;
  claimNext(owner: string, leaseMs: number): Promise<DeploymentRecord | undefined>;
  heartbeat(id: string, owner: string, leaseMs: number): Promise<boolean>;
  setStarting(id: string, owner: string): Promise<boolean>;
  complete(id: string, owner: string, containerId: string, expiresAt: Date): Promise<boolean>;
  fail(id: string, owner: string, message: string): Promise<void>;
  requestDelete(id: string): Promise<PreviewRecord | undefined>;
  finishDelete(id: string): Promise<void>;
  expire(now: Date): Promise<void>;
  liveContainerIds(): Promise<Set<string>>;
  recordRuntimeState(id: string, containerId: string, state: "running" | "missing" | "stopped"): Promise<void>;
  unusedImages(repository: string): Promise<string[]>;
  collectImageIfUnused(repository: string, image: string, collect: () => Promise<void>): Promise<void>;
}

export function deploymentToResponse(record: DeploymentRecord, url: string): DeploymentResponse {
  return {
    id: record.id, previewId: record.previewId, status: record.status,
    repository: record.repository, pullRequestNumber: record.pullRequestNumber,
    commitSha: record.commitSha, image: record.image, previewUrl: url,
    ...(record.error ? { error: publicDeploymentError(record.error) } : {}),
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
    ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
  };
}

export function previewToResponse(record: PreviewRecord, config: Config): PreviewResponse {
  return {
    id: record.id, repository: record.repository, pullRequestNumber: record.pullRequestNumber,
    path: record.pathPrefix, previewUrl: previewUrl(record.pathPrefix, config),
    status: record.status, health: record.health,
    ...(record.deploymentId ? { deploymentId: record.deploymentId } : {}),
    ...(record.commitSha ? { commitSha: record.commitSha } : {}),
    ...(record.image ? { image: record.image } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
    updatedAt: record.updatedAt.toISOString(),
  };
}
