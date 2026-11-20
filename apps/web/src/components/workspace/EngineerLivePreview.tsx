'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, apiUrl } from '@/lib/api';
import { AppPreviewFrame } from './home/AppPreviewFrame';
import {
  previewPanelState,
  pollIntervalFor,
  type PreviewPanel,
  type PreviewOutcome,
  type PreviewStatusResponse,
} from './previewPanelState';

type Props = {
  runId: string;
};

type LiveState = {
  proxyUrl: string;
  path: string | null;
  outcome: PreviewOutcome | null;
};

export function EngineerLivePreview({ runId }: Props) {
  const [panel, setPanel] = useState<PreviewPanel>({ kind: 'hidden' });
  const [restarting, setRestarting] = useState(false);

  const panelRef = useRef<PreviewPanel>(panel);
  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);

  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pollOnce = useCallback(async (): Promise<void> => {
    try {
      const res = await apiFetch(
        `/api/workspace/engineer-preview/${encodeURIComponent(runId)}/status`,
      );
      if (cancelledRef.current || !res.ok) return;
      const data = (await res.json()) as PreviewStatusResponse;
      const next = previewPanelState(data);
      setPanel(
        next.kind === 'live' ? { ...next, proxyUrl: apiUrl(next.proxyUrl) } : next,
      );
    } catch {
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    cancelledRef.current = false;

    const loop = async () => {
      await pollOnce();
      if (cancelledRef.current) return;
      timerRef.current = setTimeout(loop, pollIntervalFor(panelRef.current));
    };
    void loop();

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [runId, pollOnce]);

  const restart = useCallback(async () => {
    if (restarting) return;
    setRestarting(true);
    setPanel({ kind: 'starting' });
    try {
      await apiFetch(
        `/api/workspace/engineer-preview/${encodeURIComponent(runId)}/restart`,
        { method: 'POST' },
      );
    } catch {
    } finally {
      setRestarting(false);
      void pollOnce();
    }
  }, [runId, restarting, pollOnce]);

  if (panel.kind === 'hidden') return null;

  if (panel.kind === 'live') {
    return (
      <EngineerPreviewBody
        live={{ proxyUrl: panel.proxyUrl, path: panel.path, outcome: panel.outcome }}
      />
    );
  }

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-inkMuted">Live preview</span>
      </div>
      <div className="flex flex-col items-start gap-2 rounded-lg border border-[#ececec] bg-[#f9f9f9] p-4">
        {panel.kind === 'starting' ? (
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#d4d4d4] border-t-ink" />
            <p className="text-base text-inkMuted">Building preview&hellip;</p>
          </div>
        ) : (
          <>
            <p className="text-base text-inkMuted">{panel.reason}</p>
            {panel.canRestart && (
              <button
                type="button"
                onClick={restart}
                disabled={restarting}
                className="inline-flex items-center rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-cream transition-colors hover:bg-inkSoft disabled:opacity-50"
              >
                Restart preview
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function EngineerPreviewBody({ live }: { live: LiveState }) {
  if (live.outcome === 'off_target') {
    return (
      <div className="mt-4">
        <div className="mb-2 text-xs font-medium text-inkMuted">Live preview</div>
        <div className="flex flex-col items-start gap-2 rounded-lg border border-[#ececec] bg-[#f9f9f9] p-4">
          {}
          <p className="text-base text-inkMuted">
            We couldn&rsquo;t verify this preview is showing the screen this PR changes
            {live.path ? <> (<code className="text-xs">{live.path}</code>)</> : null}. Previews run
            without your app&rsquo;s credentials, so signed-in screens won&rsquo;t render. Review
            the diff above instead.
          </p>
        </div>
      </div>
    );
  }

  const caption =
    live.outcome === 'on_target' && live.path ? (
      <>
        Showing <code className="text-xs">{live.path}</code>: read-only render, clicks are
        disabled.
      </>
    ) : (
      <>Showing your app&rsquo;s home page. This change doesn&rsquo;t map to a single screen.</>
    );

  return (
    <div>
      <AppPreviewFrame liveUrl={live.proxyUrl} />
      <p className="mt-1 text-xs text-inkMuted">{caption}</p>
    </div>
  );
}
