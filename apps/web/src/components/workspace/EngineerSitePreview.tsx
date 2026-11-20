'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';

type PreviewSessionResponse = {
  session_id?: string;
  live_view_url?: string;
  status?: string;
  error?: { code?: string; message?: string };
};

function errorCopy(code: string | undefined, httpStatus: number): string {
  if (code === 'anchor_budget_exceeded' || httpStatus === 429) {
    return 'The live-preview browser budget is used up for now. Try again later.';
  }
  if (code === 'anchor_not_configured' || httpStatus === 503) {
    return 'Live preview isn’t fully configured for this workspace yet.';
  }
  if (code === 'bad_url' || httpStatus === 400) {
    return "That URL doesn't look loadable. Check it and try again.";
  }
  return "We couldn't start a preview for that URL. Check it and try again.";
}

type Phase = 'idle' | 'loading' | 'live' | 'disabled' | 'error';

type Props = {
  defaultUrl?: string;
  autoLoad?: boolean;
  title?: string;
  description?: string;
  onLoadedUrl?: (url: string) => void;
  onSessionChange?: (id: string | null) => void;
};

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export function previewShellClass(expanded: boolean): string {
  return expanded
    ? 'fixed inset-0 z-[100] flex flex-col overflow-hidden bg-white'
    : 'mt-4 flex h-[calc(100dvh-330px)] min-h-[400px] flex-[1_1_auto] flex-col overflow-hidden rounded-2xl border border-[#f0f0f0] bg-white';
}

export const PREVIEW_ASPECT = 1600 / 1000;

export function previewFrameStyle(
  paneWidth: number,
  paneHeight: number,
): React.CSSProperties {
  if (paneWidth <= 0 || paneHeight <= 0) {
    return { position: 'absolute', inset: 0, width: '100%', height: '100%' };
  }
  return {
    position: 'absolute',
    left: 0,
    top: 0,
    width: Math.round(paneWidth),
    height: Math.round(paneHeight),
  };
}

function closePreviewSession(id: string): void {
  void apiFetch(`/api/workspace/engineer/preview-session/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    keepalive: true,
  }).catch(() => {
  });
}

export function EngineerSitePreview({
  defaultUrl,
  autoLoad,
  title = 'Live site preview',
  description = 'Load your site in a live browser so the engineer can see it alongside the chat. Log in and click around. When you send a message, the engineer sees the page you’re on. Enter a URL and hit Load.',
  onLoadedUrl,
  onSessionChange,
}: Props) {
  const [url, setUrl] = useState(defaultUrl ?? '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded]);
  const [liveViewUrl, setLiveViewUrl] = useState<string | null>(null);
  const [frameBox, setFrameBox] = useState({ width: 0, height: 0 });
  const frameBoxObserverRef = useRef<ResizeObserver | null>(null);
  const frameHostRef = useCallback((node: HTMLDivElement | null) => {
    frameBoxObserverRef.current?.disconnect();
    frameBoxObserverRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setFrameBox({ width: r.width, height: r.height });
    });
    ro.observe(node);
    frameBoxObserverRef.current = ro;
  }, []);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    onSessionChange?.(sessionId);
  }, [sessionId, onSessionChange]);
  const mountedRef = useRef(false);
  const loadGenRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onSessionChange?.(null);
      if (sessionIdRef.current) closePreviewSession(sessionIdRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    const target = normalizeUrl(url);
    if (!target) return;
    const gen = ++loadGenRef.current;
    setPhase('loading');
    setErrorMsg(null);
    setLiveViewUrl(null);
    setFrameLoaded(false);
    setExpanded(false);
    if (sessionIdRef.current) closePreviewSession(sessionIdRef.current);
    setSessionId(null);
    try {
      const res = await apiFetch('/api/workspace/engineer/preview-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
        idempotent: true,
      });
      const data = (await res
        .json()
        .catch(() => ({}))) as PreviewSessionResponse;
      if (!mountedRef.current || gen !== loadGenRef.current) {
        if (data.session_id) closePreviewSession(data.session_id);
        return;
      }

      if (data.status === 'disabled' || res.status === 403) {
        setPhase('disabled');
        return;
      }
      if (res.ok && data.live_view_url) {
        setLiveViewUrl(data.live_view_url);
        setLoadedUrl(target);
        setSessionId(data.session_id ?? null);
        setPhase('live');
        onLoadedUrl?.(target);
        return;
      }
      setPhase('error');
      setErrorMsg(errorCopy(data.error?.code, res.status));
    } catch {
      if (!mountedRef.current || gen !== loadGenRef.current) return;
      setPhase('error');
      setErrorMsg('Something went wrong reaching the preview service. Try again.');
    }
  }, [url, onLoadedUrl]);

  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!autoLoad || autoLoadedRef.current) return;
    if (!(defaultUrl ?? '').trim()) return;
    autoLoadedRef.current = true;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad, defaultUrl]);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void load();
    },
    [load],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div>
        <h2 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">{title}</h2>
        <p className="mt-1 max-w-[640px] text-[13px] leading-5 text-[#595959]">
          {description}
        </p>
      </div>

      {}
      <form onSubmit={onSubmit} className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex h-10 min-w-[240px] flex-1 items-center gap-2 rounded-xl border border-[#f0f0f0] bg-white px-3 transition-colors focus-within:border-ink/30">
          <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-[#595959]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.6 3.75 5.6 3.75 9S14.5 18.4 12 21c-2.5-2.6-3.75-5.6-3.75-9S9.5 5.6 12 3Z" />
          </svg>
          <input
            type="text"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-app.com"
            aria-label="Site URL to preview"
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-[#0e0f11] outline-none placeholder:text-[#8c8c8c]"
          />
        </div>
        <button
          type="submit"
          disabled={phase === 'loading' || url.trim().length === 0}
          className="inline-flex h-10 shrink-0 items-center rounded-cta bg-[#0e0f11] px-4 text-[16px] font-semibold text-white transition-colors hover:bg-[#0e0f11]/85 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {phase === 'loading' ? 'Loading…' : 'Load'}
        </button>
      </form>

      {phase === 'loading' && (
        <div className="mt-4 flex h-[calc(100dvh-330px)] min-h-[400px] flex-[1_1_auto] flex-col items-center justify-center gap-3 rounded-2xl border border-[#f0f0f0] bg-white">
          <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6 animate-spin text-[#8c8c8c]" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M21 12a9 9 0 1 1-6.2-8.55" />
          </svg>
          <p className="text-[13px] text-[#595959]">Opening a live browser on your site…</p>
        </div>
      )}

      {phase === 'disabled' && (
        <div className="mt-4 rounded-2xl border border-[#f0f0f0] bg-[#f9f9f9] p-4">
          <p className="text-[13px] text-[#595959]">
            Live site preview is turned off for your workspace. Ask us to enable it
            if you&rsquo;d like to try it.
          </p>
        </div>
      )}

      {phase === 'error' && errorMsg && (
        <div
          role="alert"
          className="mt-4 rounded-2xl border border-[#f3d0d2] bg-[#fbeaeb] p-4"
        >
          <p className="text-[13px] text-[#cb2029]">{errorMsg}</p>
        </div>
      )}

      {phase === 'live' && liveViewUrl && (
        <div className={previewShellClass(expanded)}>
          {}
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[#f0f0f0] bg-[#f9f9f9] px-3">
            <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden>
              <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span
              className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#454545]"
              title={loadedUrl ?? undefined}
            >
              {loadedUrl}
            </span>
            <button
              type="button"
              onClick={() => {
                setFrameLoaded(false);
                setNonce((n) => n + 1);
              }}
              title="Refresh preview"
              aria-label="Refresh preview"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta border border-[#f0f0f0] bg-white text-[#1f1f1f] transition-colors hover:bg-[#f0f0f0]"
            >
              <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
              </svg>
            </button>
            <a
              href={liveViewUrl}
              target="_blank"
              rel="noreferrer"
              title="Open in new tab"
              aria-label="Open preview in new tab"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-[#f0f0f0] bg-white text-[#1f1f1f] transition-colors hover:bg-[#f0f0f0]"
            >
              <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M21 3l-9 9M9 21H3v-6" />
              </svg>
            </a>
            {}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? 'Exit full screen (Esc)' : 'View full screen'}
              aria-label={expanded ? 'Exit full screen' : 'View full screen'}
              aria-expanded={expanded}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta border border-[#f0f0f0] bg-white text-[#1f1f1f] transition-colors hover:bg-[#f0f0f0]"
            >
              {expanded ? (
                <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 3l-7 7M14 10h5.5M14 10V4.5M3 21l7-7M10 14H4.5M10 14v5.5" />
                </svg>
              ) : (
                <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 3L3 21M21 3h-5.5M21 3v5.5M3 21h5.5M3 21v-5.5" />
                </svg>
              )}
            </button>
          </div>
          {}
          <div
            ref={frameHostRef}
            className="relative min-h-0 flex-1 overflow-hidden bg-white"
          >
            {!frameLoaded && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-white">
                <div className="h-4 w-24 animate-pulse rounded bg-[#f0f0f0]" />
              </div>
            )}
            <iframe
              key={`${liveViewUrl}#${nonce}`}
              src={liveViewUrl}
              title="Live preview of your site"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
              allow="clipboard-read; clipboard-write"
              referrerPolicy="no-referrer"
              style={previewFrameStyle(frameBox.width, frameBox.height)}
              onLoad={() => setFrameLoaded(true)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
