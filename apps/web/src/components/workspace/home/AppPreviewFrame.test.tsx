import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppPreviewFrame, PREVIEW_DEVICES, deviceFrameStyle } from './AppPreviewFrame';

vi.mock('@/lib/workspace/useAppReadiness', () => ({ useAppReadiness: () => ({ state: 'ready', retry: () => {} }) }));

describe('AppPreviewFrame', () => {
  it('renders nothing (no iframe) when there is no live url yet', () => {
    const html = renderToStaticMarkup(<AppPreviewFrame liveUrl={null} />);
    expect(html).toBe('');
    expect(html).not.toContain('<iframe');
  });

  it('renders an iframe pointing at the live url with a restrictive sandbox', () => {
    const html = renderToStaticMarkup(
      <AppPreviewFrame liveUrl="https://my-app.onrender.com" />,
    );
    expect(html).toContain('<iframe');
    expect(html).toContain('src="https://my-app.onrender.com"');
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-same-origin"');
    expect(html).toContain('title="Live preview of your app"');
    expect(html).toContain('href="https://my-app.onrender.com"');
    expect(html).toContain('Open in new tab');
  });

  it('cache-busts the iframe src when a cacheKey (redeploy timestamp) is given', () => {
    const html = renderToStaticMarkup(
      <AppPreviewFrame liveUrl="https://my-app.onrender.com" cacheKey="2026-05-30T00:00:00Z" />,
    );
    expect(html).toContain('_v=2026-05-30T00%3A00%3A00Z');
  });

  describe('device preview toggle', () => {
    it('exposes desktop (unconstrained), tablet 768 and mobile 375', () => {
      expect(PREVIEW_DEVICES.map((d) => [d.id, d.width])).toEqual([
        ['desktop', null],
        ['tablet', 768],
        ['mobile', 375],
      ]);
    });

    it('narrows the frame to the device width so the app’s own breakpoints fire', () => {
      expect(deviceFrameStyle('mobile')).toEqual({ maxWidth: '375px' });
      expect(deviceFrameStyle('tablet')).toEqual({ maxWidth: '768px' });
    });

    it('leaves the frame unconstrained on desktop (default render unchanged)', () => {
      expect(deviceFrameStyle('desktop')).toBeUndefined();
    });

    it('renders the three device controls with desktop pressed by default', () => {
      const html = renderToStaticMarkup(
        <AppPreviewFrame liveUrl="https://my-app.onrender.com" />,
      );
      expect(html).toContain('aria-label="Preview device"');
      expect(html).toContain('Desktop');
      expect(html).toContain('Tablet');
      expect(html).toContain('Mobile');
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
      expect(html).not.toContain('style="max-width');
    });

    it('keeps device out of the iframe src so switching viewport does not reload the app', () => {
      const html = renderToStaticMarkup(
        <AppPreviewFrame liveUrl="https://my-app.onrender.com" />,
      );
      expect(html).toContain('src="https://my-app.onrender.com"');
      expect(html).not.toContain('device=');
    });
  });
});
