// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (p: string) => `https://api.zaviagent.com${p}`,
}));

import { EngineerSitePreview } from './EngineerSitePreview';

type Pending = { resolve: (body: Record<string, unknown>) => void; reject: (e: unknown) => void };
const pendingPosts: Pending[] = [];

function deleted(): string[] {
  return apiFetch.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE')
    .map(([path]) => decodeURIComponent(String(path).split('/').pop() ?? ''));
}

function posts(): number {
  return apiFetch.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST').length;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  pendingPosts.length = 0;
  apiFetch.mockReset();
  apiFetch.mockImplementation((_path: string, init?: { method?: string }) => {
    if (init?.method === 'POST') {
      return new Promise((resolve, reject) => {
        pendingPosts.push({
          resolve: (body) => resolve({ ok: true, status: 200, json: async () => body }),
          reject,
        });
      });
    }
    return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
  });
});

afterEach(() => {
  cleanup();
});

describe('EngineerSitePreview paid session lifecycle', () => {
  it('closes the Anchor session that arrives after the pane unmounted mid-load', async () => {
    const onSessionChange = vi.fn();
    const view = render(
      <EngineerSitePreview defaultUrl="https://acme.example" autoLoad onSessionChange={onSessionChange} />,
    );
    await flush();
    expect(posts()).toBe(1);

    view.unmount();
    await act(async () => {
      pendingPosts[0].resolve({ session_id: 'sess-late', live_view_url: 'https://live.anchor/late' });
    });
    await flush();

    expect(deleted()).toEqual(['sess-late']);
    expect(onSessionChange).not.toHaveBeenCalledWith('sess-late');
  });

  it('closes a superseded load session and keeps only the newest one', async () => {
    const onSessionChange = vi.fn();
    const view = render(<EngineerSitePreview defaultUrl="https://acme.example" onSessionChange={onSessionChange} />);
    const form = view.container.querySelector('form')!;

    fireEvent.submit(form);
    await flush();
    fireEvent.submit(form);
    await flush();
    expect(posts()).toBe(2);

    await act(async () => {
      pendingPosts[1].resolve({ session_id: 'sess-new', live_view_url: 'https://live.anchor/new' });
    });
    await flush();
    await act(async () => {
      pendingPosts[0].resolve({ session_id: 'sess-old', live_view_url: 'https://live.anchor/old' });
    });
    await flush();

    expect(deleted()).toEqual(['sess-old']);
    expect(onSessionChange).toHaveBeenLastCalledWith('sess-new');
    expect(onSessionChange).not.toHaveBeenCalledWith('sess-old');
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toContain('live.anchor/new');

    view.unmount();
    await flush();
    expect(deleted()).toEqual(['sess-old', 'sess-new']);
  });

  it('keeps the session when StrictMode remounts before the load resolves', async () => {
    const onSessionChange = vi.fn();
    const view = render(
      <StrictMode>
        <EngineerSitePreview defaultUrl="https://acme.example" autoLoad onSessionChange={onSessionChange} />
      </StrictMode>,
    );
    await flush();
    expect(posts()).toBe(1);

    await act(async () => {
      pendingPosts[0].resolve({ session_id: 'sess-1', live_view_url: 'https://live.anchor/one' });
    });
    await flush();

    expect(deleted()).toEqual([]);
    expect(onSessionChange).toHaveBeenLastCalledWith('sess-1');

    view.unmount();
    await flush();
    expect(deleted()).toEqual(['sess-1']);
  });

  it('closes a live session on unmount as before', async () => {
    const view = render(<EngineerSitePreview defaultUrl="https://acme.example" autoLoad />);
    await flush();
    await act(async () => {
      pendingPosts[0].resolve({ session_id: 'sess-live', live_view_url: 'https://live.anchor/live' });
    });
    await flush();
    expect(deleted()).toEqual([]);

    view.unmount();
    await flush();
    expect(deleted()).toEqual(['sess-live']);
  });
});
