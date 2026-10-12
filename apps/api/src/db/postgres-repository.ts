import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { DeploymentRepository, DeploymentRecord, NewDeployment, PreviewRecord } from "../domain/types.js";
import { CapacityError, previewIdentity } from "../domain/validation.js";
import { publicDeploymentError } from "../domain/errors.js";

type Row = Record<string, unknown>;
function date(value: unknown) { return value instanceof Date ? value : new Date(String(value)); }
function deployment(row: Row): DeploymentRecord {
  return {
    id: String(row.id), previewId: String(row.preview_id), repository: String(row.repository),
    pullRequestNumber: Number(row.pull_request_number), commitSha: String(row.commit_sha), image: String(row.image),
    containerPort: Number(row.container_port), ttlHours: Number(row.ttl_hours), status: row.status as DeploymentRecord["status"],
    ...(row.error ? { error: String(row.error) } : {}), createdAt: date(row.created_at), updatedAt: date(row.updated_at),
    ...(row.expires_at ? { expiresAt: date(row.expires_at) } : {}),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_until ? { leaseUntil: date(row.lease_until) } : {}),
  };
}
function preview(row: Row): PreviewRecord {
  return {
    id: String(row.id), repository: String(row.repository), pullRequestNumber: Number(row.pull_request_number),
    pathPrefix: String(row.path_prefix), status: row.status as PreviewRecord["status"], health: row.health as PreviewRecord["health"],
    ...(row.deployment_id ? { deploymentId: String(row.deployment_id) } : {}),
    ...(row.requested_deployment_id ? { requestedDeploymentId: String(row.requested_deployment_id) } : {}),
    runtimeState: row.runtime_state as PreviewRecord["runtimeState"],
    ...(row.container_id ? { containerId: String(row.container_id) } : {}),
    ...(row.container_port ? { containerPort: Number(row.container_port) } : {}),
    ...(row.commit_sha ? { commitSha: String(row.commit_sha) } : {}), ...(row.image ? { image: String(row.image) } : {}),
    ...(row.expires_at ? { expiresAt: date(row.expires_at) } : {}), updatedAt: date(row.updated_at),
  };
}

// One transaction lock serializes capacity reservations, lifecycle changes and queue claims.
// Runtime operations happen outside the transaction under a renewable deployment lease.
export class PostgresRepository implements DeploymentRepository {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(7312601)");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async health() { try { await this.pool.query("SELECT 1 FROM previews LIMIT 1"); return true; } catch { return false; } }
  async createDeployment(input: NewDeployment, maximum: number) {
    return this.transaction(async client => {
      const current = (await client.query("SELECT * FROM previews WHERE id=$1 FOR UPDATE", [input.previewId])).rows[0];
      if (current?.status === "deleting") throw new CapacityError("preview cleanup in progress");
      if (current && current.status !== "deleted") {
        const duplicate = await client.query(`SELECT * FROM deployments WHERE preview_id=$1 AND commit_sha=$2 AND image=$3 AND id=$6
          AND container_port=$4 AND ttl_hours=$5 AND status IN ('queued','pulling','starting','healthy')
          AND (status<>'healthy' OR $7='healthy') ORDER BY created_at DESC LIMIT 1`,
        [input.previewId, input.commitSha, input.image, input.containerPort, input.ttlHours, current.requested_deployment_id, current.health]);
        if (duplicate.rows[0]) return deployment(duplicate.rows[0]);
      }
      if (!current || current.status === "deleted") {
        const count = await client.query("SELECT COUNT(*)::int AS count FROM previews WHERE status <> 'deleted'");
        if (count.rows[0].count >= maximum) throw new CapacityError("maximum active previews reached");
      }
      const id = randomUUID();
      const inserted = await client.query(`INSERT INTO deployments
        (id,preview_id,repository,pull_request_number,commit_sha,image,container_port,ttl_hours)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, input.previewId, input.repository, input.pullRequestNumber, input.commitSha, input.image, input.containerPort, input.ttlHours]);
      await client.query(`INSERT INTO previews (id,repository,pull_request_number,path_prefix,status,health,requested_deployment_id,expires_at)
        VALUES ($1,$2,$3,$4,'queued','unknown',$5,NOW()+$6::double precision*INTERVAL '1 hour')
        ON CONFLICT (id) DO UPDATE SET status='queued', health=CASE WHEN previews.container_id IS NULL THEN 'unknown' ELSE previews.health END,
        deployment_id=CASE WHEN previews.container_id IS NULL THEN NULL ELSE previews.deployment_id END,
        commit_sha=CASE WHEN previews.container_id IS NULL THEN NULL ELSE previews.commit_sha END,
        image=CASE WHEN previews.container_id IS NULL THEN NULL ELSE previews.image END,
        requested_deployment_id=EXCLUDED.requested_deployment_id,expires_at=EXCLUDED.expires_at,updated_at=NOW()`,
      [input.previewId, input.repository, input.pullRequestNumber, previewIdentity(input.repository, input.pullRequestNumber).pathPrefix,
        id, input.ttlHours]);
      return deployment(inserted.rows[0]);
    });
  }
  async getDeployment(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM deployments WHERE id=$1", [id]);
    return rows[0] ? deployment(rows[0]) : undefined;
  }
  async listActivePreviews() {
    const { rows } = await this.pool.query("SELECT * FROM previews WHERE status <> 'deleted' ORDER BY updated_at DESC");
    return rows.map(preview);
  }
  async getPreview(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM previews WHERE id=$1", [id]);
    return rows[0] ? preview(rows[0]) : undefined;
  }
  async claimNext(owner: string, leaseMs: number) {
    return this.transaction(async client => {
      await client.query("UPDATE deployments SET status='queued',lease_owner=NULL,lease_until=NULL WHERE status IN ('pulling','starting') AND lease_until < NOW()");
      await client.query(`UPDATE deployments d SET status='deleted' FROM previews p
        WHERE d.preview_id=p.id AND d.status='queued' AND p.status IN ('deleted','deleting')`);
      const busy = await client.query("SELECT 1 FROM deployments WHERE status IN ('pulling','starting') LIMIT 1");
      if (busy.rowCount) return undefined;
      const result = await client.query(`UPDATE deployments SET status='pulling',lease_owner=$1,lease_until=NOW()+$2::double precision*INTERVAL '1 millisecond',updated_at=NOW()
        WHERE id=(SELECT id FROM deployments WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [owner, leaseMs]);
      return result.rows[0] ? deployment(result.rows[0]) : undefined;
    });
  }
  async heartbeat(id: string, owner: string, leaseMs: number) {
    const result = await this.pool.query(`UPDATE deployments SET lease_until=NOW()+$3::double precision*INTERVAL '1 millisecond'
      WHERE id=$1 AND lease_owner=$2 AND status IN ('pulling','starting') AND lease_until > NOW()`, [id, owner, leaseMs]);
    return result.rowCount === 1;
  }
  async setStarting(id: string, owner: string) {
    const result = await this.pool.query("UPDATE deployments SET status='starting',updated_at=NOW() WHERE id=$1 AND lease_owner=$2 AND status='pulling' AND lease_until>NOW()", [id, owner]);
    return result.rowCount === 1;
  }
  async complete(id: string, owner: string, containerId: string, expiresAt: Date) {
    return this.transaction(async client => {
      const updated = await client.query(`UPDATE deployments d SET status='healthy',expires_at=$3,updated_at=NOW(),lease_until=NULL
        FROM previews p WHERE d.id=$1 AND d.lease_owner=$2 AND d.status='starting' AND d.lease_until>NOW()
        AND p.id=d.preview_id AND p.requested_deployment_id=d.id AND p.status NOT IN ('deleted','deleting') RETURNING d.*`, [id, owner, expiresAt]);
      if (!updated.rowCount) return false;
      const serving = updated.rows[0];
      await client.query(`UPDATE previews SET status='healthy',health='healthy',runtime_state='running',container_id=$2,expires_at=$3,
        container_port=$4,deployment_id=$1,commit_sha=$5,image=$6,updated_at=NOW() WHERE requested_deployment_id=$1`,
      [id, containerId, expiresAt, serving.container_port, serving.commit_sha, serving.image]);
      return true;
    });
  }
  async fail(id: string, owner: string, message: string) {
    await this.transaction(async client => {
      const result = await client.query(`UPDATE deployments SET status='failed',error=$3,updated_at=NOW(),lease_until=NULL
        WHERE id=$1 AND lease_owner=$2 AND status IN ('pulling','starting') RETURNING id`, [id, owner, publicDeploymentError(message)]);
      if (result.rowCount) await client.query(`UPDATE previews SET status='failed',health=CASE WHEN container_id IS NOT NULL AND runtime_state='running' THEN 'healthy' ELSE 'unhealthy' END,updated_at=NOW()
        WHERE requested_deployment_id=$1 AND status NOT IN ('deleted','deleting')`, [id]);
    });
  }
  async requestDelete(id: string) {
    return this.transaction(async client => {
      const found = await client.query("SELECT * FROM previews WHERE id=$1 FOR UPDATE", [id]);
      if (!found.rows[0]) return undefined;
      await client.query("UPDATE deployments SET status='deleted',lease_until=NULL,updated_at=NOW() WHERE preview_id=$1", [id]);
      const result = await client.query("UPDATE previews SET status=CASE WHEN status='deleted' THEN status ELSE 'deleting'::deployment_status END,updated_at=NOW() WHERE id=$1 RETURNING *", [id]);
      return preview(result.rows[0]);
    });
  }
  async finishDelete(id: string) {
    await this.pool.query(`UPDATE previews SET status='deleted',health='unknown',runtime_state='unknown',container_id=NULL,container_port=NULL,
      deployment_id=NULL,commit_sha=NULL,image=NULL,updated_at=NOW() WHERE id=$1 AND status='deleting'`, [id]);
  }
  async expire(now: Date) {
    await this.transaction(async client => {
      const expired = await client.query("UPDATE previews SET status='deleting',updated_at=NOW() WHERE expires_at <= $1 AND status NOT IN ('deleted','deleting') RETURNING id", [now]);
      if (expired.rows.length) await client.query("UPDATE deployments SET status='deleted',lease_until=NULL,updated_at=NOW() WHERE preview_id=ANY($1::text[])", [expired.rows.map(row => row.id)]);
    });
  }
  async liveContainerIds() {
    const result = await this.pool.query("SELECT container_id FROM previews WHERE container_id IS NOT NULL AND status <> 'deleted'");
    return new Set<string>(result.rows.map(row => String(row.container_id)));
  }
  async recordRuntimeState(id: string, containerId: string, state: "running" | "missing" | "stopped") {
    await this.pool.query(`UPDATE previews SET runtime_state=$3,health=CASE WHEN $3='running' THEN 'healthy' ELSE 'unhealthy' END,
      status=CASE WHEN $3<>'running' AND status='healthy' THEN 'failed'::deployment_status ELSE status END,updated_at=NOW()
      WHERE id=$1 AND container_id=$2 AND status NOT IN ('deleted','deleting')`, [id, containerId, state]);
  }
  private readonly unusedImageSql = `SELECT DISTINCT owned.image FROM deployments owned WHERE owned.repository=$1
    AND NOT EXISTS (SELECT 1 FROM deployments pending WHERE pending.image=owned.image AND pending.status IN ('queued','pulling','starting'))
    AND NOT EXISTS (SELECT 1 FROM previews p WHERE p.image=owned.image AND p.status<>'deleted')`;
  async unusedImages(repository: string) {
    return (await this.pool.query(this.unusedImageSql, [repository])).rows.map(row => String(row.image));
  }
  async collectImageIfUnused(repository: string, image: string, collect: () => Promise<void>) {
    // Same lock as enqueue: a job cannot start needing this digest between eligibility and removal.
    await this.transaction(async client => {
      const eligible = await client.query(`${this.unusedImageSql} AND owned.image=$2`, [repository, image]);
      if (eligible.rowCount) await collect();
    });
  }
}
