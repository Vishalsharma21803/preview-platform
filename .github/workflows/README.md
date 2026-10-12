# Preview workflow templates

Two workflows separate untrusted PR builds from authenticated platform actions.

- `preview.yml`: same-repository PRs only; checks out the exact PR head SHA,
  builds/pushes `ghcr.io/<owner>/<repository>:pr-<number>-<sha>`, and uploads a
  small JSON artifact containing the build action's immutable digest, PR, and SHA.
  The only write credential is GitHub's scoped package token. No platform token.
- `preview-deploy.yml`: default-branch `workflow_run` code; never checks out PR
  code or executes artifacts. Verifies source repository, workflow identity,
  successful PR run, head SHA, current open same-repository PR, and digest format.
  It constructs the image namespace from its own repository context, then submits
  and polls the platform API and updates one bot comment. Stale and fork PRs fail
  validation. `pull_request_target: closed` and hourly scheduled reconciliation
  delete closed previews **only for this repository**. Manual dispatch runs cleanup.

## Configuration

1. Commit both workflows on the default branch before expecting `workflow_run`.
2. Create GitHub Environment `preview-platform`. Restrict its deployment branches
   to the default branch (use a protected default branch). Store
   `PREVIEW_PLATFORM_TOKEN` as an **environment secret**, never a repository/organization
   secret available to PR build jobs. Do not attach this environment to the build job.
3. Set environment/repository variable `PREVIEW_PLATFORM_API_URL` to the reachable
   HTTPS API origin. GitHub-hosted runners cannot reach the local-only development
   instance; deployment requires a reachable configured platform endpoint.
4. Configure the platform allowlist as `<lowercase-owner>/<lowercase-repository>`.
   The template deploys the root Dockerfile's `preview` target, port 80, for linux/amd64.
   This static image supports read-only/capability-dropped execution and has no
   host API proxy. A previewed dashboard needs a separately configured public API
   base URL to show data; the template intentionally injects no platform URL/token.
5. Allow Actions package writes. **Manually set GHCR package visibility to Public**
   in the package settings after its first push. New GHCR packages are private by
   default; `GITHUB_TOKEN` push does not change visibility. The platform performs
   anonymous pulls, so the first deploy may fail until this step is complete.
6. Protect changes to these workflows and the environment. Same-repository PR
   authors can build arbitrary code with package-write permission; fork builds
   and deployment are intentionally skipped.

Tags identify builds for humans; deployments use only `sha256:<64 lowercase hex>`
from `docker/build-push-action` output. There is no mutable-tag digest lookup.
Artifacts are untrusted JSON data, not executable code. The privileged workflow
uses event data through `context` and environment variables, never JavaScript
interpolation of PR titles, bodies, refs, or artifact contents.

The scheduled reconciliation uses existing public list + authenticated delete
endpoints; it does not require a separate reconcile API endpoint. Deletions and
deployments are serialized within this repository. GitHub concurrency may coalesce
pending runs, so the schedule repairs missed close events.
