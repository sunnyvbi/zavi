// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HtmlPreviewFrame } from './HtmlPreviewFrame';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch }));

describe('HtmlPreviewFrame artifact display receipt', () => {
  it('marks ready only after the private artifact loads into the sandboxed iframe', async () => {
    let resolveAcknowledgement: ((value: { ok: boolean }) => void) | undefined;
    const acknowledgement = new Promise<{ ok: boolean }>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    apiFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          state: 'html_preview_ready',
          html: '<h1>नमस्ते</h1>',
        }),
      })
      .mockReturnValueOnce(acknowledgement);
    const onReadyChange = vi.fn();
    const { container } = render(
      <HtmlPreviewFrame
        title="Preview"
        summary="Ready"
        previewId="550e8400-e29b-41d4-a716-446655440000"
        onReadyChange={onReadyChange}
      />,
    );

    const frame = await waitFor(() => {
      const element = container.querySelector('iframe');
      expect(element).not.toBeNull();
      return element as HTMLIFrameElement;
    });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(onReadyChange).not.toHaveBeenCalledWith(true);
    resolveAcknowledgement?.({ ok: true });
    await waitFor(() => expect(onReadyChange).toHaveBeenCalledWith(true));
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/workspace/engineer/html-preview/550e8400-e29b-41d4-a716-446655440000/displayed',
      { method: 'POST' },
    );
    expect(frame.getAttribute('sandbox')).toBe('');
  });

  it('keeps approval blocked when the artifact cannot be loaded', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false });
    const onReadyChange = vi.fn();
    const { findByText } = render(
      <HtmlPreviewFrame
        title="Preview"
        summary="Unavailable"
        previewId="550e8400-e29b-41d4-a716-446655440000"
        onReadyChange={onReadyChange}
      />,
    );

    await findByText(/build remains blocked/i);
    expect(onReadyChange).not.toHaveBeenCalledWith(true);
  });
});
