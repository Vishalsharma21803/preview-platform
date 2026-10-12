import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/config.js";
import { previewIdentity, validateCreateRequest } from "../src/domain/validation.js";
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
test("namespace configuration requires owner/repository and identity is collision resistant", () => {
  assert.throws(() => loadConfig({ ALLOWED_IMAGE_NAMESPACE: "acme" }));
  assert.notEqual(previewIdentity("acme/a-b", 1).id, previewIdentity("acme/a_b", 1).id);
  assert.match(previewIdentity("Acme/my-app", 12).id, /^acme-my-app-[a-f0-9]{10}-pr-12$/);
});
