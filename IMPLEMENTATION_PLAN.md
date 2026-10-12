# Preview Platform — implementation plan and progress

## Approved outcome and scope

An image deployment service, not a CI builder. GitHub Actions builds/pushes the
frontend image, calls an authenticated API, and polls for its PR-specific URL.
Node/Express/TypeScript implements the API and one serialized worker. PostgreSQL
runs locally in Docker. React/Vite/TypeScript supplies a public **read-only**
dashboard. GET status/health is public; POST and DELETE require a static bearer.
Production PostgreSQL was explicitly deferred. No stateless fallback is permitted.

Baseline: empty workspace, no Git repository, no application or tests. Existing
unrelated Docker Compose workload must remain untouched. Native Linux Docker,
Node, npm, and PostgreSQL Docker images are available for real local tests.

## Boundaries

- Platform accepts exactly one configured public GHCR repository namespace.
- Images must be digest-pinned, self-contained, and compatible with read-only
  filesystem and dropped capabilities. Image-declared volumes are rejected.
- Default limits: 0.5 CPU, 256 MiB, 128 PIDs, 10 active previews, 24h TTL, max 168h.
- The single worker/API process runs on the Linux Docker host. It is not isolated
  from Docker authority. Do not expose this development setup to the internet.
- No dashboard form, login, backend dependencies for preview images, arbitrary
  Docker options, automatic fork deployments, autoscaling, or EC2 provisioning.
- Existing EC2 is the eventual host. Production database, HTTPS, network policy,
  credentials and actual frontend repository remain external deployment gates.

## Dependency-ordered tasks

### 1. Workspace and contracts — implemented

- Root npm workspaces and lockfile; shared strict TypeScript options.
- `packages/contracts`: request, deployment, preview, health types.
- `.env.example`: documented placeholders, no secrets.
- Build contracts before consumers on fresh installs.

### 2. Persistence and migrations — implemented

- `apps/api/migrations/001_init.sql`: deployment queue and preview records.
- `002_active_container_port.sql`: preserve serving container port across failures.
- `003_preview_runtime_state.sql`: separate serving and requested deployment
  pointers; persist missing/stopped/running state.
- Transactional migration ledger and advisory locks.
- Atomic capacity reservation, idempotent retries, leased queue claims, heartbeats,
  cancellation intent, expiration, serving-state recovery, scoped image GC.
- Tests: real disposable PostgreSQL, repeated migrations, constraints/capacity,
  metadata preservation, leases, completion, deletion and image eligibility.

### 3. API and validation — implemented

- Public health, preview list/detail and deployment detail endpoints.
- Authenticated POST deployment and DELETE preview endpoints.
- Constant-time token comparison; no persisted token; sanitized public errors.
- Strict request schema rejects unknown fields, mutable tags, foreign registries,
  lookalike namespaces, invalid repository/SHA/port/TTL.
- Body-size limits, mutation rate limits and active-preview capacity limits.
- Tests: public reads, missing/wrong auth, negative validation, idempotency,
  malformed ID, oversized body, rate limit, sanitized repository errors.

### 4. Docker worker and routes — implemented

- Bounded Docker CLI calls without a shell or user-provided flags.
- Pull immutable image, reject declared volumes, start UUID-named candidate.
- No published host ports. Native host probes container bridge IP with timeout;
  no requirement for Node/curl in the application image. Redirects fail probes.
- Publish route only after health succeeds; keep old serving state on failure.
- Record successful candidate before removing unreferenced containers.
- Renew worker lease through long pulls; serialize runtime changes and cleanup.
- Restore committed routes after restart; handle individual lost containers
  without blocking all other deployments. DELETE intent survives disconnects.
- Scoped unused-image cleanup: never force or globally prune; protect unrelated
  containers and shared image aliases.

Routing implementation detail: atomic Traefik file-provider routes replace the
initial Docker-label routing sketch. Labels retain ownership metadata only.
This avoids routing unready candidates and removes Traefik's Docker socket mount.
File publication and DB commit are not a distributed transaction; restart repairs
interrupted switches. Traefik reload is asynchronous, not zero-downtime guaranteed.

### 5. Dashboard — implemented

- Public read-only list with health, status, commit, digest, URL and expiry.
- Loading, empty, stale/error/retry and degraded system states.
- Periodic refresh; no token input, localStorage secret or mutation control.
- Render tests verify these states and absence of mutation requests.

### 6. Local infrastructure — implemented

- `infra/docker-compose.yml`: isolated project, loopback PostgreSQL :55432,
  Traefik :18080, built Nginx dashboard and runtime network.
- `infra/routes/dashboard.yml`: dashboard host route.
- Multi-stage Dockerfile: read-only static `preview` target; API-proxy `dashboard` target.
- Local API runs on host :18081; Vite proxies status requests to it.
- Development HTTP only. Example PostgreSQL password is not a production secret.

### 7. GitHub integration — implemented, external execution blocked

- `.github/workflows/preview.yml`: same-repository PR only, immutable head commit,
  unique tag, Buildx digest output, small JSON metadata artifact.
- `.github/workflows/preview-deploy.yml`: trusted default-branch workflow validates
  run, repository, SHA, PR state and digest; constructs image reference internally;
  calls authenticated API, polls and updates PR comment.
- Closed PR cleanup plus hourly scheduled GitHub reconciliation.
- Keep deployment token in a default-branch-restricted GitHub environment, not
  PR build context. GHCR package visibility must explicitly be made public.
- Fixture builds the dashboard static image. Adapt target/port for user's separate
  frontend repo; cloud architecture must match EC2 before first real deployment.

### 8. Live E2E — implemented

- `scripts/e2e-local.mjs` starts disposable PostgreSQL, Docker network and Traefik.
- Exercises real public GHCR pull, Express HTTP API, worker and persisted state.
- Validates first deployment, idempotency, replacement, failed replacement,
  worker restart, DELETE, reopen and expiry through actual proxy HTTP responses.
- Removes only run-owned resources. No cloud account or existing database touched.

### 9. Final verification and handoff

- Run full tests with Docker enabled, typecheck, TypeScript-backed lint, build,
  npm audit, Compose validation, workflow lint, both Docker targets, live E2E.
- Review all new source/configuration; inspect leftovers and secret patterns.
- Record evidence and remaining gates in `VERIFICATION.md`.
- Do not claim EC2/GitHub/DNS/TLS validation or production readiness.

## Exact checks

```sh
npm ci
RUN_DOCKER_TESTS=1 npm test
npm run typecheck
npm run lint
npm run build
npm audit
npm run e2e:local
docker compose -f infra/docker-compose.yml config
docker build --target preview -t preview-platform-preview:check .
docker build --target dashboard -t preview-platform-dashboard:check .
actionlint .github/workflows/preview.yml .github/workflows/preview-deploy.yml
```

Acceptance-to-test mapping and actual results belong in `VERIFICATION.md`, not
inferred from implementation completion. Git diff is unavailable until the user
initializes a repository; all files are new against the empty baseline.
