// Run on the EC2 host as the deployment user. Never prints secret values.
import { randomBytes } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';

const base = '/opt/preview-platform';
const config = `${base}/config`;
await mkdir(config, { recursive: true, mode: 0o700 });
const exists = async path => {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const databaseFile = `${config}/postgres.env`;
const platformFile = `${config}/platform.env`;
if (await exists(databaseFile) || await exists(platformFile)) {
  throw new Error('Configuration already exists; refusing to rotate or overwrite secrets implicitly.');
}
const password = randomBytes(32).toString('hex');
const token = randomBytes(32).toString('hex');
await writeFile(databaseFile, `POSTGRES_PASSWORD=${password}\n`, { mode: 0o600, flag: 'wx' });
await writeFile(platformFile, [
  'NODE_ENV=production',
  'PORT=18081',
  `DATABASE_URL=postgres://preview:${password}@127.0.0.1:55432/preview_platform`,
  `DEPLOYMENT_TOKEN=${token}`,
  'ALLOWED_IMAGE_NAMESPACE=vishalsharma21803/snippetshelf',
  'PREVIEW_BASE_URL=http://13.63.54.222',
  'PREVIEW_TRAILING_SLASH=true',
  'TRAEFIK_NETWORK=preview-platform-runtime',
  `ROUTES_DIR=${base}/app/infra/routes`,
  'HEALTH_CHECK_PATH=/healthz',
  'MAX_ACTIVE_PREVIEWS=2',
  'DEFAULT_TTL_HOURS=24',
  'MAX_TTL_HOURS=168',
  'PREVIEW_MEMORY=256m',
  'PREVIEW_CPUS=0.5',
  'PREVIEW_PIDS_LIMIT=128',
  '',
].join('\n'), { mode: 0o600, flag: 'wx' });
console.log('EC2 configuration generated with protected permissions. Secret values were not displayed.');
