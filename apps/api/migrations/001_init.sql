CREATE TYPE deployment_status AS ENUM ('queued','pulling','starting','healthy','failed','deleting','deleted');

CREATE TABLE deployments (
  id UUID PRIMARY KEY,
  preview_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
  commit_sha TEXT NOT NULL,
  image TEXT NOT NULL,
  container_port INTEGER NOT NULL CHECK (container_port BETWEEN 1 AND 65535),
  ttl_hours NUMERIC NOT NULL CHECK (ttl_hours > 0 AND ttl_hours <= 168),
  status deployment_status NOT NULL DEFAULT 'queued',
  error TEXT,
  lease_owner UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX deployments_queue_idx ON deployments(status, created_at);
CREATE INDEX deployments_preview_idx ON deployments(preview_id);

CREATE TABLE previews (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  status deployment_status NOT NULL,
  health TEXT NOT NULL CHECK (health IN ('unknown','healthy','unhealthy')),
  deployment_id UUID REFERENCES deployments(id),
  container_id TEXT,
  commit_sha TEXT,
  image TEXT,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository, pull_request_number)
);
