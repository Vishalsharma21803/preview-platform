import { useCallback, useEffect, useMemo, useState } from 'react';

type PreviewStatus = 'queued' | 'pulling' | 'starting' | 'healthy' | 'ready' | 'failed' | 'deleting' | 'deleted';

type Preview = {
  id: string;
  previewId?: string;
  repository: string;
  pullRequestNumber: number;
  commitSha?: string;
  image?: string;
  imageReference?: string;
  imageDigest?: string | null;
  status: PreviewStatus;
  health?: 'healthy' | 'unhealthy' | 'unknown' | null;
  previewUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string | null;
  error?: string | null;
};

type Health = {
  status?: string;
  database?: string | { status?: string };
  worker?: string | { status?: string };
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const REFRESH_INTERVAL_MS = 15_000;

function shortSha(sha?: string) {
  return sha ? sha.slice(0, 7) : '—';
}

function imageName(reference: string) {
  const withoutDigest = reference.split('@')[0] ?? reference;
  return withoutDigest.replace(/^ghcr\.io\//, '');
}

function imageDigest(preview: Preview) {
  if (preview.imageDigest) return preview.imageDigest;
  const reference = preview.image ?? preview.imageReference;
  return reference?.split('@')[1] ?? null;
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function statusLabel(status: PreviewStatus) {
  return status === 'pulling' ? 'Pulling image' : status[0].toUpperCase() + status.slice(1);
}

function stateTone(status: PreviewStatus) {
  if (status === 'ready' || status === 'healthy') return 'ready';
  if (status === 'failed') return 'failed';
  if (status === 'deleting') return 'muted';
  return 'working';
}

async function getJson<T>(path: string, acceptDegraded = false): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok && !(acceptDegraded && response.status === 503)) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function normalizePreviews(payload: unknown): Preview[] {
  if (Array.isArray(payload)) return payload as Preview[];
  if (payload && typeof payload === 'object' && 'previews' in payload) {
    const previews = (payload as { previews?: unknown }).previews;
    return Array.isArray(previews) ? previews as Preview[] : [];
  }
  throw new Error('Invalid preview list response');
}

function serviceHealth(value: Health['database']) {
  if (typeof value === 'string') return value;
  return value?.status ?? 'unknown';
}

export function App() {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [previewPayload, healthPayload] = await Promise.all([
        getJson<unknown>('/api/previews'),
        getJson<Health>('/healthz', true),
      ]);
      setPreviews(normalizePreviews(previewPayload));
      setHealth(healthPayload);
      setLastUpdated(new Date());
      setError(null);
    } catch (cause) {
      setHealth(null);
      setError(cause instanceof Error ? cause.message : 'Unable to reach preview API');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const readyCount = useMemo(() => previews.filter((preview) => preview.status === 'ready' || preview.status === 'healthy').length, [previews]);
  const healthStatus = health?.status ?? 'unknown';
  const isHealthy = healthStatus === 'ok' || healthStatus === 'healthy';

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Preview Console home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>preview<span className="brand-accent">/</span>console</span>
        </a>
        <div className="topbar-meta">
          <span className={`system-status ${isHealthy ? 'is-healthy' : 'is-unknown'}`}>
            <span className="status-dot" />
            {isHealthy ? 'All systems operational' : healthStatus === 'degraded' ? 'System degraded' : 'System status unknown'}
          </span>
          <button className="refresh-button" onClick={() => void refresh()} disabled={loading}>
            <span className={loading ? 'refresh-icon spinning' : 'refresh-icon'} aria-hidden="true">↻</span>
            Refresh
          </button>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">PUBLIC PREVIEW ENVIRONMENTS</p>
          <h1>See what is running.</h1>
          <p className="hero-copy">Live environments for every active pull request, in one place.</p>
        </div>
        <div className="hero-mark" aria-hidden="true">
          <span className="hero-orbit orbit-one" /><span className="hero-orbit orbit-two" /><span className="hero-orbit orbit-three" />
          <span className="hero-core" />
        </div>
      </section>

      <section className="metrics" aria-label="Preview summary">
        <div className="metric-card"><span className="metric-label">ACTIVE PREVIEWS</span><strong>{previews.length}</strong><span className="metric-caption">Currently tracked</span></div>
        <div className="metric-card"><span className="metric-label">READY</span><strong className="metric-positive">{readyCount}</strong><span className="metric-caption">Passing health checks</span></div>
        <div className="metric-card"><span className="metric-label">DATABASE</span><strong className="metric-word">{serviceHealth(health?.database) === 'ok' ? 'Online' : serviceHealth(health?.database)}</strong><span className="metric-caption">PostgreSQL connection</span></div>
        <div className="metric-card"><span className="metric-label">WORKER</span><strong className="metric-word">{serviceHealth(health?.worker) === 'ok' ? 'Online' : serviceHealth(health?.worker)}</strong><span className="metric-caption">Deployment queue</span></div>
      </section>

      <section className="section-heading">
        <div><h2>Active previews</h2><p>Automatically refreshed every 15 seconds</p></div>
        {lastUpdated && <span className="updated-at">Updated {lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
      </section>

      {error && <div role="alert" className="notice error-notice"><span aria-hidden="true">!</span><div><strong>Could not load live data</strong><p>{error}. Check API connectivity and try again.</p></div><button onClick={() => void refresh()}>Try again</button></div>}

      {!error && loading && <div role="status" aria-label="Loading previews" className="preview-list"><div className="skeleton-card" /><div className="skeleton-card" /></div>}

      {!loading && !error && previews.length === 0 && (
        <div className="empty-state"><span className="empty-icon" aria-hidden="true">⌁</span><h3>No active previews</h3><p>Deployments from open pull requests will appear here.</p></div>
      )}

      <div className="preview-list">
        {previews.map((preview) => <PreviewCard key={preview.id ?? preview.previewId} preview={preview} />)}
      </div>

      <footer><span>Preview Console</span><span>Read-only status dashboard <i>·</i> {new Date().getFullYear()}</span></footer>
    </main>
  );
}

function PreviewCard({ preview }: { preview: Preview }) {
  const health = preview.health ?? (preview.status === 'ready' || preview.status === 'healthy' ? 'healthy' : 'unknown');
  const url = preview.previewUrl;
  const digest = imageDigest(preview);
  return (
    <article className="preview-card">
      <div className="preview-main">
        <div className={`preview-icon tone-${stateTone(preview.status)}`} aria-hidden="true">↗</div>
        <div className="preview-title-block"><div className="repo-line"><h3>{preview.repository}</h3><span className="pr-number">PR #{preview.pullRequestNumber}</span></div><p className="image-line"><span className="cube-icon" aria-hidden="true">◇</span>{imageName(preview.image ?? preview.imageReference ?? 'Image unavailable')}</p></div>
        <div className="status-block"><span className={`status-badge status-${stateTone(preview.status)}`}><span className="status-dot" />{statusLabel(preview.status)}</span><span className={`health-label health-${health}`}>{health === 'healthy' ? 'Healthy' : health === 'unhealthy' ? 'Unhealthy' : 'Health pending'}</span></div>
      </div>
      <div className="preview-details">
        <div className="detail"><span>COMMIT</span><code>{shortSha(preview.commitSha)}</code></div>
        <div className="detail"><span>IMAGE DIGEST</span><code>{digest ? `${digest.slice(0, 19)}…` : 'Resolving…'}</code></div>
        <div className="detail"><span>UPDATED</span><strong>{formatDate(preview.updatedAt || preview.createdAt)}</strong></div>
        <div className="detail"><span>EXPIRES</span><strong>{formatDate(preview.expiresAt)}</strong></div>
        {url ? <a className="open-preview" href={url} target="_blank" rel="noreferrer">Open preview <span aria-hidden="true">↗</span></a> : <span className="open-preview disabled">URL pending <span aria-hidden="true">↗</span></span>}
      </div>
      {preview.error && <p className="preview-error">{preview.error}</p>}
    </article>
  );
}
