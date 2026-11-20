import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ status: 'none' }) })),
  apiUrl: (p: string) => `https://api.zaviagent.com${p}`,
}));

import { EngineerLivePreview, EngineerPreviewBody } from './EngineerLivePreview';

describe('EngineerLivePreview', () => {
  it('renders nothing before a live preview exists (inert by default)', () => {
    const html = renderToStaticMarkup(<EngineerLivePreview runId="run-1" />);
    expect(html).toBe('');
    expect(html).not.toContain('<iframe');
  });
});

const PROXY = '/api/workspace/engineer-preview/run-1/tutor/bookings?__pt=tok';

describe('EngineerPreviewBody — on_target (we PROVED this is the changed screen)', () => {
  const live = { proxyUrl: PROXY, path: '/tutor/bookings', outcome: 'on_target' as const };

  it('renders the iframe', () => {
    const html = renderToStaticMarkup(<EngineerPreviewBody live={live} />);
    expect(html).toContain('<iframe');
  });

  it('names the route, so the operator can check the claim themselves', () => {
    const html = renderToStaticMarkup(<EngineerPreviewBody live={live} />);
    expect(html).toContain('/tutor/bookings');
    expect(html).toMatch(/showing/i);
  });

  it('states clicks are disabled — under the CSP sandbox the frame really is inert', () => {
    const html = renderToStaticMarkup(<EngineerPreviewBody live={live} />);
    expect(html).toMatch(/read-only render/i);
    expect(html).toMatch(/clicks are\s+disabled/i);
  });
});

describe('EngineerPreviewBody — off_target (we could NOT prove it)', () => {
  const live = { proxyUrl: PROXY, path: '/tutor/bookings', outcome: 'off_target' as const };

  it('renders NO iframe — never show a page we cannot vouch for', () => {
    const html = renderToStaticMarkup(<EngineerPreviewBody live={live} />);
    expect(html).not.toContain('<iframe');
  });

  it('says we could not VERIFY it, without asserting a cause we do not know', () => {
    const html = renderToStaticMarkup(<EngineerPreviewBody live={live} />);
    expect(html).toMatch(/couldn(&#x27;|’|')t verify/i);
    expect(html).not.toMatch(/needs a signed-in/i);
    expect(html).not.toMatch(/requires a login/i);
  });

  it('points at the diff already rendered above, not a CTA we never render', () => {
    const html = renderToStaticMarkup(<EngineerPreviewBody live={live} />);
    expect(html).toMatch(/review\s+the diff above/i);
    expect(html).not.toContain('<a ');
  });
});

describe('EngineerPreviewBody — null outcome (no single route to open)', () => {
  const live = {
    proxyUrl: '/api/workspace/engineer-preview/run-1/?__pt=tok',
    path: null,
    outcome: null,
  };

  it('STILL renders the root iframe — a route-less diff is not a failure', () => {
    const html = renderToStaticMarkup(<EngineerPreviewBody live={live} />);
    expect(html).toContain('<iframe');
  });

  it('labels it as the home page rather than implying it is the changed screen', () => {
    const html = renderToStaticMarkup(<EngineerPreviewBody live={live} />);
    expect(html).toMatch(/home page/i);
    expect(html).toMatch(/doesn(&#x27;|’|')t map to a single screen/i);
  });

  it('does NOT show the off_target failure copy', () => {
    const html = renderToStaticMarkup(<EngineerPreviewBody live={live} />);
    expect(html).not.toMatch(/couldn(&#x27;|’|')t verify/i);
  });
});
