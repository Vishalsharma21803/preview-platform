# Backend runtime integration

## Supported placement

Run **one API/worker process directly on the Linux Docker host** (Node.js 22+).
The API must reach container IPv4 addresses on a user-defined Docker bridge.
Docker Desktop VM addresses and a remote Docker daemon are not supported by this
health-check adapter. `docker` must be installed and accessible to the API user.
The API takes a PostgreSQL session advisory lock; another process using the same
database exits instead of becoming a second runtime writer. Use one database,
one Docker daemon, and one routes directory for this deployment.

## Required configuration

- `DATABASE_URL`: PostgreSQL connection URL; migrations run at API startup.
  Migration `002_active_container_port.sql` preserves the serving port separately
  from the latest attempted deployment. `npm run migrate --workspace @preview/api`
  also applies migrations explicitly.
- `DEPLOYMENT_TOKEN`: secret bearer token, at least 24 characters, supplied via
  environment. Do not commit its value.
- `ALLOWED_IMAGE_NAMESPACE`: exactly one lowercase `owner/repository`. Request
  `repository` must match this value. Images must be
  `ghcr.io/owner/repository[/path]@sha256:<64 lowercase hex characters>`; tags
  alone are rejected, including previously queued tag-only jobs.
- `ROUTES_DIR`: **absolute path** to a dedicated writable directory on the host.
  Mount this entire directory read-only into Traefik, e.g. host path to
  `/etc/traefik/preview-routes`. Do not bind-mount individual route files: updates
  use rename and require directory watching. The directory must be on a local
  filesystem supporting atomic rename. Routes are YAML files containing JSON.
- `TRAEFIK_NETWORK`: existing user-defined bridge network shared by Traefik and
  preview containers (default `traefik-public`).
- `PREVIEW_BASE_URL`: public HTTP(S) origin or IP for Traefik, defaulting to
  `http://13.63.54.222`.
- `PREVIEW_TRAILING_SLASH`: controls whether generated URLs end in `/` (default
  `true`). Preview URLs use `/pr-<number>/`; no hostname subdomains are required.

## Traefik configuration required outside this backend

Set these static options, with the host `ROUTES_DIR` mounted at the directory below:

```text
--providers.file.directory=/etc/traefik/preview-routes
--providers.file.watch=true
--entrypoints.web.address=:80
```

Only Traefik publishes a public port. Preview containers publish **no host ports**
and carry `traefik.enable=false`, so the Docker provider cannot expose candidates.
Traefik's file provider points to `http://<container bridge IPv4>:<containerPort>`.
No Docker provider is necessary for preview routes. The public base URL must
resolve to this proxy. Existing Docker-provider-labelled preview
containers from older versions must be retired before using this setup, to avoid
old Docker-provider routes competing with the new file-provider routes.

## Container/application contract

The application must bind `0.0.0.0` on `containerPort` (default 3000), and return a
2xx response at `HEALTH_CHECK_PATH` (default `/healthz`). Redirects fail health
checks. The API performs HTTP itself; Node, curl, wget, and image-defined health
commands are not required. Candidates run read-only, with dropped capabilities,
no new privileges, fixed resource limits, no host mounts, and no caller-supplied
commands or environment. Images must support that runtime policy.

## Lifecycle and limits

- A candidate is named `preview-<deployment UUID>`. Its route is published only
  after health succeeds. Failed candidates retain the previous serving container
  and route; successful commits remove unreferenced containers afterward.
- Runtime work (deploy, delete, reconcile) is serialized. Delete records intent
  immediately, invalidates the current attempt, and waits for serialized cleanup.
  The DELETE response can therefore wait for a bounded pull/health operation;
  the persisted intent survives client disconnection.
- Lease renewal runs every `WORKER_LEASE_MS / 3` (default lease 30 seconds), and
  successful renewal refreshes worker liveness. `DOCKER_COMMAND_TIMEOUT_MS`
  defaults to 30 seconds; `DOCKER_PULL_TIMEOUT_MS` to 5 minutes.
  Each HTTP probe times out after `HEALTH_CHECK_TIMEOUT_MS` (default 2 seconds).
  Health retries default to 20 attempts with 1 second between attempts.
- Reconciliation runs on startup, after deployment, and periodically (default
  60 seconds). It restores routes from committed database container IDs before
  removing unreferenced, repository-labelled containers; expiry completes deletion.
  A database or route restore failure preserves containers for retry.
- Capacity limits reserve preview slots, including queued work. Replacement can
  temporarily use one extra container beyond the active-preview count.

## Remaining boundaries

The route-file update and PostgreSQL commit cannot form a distributed atomic
transaction. A crash between them can temporarily serve the healthy candidate
until restart reconciliation restores the committed route. Traefik reload is
asynchronous: an atomic file rename is not an acknowledgement from Traefik, and
there may be a short route-propagation interruption during replacement/deletion.
This implementation does not claim zero-downtime proxy switchover.

Killing a timed-out Docker CLI does not guarantee Docker cancelled daemon-side
work. A late-created container is labelled and reclaimed on reconciliation.
Reconciliation does not pull arbitrary images or delete referenced healthy
containers. Missing/stopped containers lose their routes and become unhealthy;
other previews and new deployments continue. Explicit redeployment repairs them.
Scoped unused-digest collection protects queued/serving images, shared aliases and
unrelated containers. It never force-removes or globally prunes image/cache data.
Continuous HTTP uptime monitoring and hard image-pull disk quotas are not
implemented. Runtime failures expose only fixed public error messages.

No EC2, DNS, public GHCR publication/pull, or TLS provisioning is performed here.
Root infrastructure now supplies local file-provider routing; see `infra/README.md`.

## Verification

```sh
npm run test --workspace @preview/api
npm run typecheck --workspace @preview/api
npm run typecheck --workspace @preview/contracts
npm run build --workspace @preview/api
npm run build --workspace @preview/contracts
RUN_DOCKER_TESTS=1 npm run test --workspace @preview/api
```

The opt-in Docker tests create isolated disposable PostgreSQL, bridge network,
non-Node read-only nginx fixture, and Traefik resources. They use `postgres:16`,
`nginx:alpine`, and `traefik:v3.3`, and remove their own containers/network/fixture
image afterward. Base image cache remains. Unit/API tests need neither Docker nor
PostgreSQL. All test-owned filesystem scratch paths are under `/tmp/omnirush`.
