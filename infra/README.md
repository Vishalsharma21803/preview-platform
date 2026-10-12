# Local dashboard and routing

```sh
docker compose -f infra/docker-compose.yml up -d --build
```

- PostgreSQL: `127.0.0.1:55432`, database `preview_platform`, user/password `preview`.
- Traefik: `http://127.0.0.1:18080`; dashboard application:
  `http://dashboard.preview.localhost:18080`. No Traefik admin dashboard is exposed.
- Start the host API on port `18081`. Vite (`npm run dev -w @preview/dashboard`)
  proxies `/api` and `/healthz` to `127.0.0.1:18081`.
- Built dashboard Nginx proxies public reads to `host.docker.internal:18081` using
  Docker `host-gateway`. On Linux the host API must listen on an address reachable
  from the Docker bridge (not only host loopback); firewall access to the bridge
  as appropriate. No public backend URL, CORS setting, or frontend token is needed.
- Traefik watches the **directory** `infra/routes` mounted read-only. The host API
  atomically writes preview router/service files there; do not mount individual
  generated files because rename-based updates must remain visible. Keep static
  `dashboard.yml` when cleaning generated preview route files.
- Runtime containers and dashboard share named network `preview-platform-runtime`.
  API-generated routes should use this network's reachable container endpoints.
- No Docker socket is mounted into Traefik or the dashboard.
- Dockerfile `dashboard` target includes the local host API proxy. `preview` target
  serves static assets only, so constrained preview containers do not need host
  gateway access. Both run Nginx as its non-root user, with temporary files/PID in
  Docker's writable `/dev/shm`, compatible with read-only root filesystems.

These bindings and plain HTTP routing are local-development settings.
