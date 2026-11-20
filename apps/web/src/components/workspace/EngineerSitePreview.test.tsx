import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
  apiUrl: (p: string) => `https://api.zaviagent.com${p}`,
}));

import {
  EngineerSitePreview,
  previewShellClass,
  previewFrameStyle,
  PREVIEW_ASPECT,
} from './EngineerSitePreview';

describe('EngineerSitePreview', () => {
  it('renders the URL input + Load button, and no iframe, in the idle state', () => {
    const html = renderToStaticMarkup(<EngineerSitePreview />);
    expect(html).toContain('Load');
    expect(html).toContain('<input');
    expect(html).toContain('placeholder="https://your-app.com"');
    expect(html).not.toContain('<iframe');
  });

  it('pre-fills the URL box when a defaultUrl is provided', () => {
    const html = renderToStaticMarkup(
      <EngineerSitePreview defaultUrl="https://example.com" />,
    );
    expect(html).toContain('value="https://example.com"');
    expect(html).not.toContain('<iframe');
  });
});

describe('previewShellClass', () => {
  it('fills the pane inline (non-expanded)', () => {
    const cls = previewShellClass(false);
    expect(cls).toContain('flex-[1_1_auto]');
    expect(cls).not.toContain('flex-1 ');
    expect(cls).toContain('h-[calc(100dvh-330px)]');
    expect(cls).not.toContain('fixed');
  });

  it('becomes a full-viewport overlay above app chrome when expanded', () => {
    const cls = previewShellClass(true);
    expect(cls).toContain('fixed');
    expect(cls).toContain('inset-0');
    expect(cls).toContain('z-[100]');
  });

  it('changes ONLY the wrapper classes between states (no other coupling)', () => {
    expect(previewShellClass(true)).not.toEqual(previewShellClass(false));
  });
});

describe('previewFrameStyle', () => {
  it('falls back to a plain fill before the pane is measured', () => {
    expect(previewFrameStyle(0, 0)).toEqual({
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
    });
  });

  it('fills the full pane on BOTH axes (no bars, no overflow to scroll)', () => {
    const s = previewFrameStyle(1200, 600);
    expect(s.width).toBe(1200);
    expect(s.height).toBe(600);
    expect(s.left).toBe(0);
    expect(s.top).toBe(0);
  });

  it('never exceeds the pane height (so the host box never scrolls)', () => {
    const s = previewFrameStyle(1600, 500);
    expect(s.height).toBe(500);
    expect(s.width).toBe(1600);
  });

  it('never returns a scale transform (contain-fit letterbox regression guard)', () => {
    expect(previewFrameStyle(1200, 700).transform).toBeUndefined();
  });

  it('reference aspect stays 16:10 (matches the backend session viewport)', () => {
    expect(PREVIEW_ASPECT).toBeCloseTo(1.6, 5);
  });
});
