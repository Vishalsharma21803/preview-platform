# Verification and acceptance report

## Live EC2/GitHub verification — PR #1

The historical local-only report below predates EC2 provisioning. Current live
evidence supersedes its EC2/GitHub-blocked statements for the first deployment:

- SnippetShelf PR #1 build run `38224410516`: successful.
- Trusted deploy run `38224541089`: deployment job successful.
- Deployed commit: `a95f85b5f76576dfc2181a5f0fe468d5c0ada3e0`.
- Deployment ID: `0380e745-fbe4-4603-8db7-34766160390d`.
- Image: `ghcr.io/vishalsharma21803/snippetshelf@sha256:251675b7cf609cc104386c0fc9776b777f1728b0bcff5006ef2139e8a785364a`.
- EC2 API/worker active; PostgreSQL running with persistent volume; public
  `/api/previews` reports PR #1 healthy.
- `http://13.63.54.222/pr-1/`, both referenced JavaScript/CSS assets and
  `/pr-1/healthz` returned HTTP 200.
- Headless Playwright Chromium loaded the live preview with rendered application
  content, expected title and zero page errors. Root dashboard displayed `PR #1`.
- GitHub Actions bot posted ready preview URL on PR #1.

Earlier build `38223724316` successfully pushed the image but failed at the
workflow's automatic package-visibility step. Removed that invalid operation;
owner set the GHCR package Public, committed and pushed the fix. Latest pipeline
published metadata and called the EC2 API successfully.

Still unverified on the real GitHub/EC2 path: a subsequent application-change
replacement at the same URL, PR-close cleanup, and full host reboot recovery.
HTTP/plaintext transport remains an explicitly accepted personal-MVP limitation;
no TLS, production hardening, or comprehensive security certification claim.

## Live concurrent preview verification — PR #2

The initial preview throttle was an operational setting, not an architectural
constraint. It rejected PR #2 with HTTP 429 while PR #1 was healthy. The EC2
runtime setting was changed to `MAX_ACTIVE_PREVIEWS=5` and the service restarted.
The already-published PR #2 image was then submitted to the same API without
closing PR #1.

- PR #1 remained healthy at `http://13.63.54.222/pr-1/`.
- PR #2 deployment `b9b8defc-07a7-47b3-87f2-2b132882e3cb` became healthy.
- PR #2 served at `http://13.63.54.222/pr-2/` with HTTP 200.
- Both `/pr-1/` and `/pr-2/` returned HTTP 200 in the same verification pass.
- EC2 showed two managed containers, each using its corresponding image digest.
- Public preview list contained both `pr-1` and `pr-2` healthy records.

The PR #2 GitHub deployment job still has a failure comment from the earlier
capacity rejection. Rerunning that trusted deploy job is expected to be
idempotent and update the comment to the live `/pr-2/` URL; no image rebuild is
required.

## Result

**Local MVP verified; whole cloud release NOT VERIFIED.** Production-readiness is
not claimed. Production PostgreSQL was explicitly deferred; no EC2, Cloudflare,
GitHub account or public HTTPS endpoint was configured in this implementation.

All source is new against an empty workspace baseline. No previous application
regression suite existed. Existing unrelated `devops-learning` Compose workload
remained running with its original four containers. No commit or push performed.

## Executed checks

| Command/check | Actual result |
|---|---|
| `npm ci` | PASS; root lockfile installs cleanly |
| `RUN_DOCKER_TESTS=1 npm test` | PASS: 32 backend cases + 19 dashboard/workflow cases; no skipped backend cases; contracts TypeScript check passed |
| `npm run typecheck` | PASS across contracts, backend source/tests and dashboard configs |
| `npm run lint` | PASS; currently TypeScript-based validation, not a separate ESLint/style check |
| `npm run build` | PASS; contracts, API, Vite production bundle |
| `npm audit` | PASS; zero reported vulnerabilities, not proof of absence of vulnerabilities |
| `npm run e2e:local` | PASS; real anonymous GHCR digest pull, Express, PostgreSQL, worker, Docker and Traefik path request |
| `docker compose -f infra/docker-compose.yml config` | PASS |
| `docker build --target preview -t preview-platform-preview:check .` | PASS |
| `docker build --target dashboard -t preview-platform-dashboard:check .` | PASS |
| `docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:latest -shellcheck= .github/workflows/preview.yml .github/workflows/preview-deploy.yml` | PASS; actionlint syntax/semantics; shellcheck integration disabled |
| `DOCKER_BUILDKIT=0 docker compose -f infra/docker-compose.yml up -d --build --wait` | PASS; local three-service stack running |
| HTTP GET direct API `/healthz` | 200; database/worker both `ok` |
| HTTP GET dashboard proxy `/healthz`, `/api/previews` | 200; real healthy API and empty DB list |
| HTTP HEAD dashboard `/` through Traefik | 200; built HTML served |
| Built-in browser visual inspection | NOT VERIFIED: opening local dashboard timed out; no successful browser observation |
| Git status/diff/check | UNAVAILABLE: project is not a Git repository; final review used direct file reads/searches |

Docker reported a missing Buildx plugin for local builds and used legacy builder.
Compose was explicitly run with `DOCKER_BUILDKIT=0`. Hosted workflow installs Buildx
with its setup action. No host-wide Docker/npm/git configuration was changed.

## Acceptance matrix

| # | Criterion | Implemented | Evidence / actual result | Status / remaining issue |
|---|---|---|---|---|
| 1 | Node/Express/TS API; React/Vite/TS dashboard; PostgreSQL | Yes | Builds, schema integration, React tests | PASS locally |
| 2 | Public GET status and health | Yes | API tests; live direct/proxied requests 200 | PASS |
| 3 | POST/DELETE need bearer token | Yes | 401 missing token; 403 wrong token; valid mutation succeeds | PASS |
| 4 | Dashboard has no form or token storage | Yes | React read-only tests; source search | PASS |
| 5 | Only approved public GHCR digest/repository accepted | Yes | Foreign registry, tags, namespace lookalikes rejected; real digest accepted | PASS |
| 6 | Strict commit/port/TTL/runtime-field validation | Yes | Validator/API negative tests | PASS |
| 7 | Asynchronous deploy and idempotent retry | Yes | POST 202, status polling and repeated request reuses ID | PASS |
| 8 | Durable state and migration reruns | Yes locally | Real PostgreSQL migrations rerun safely; worker restart recovers state | PASS locally; production DB BLOCKED |
| 9 | CPU/memory/PID/read-only/capability constraints | Yes | Docker command tests and live inspect | PASS |
| 10 | No host ports/mounts/privileged flags on previews | Yes | Live PortBindings empty; runtime tests; image-declared volumes rejected | PASS |
| 11 | Route hidden until health succeeds | Yes | Worker event ordering; real file-provider activation tests | PASS |
| 12 | Return stable `/pr-<number>/` URL per approved repository PR | Yes | Real repeated deployment returns same path URL; Traefik request uses `/pr-42/healthz` | PASS locally |
| 13 | Failed replacement preserves serving container and metadata | Yes | Real unhealthy candidate; previous route stays 200; state tests | PASS |
| 14 | Successful replacement removes old container | Yes | Real E2E confirms one managed container after replacement | PASS; no zero-downtime claim |
| 15 | New request supersedes in-flight work safely | Yes | Supersession during route activation regression test | PASS at platform request order; live GitHub ordering unverified |
| 16 | Delete during deployment remains durable and cleans resources | Yes | Cancellation/deletion serialization regression test | PASS |
| 17 | TTL expiry removes container and route | Yes | Real PostgreSQL expiration and proxy changes to 404 | PASS |
| 18 | Orphan/route reconciliation and restart | Yes | Live worker restart and unit crash/ambiguous-commit cases | PASS tested paths |
| 19 | Missing/stopped container does not block other jobs | Yes | Recovery tests and recorded unhealthy state | PASS |
| 20 | Owned image cleanup preserves unrelated Docker state | Yes | Real GHCR GC test protects unrelated stopped-container reference | PASS; shared aliases/caches intentionally retained |
| 21 | Long pulls renew leases and worker liveness | Yes | Regression runs beyond original five-second lease | PASS |
| 22 | Capacity/body/rate limits and sanitized public failures | Yes | PostgreSQL capacity and API 413/429/error tests | PASS |
| 23 | Dashboard loading/empty/error/degraded/live metadata states | Yes | React render tests, production HTML/API smoke | PASS automated; visual inspection NOT VERIFIED |
| 24 | Build/push/deploy/comment workflow | Yes, template | Workflow tests and actionlint | LOCAL STATIC PASS; GitHub execution BLOCKED |
| 25 | PR-close event + scheduled closed-PR cleanup | Yes, template | Trusted cleanup workflow static checks | LOCAL STATIC PASS; live GitHub trigger BLOCKED |
| 26 | EC2 uses existing instance | Not deployed | No EC2 access/details or production database | BLOCKED |
| 27 | Cloudflare wildcard DNS + public HTTPS | Not configured | No zone/domain credentials; only local HTTP tested | BLOCKED |
| 28 | Hard disk quotas / egress sandboxing / host metadata isolation | No | Container policy is not a full host sandbox | NOT IMPLEMENTED; production security gate |
| 29 | Production database backups and disaster recovery | No, deferred | No production DB approved | BLOCKED |
| 30 | Sustained load, container-image vulnerability scan, penetration test | No | Functional limits tested, not throughput/security certification | NOT VERIFIED |
| 31 | No actual tokens committed or returned | Yes | Environment-only auth, fixed public errors, source pattern review | PASS reviewed scope; no formal secret scanner |

## Bugs found, fixed and retested

- Removed old container before replacement health: introduced unrouted candidates,
  atomic route publication and serving-state preservation.
- Five-second lease expired during real pull: renewable leases and worker liveness.
- Reconciliation could delete candidates or miss expired deletion: serialized
  operations, durable intent and full-ID ownership checks.
- Health probe depended on `node` in frontend image: host-side bounded HTTP probes.
- Public port conflicts/exposure: preview containers now publish no host ports.
- Docker errors leaked into public status: fixed-message error mapping.
- Failed replacement overwrote displayed commit/image: separate serving/requested state.
- Missing container blocked queue: per-preview degraded state with explicit repair.
- `--read-only` still allowed image-declared volumes: pre-run image rejection.
- Mutable-tag digest race and privileged PR workflow: immutable action digest and
  separate default-branch trusted deploy flow, no PR checkout there.
- Dashboard did not proxy API and lacked real tests: same-origin proxy and 19 tests.
- First root test failed because dashboard had no test script: real suite added.
- First integrated harness restart still referenced old worker; cleanup stopped DB
  before pool: fixed dependency reference and close order, rerun passed.
- Idle pg connection errors could dump driver state: sanitized pool error handler.
- Invalid UUID returned database error / oversized body returned 500: explicit 400/413
  handling with regression tests.

## Remaining boundaries

Read `README.md` release gates before exposing any service publicly. Important:
no image-pull disk quota, no container egress/metadata isolation, no production DB,
no TLS configuration, shared API/worker Docker authority, asynchronous Traefik
reload, and no continuously probed application uptime guarantee.

Local tests prove the image-to-container-to-URL mechanism. They do **not** prove
the user's actual frontend repository, hosted workflow, target EC2 architecture,
Cloudflare records, certificate issuance, production storage, or release readiness.
