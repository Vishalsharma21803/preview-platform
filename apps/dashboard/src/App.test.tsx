import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';

const healthy = { status: 'ok', database: 'ok', worker: 'ok' };
const preview = {
  id: 'preview-1', repository: 'owner/repository', pullRequestNumber: 42,
  commitSha: 'abcdef0123456789', image: `ghcr.io/owner/repository@sha256:${'a'.repeat(64)}`,
  status: 'healthy', health: 'healthy', previewUrl: 'http://13.63.54.222/pr-42/',
  updatedAt: '2026-10-09T14:00:00Z', expiresAt: '2026-10-10T14:00:00Z',
};

function respond(previews: unknown, health = healthy, status = 200) {
  const mock = vi.fn(async (path: string) => new Response(JSON.stringify(path.endsWith('/healthz') ? health : previews), {
    status: path.endsWith('/healthz') ? status : 200,
  }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders loading state while public reads are pending', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  render(<App />);
  expect(screen.getByRole('status', { name: 'Loading previews' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true);
});

it('renders empty state after successful reads', async () => {
  respond([]);
  render(<App />);
  expect(await screen.findByText('No active previews')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});

it('shows failed requests and recovers through retry', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  render(<App />);
  expect((await screen.findByRole('alert')).textContent).toContain('Request failed (500)');
  respond([]);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('No active previews')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('renders real preview metadata and makes only unauthenticated read requests', async () => {
  const fetchMock = respond([preview]);
  const { container } = render(<App />);
  expect(await screen.findByRole('heading', { name: 'owner/repository' })).toBeTruthy();
  expect(screen.getByText('PR #42')).toBeTruthy();
  expect(screen.getByText('abcdef0')).toBeTruthy();
  expect(screen.getByText('sha256:aaaaaaaaaaaa…')).toBeTruthy();
  expect((screen.getByRole('link', { name: /Open preview/ }) as HTMLAnchorElement).href).toBe(preview.previewUrl);
  expect(container.querySelector('form')).toBeNull();
  expect(fetchMock.mock.calls).toEqual([['/api/previews'], ['/healthz']]);
});

it('shows degraded service health without hiding previews', async () => {
  respond([preview], { status: 'degraded', database: 'down', worker: 'ok' }, 503);
  render(<App />);
  expect(await screen.findByText('System degraded')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'owner/repository' })).toBeTruthy();
  expect(screen.getByText('down')).toBeTruthy();
});

it('handles missing metadata and failed preview health', async () => {
  respond([{ id: 'p2', repository: 'owner/pending', pullRequestNumber: 9, status: 'failed', health: 'unhealthy' }]);
  render(<App />);
  expect(await screen.findByText('Failed')).toBeTruthy();
  expect(screen.getByText('Unhealthy')).toBeTruthy();
  expect(screen.getByText('Image unavailable')).toBeTruthy();
  expect(screen.queryByRole('link', { name: /Open preview/ })).toBeNull();
});

it('does not claim healthy service state after refresh fails', async () => {
  respond([preview]);
  render(<App />);
  await screen.findByText('All systems operational');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Offline'); }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.queryByText('All systems operational')).toBeNull());
});
