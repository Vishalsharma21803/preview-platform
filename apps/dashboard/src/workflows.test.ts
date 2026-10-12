// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { expect, it, vi } from 'vitest';

// Exercise the actual inline trusted code without checking out/executing PR code.
const workflow = parse(readFileSync(new URL('../../../.github/workflows/preview-deploy.yml', import.meta.url), 'utf8'));
const build = parse(readFileSync(new URL('../../../.github/workflows/preview.yml', import.meta.url), 'utf8'));
const metadataScript = workflow.jobs.deploy.steps.find((step: { id?: string }) => step.id === 'metadata').with.script;
const cleanupScript = workflow.jobs.cleanup.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const realRequire = createRequire(import.meta.url);

async function validate(metadata = { digest, headSha: sha, pr: 42 }, changes = {}) {
  const setOutput = vi.fn();
  const github = { rest: { pulls: { get: vi.fn(async () => ({ data: {
    number: 42, state: 'open', base: { repo: { id: 1 } }, head: { repo: { id: 1 }, sha }, ...changes,
  } })) } } };
  const requireMock = (name: string) => name === 'node:fs' ? {
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }),
    readFileSync: () => JSON.stringify(metadata),
  } : realRequire(name);
  await new AsyncFunction('require', 'process', 'github', 'context', 'core', metadataScript)(
    requireMock, { env: { METADATA_DIR: '/fixture', EXPECTED_SHA: sha, RUN_PRS: '[42]' } }, github,
    { repo: { owner: 'Owner', repo: 'Repo' }, payload: { repository: { id: 1 } } }, { setOutput },
  );
  return setOutput;
}

it('trusted validation constructs namespace internally from repository context', async () => {
  const output = await validate();
  expect(output).toHaveBeenCalledWith('image', `ghcr.io/owner/repo@${digest}`);
});

it.each([
  { digest: 'sha256:evil', headSha: sha, pr: 42 },
  { digest, headSha: 'b'.repeat(40), pr: 42 },
  { digest, headSha: sha, pr: 43 },
  { digest, headSha: sha, pr: -1 },
])('rejects malicious or mismatched artifact metadata: %j', async (metadata) => {
  await expect(validate(metadata)).rejects.toThrow();
});

it.each([
  { state: 'closed' },
  { head: { repo: { id: 2 }, sha } },
  { head: { repo: { id: 1 }, sha: 'b'.repeat(40) } },
  { base: { repo: { id: 2 } } },
])('rejects closed, fork, stale or foreign PR: %j', async (pr) => {
  await expect(validate(undefined, pr)).rejects.toThrow();
});

it('build job never receives deployment secret; trusted workflow never checks out PR code', () => {
  const text = JSON.stringify(build);
  expect(text).not.toContain('PREVIEW_PLATFORM_TOKEN');
  expect(text).toContain('steps.build.outputs.digest');
  expect(JSON.stringify(workflow)).not.toContain('actions/checkout');
  expect(JSON.stringify(workflow)).not.toContain('imagetools');
});

it('all trusted inline scripts parse without GitHub expression interpolation', () => {
  for (const job of Object.values(workflow.jobs) as { steps: { with?: { script?: string } }[] }[]) {
    for (const step of job.steps) {
      const script = step.with?.script;
      if (!script) continue;
      expect(script).not.toContain('${{');
      expect(() => new AsyncFunction('github', 'context', 'core', script)).not.toThrow();
    }
  }
});

it('scheduled cleanup deletes only closed previews belonging to this repository', async () => {
  const previews = [
    { id: 'closed', repository: 'Owner/Repo', pullRequestNumber: 42 },
    { id: 'open', repository: 'Owner/Repo', pullRequestNumber: 43 },
    { id: 'foreign', repository: 'other/repo', pullRequestNumber: 44 },
  ];
  const fetchMock = vi.fn(async (_url: URL, options: { method: string }) =>
    new Response(JSON.stringify(options.method === 'GET' ? previews : {})));
  const get = vi.fn(async ({ pull_number }: { pull_number: number }) => ({ data: {
    number: pull_number, state: pull_number === 42 ? 'closed' : 'open', base: { repo: { id: 1 } },
  } }));
  await new AsyncFunction('fetch', 'process', 'github', 'context', 'core', cleanupScript)(
    fetchMock, { env: { PLATFORM_API_URL: 'https://platform.example', DEPLOYMENT_TOKEN: 'fixture' } },
    { rest: { pulls: { get } } },
    { repo: { owner: 'Owner', repo: 'Repo' }, eventName: 'schedule', payload: { repository: { id: 1 } } },
    { info: vi.fn() },
  );
  expect(get).toHaveBeenCalledTimes(2);
  const mutations = fetchMock.mock.calls.filter(([, options]) => options.method === 'DELETE');
  expect(mutations).toHaveLength(1);
  expect(mutations[0]?.[0].pathname).toBe('/api/previews/closed');
});
