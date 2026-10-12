import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/config.js";
import { previewIdentity, previewUrl, validateCreateRequest } from "../src/domain/validation.js";
import { body, config } from "./helpers.js";

test("accepts digest-pinned images within one configured repository scope", () => {
  assert.equal(validateCreateRequest(body, config).containerPort, 3000);
  assert.equal(validateCreateRequest({ ...body, image: `ghcr.io/acme/frontend@sha256:${"b".repeat(64)}` }, config).repository, "acme/frontend");
});
test("rejects tags, lookalike namespaces, foreign repositories and arbitrary runtime options", () => {
  for (const patch of [
    { image: "ghcr.io/acme/frontend/app:latest" }, { image: body.image.replace("ghcr.io", "docker.io") },
    { image: body.image.replace("frontend/", "frontend-evil/") }, { repository: "other/frontend" },
    { privileged: true }, { ttlHours: 169 }, { containerPort: 65536 },
  ]) assert.throws(() => validateCreateRequest({ ...body, ...patch }, config));
});
test("namespace configuration requires owner/repository and path identity is PR-scoped", () => {
  assert.throws(() => loadConfig({ ALLOWED_IMAGE_NAMESPACE: "acme" }));
  assert.equal(previewIdentity("acme/a-b", 1).id, "pr-1");
  assert.equal(previewIdentity("Acme/my-app", 12).pathPrefix, "/pr-12");
  assert.equal(previewIdentity("Acme/my-app", 12).id, previewIdentity("acme/other", 12).id);
});

test("preview URL uses configurable base origin and trailing slash", () => {
  const identity = previewIdentity(body.repository, 42);
  assert.equal(previewUrl(identity.pathPrefix, config), "http://13.63.54.222/pr-42/");
  assert.equal(previewUrl(identity.pathPrefix, { ...config, PREVIEW_BASE_URL: "http://example.test/", PREVIEW_TRAILING_SLASH: false }), "http://example.test/pr-42");
});
