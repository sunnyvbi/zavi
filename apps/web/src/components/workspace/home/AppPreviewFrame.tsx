'use client';

import { useEffect, useRef, useState } from 'react';
import {
  originOf,
  parsePickedMessage,
  isPickerReadyMessage,
  PICKER_SET_TYPE,
  type PickedElement,
} from './previewPicker';
import { useAppReadiness } from '@/lib/workspace/useAppReadiness';
import {
  STILL_BUILDING_BODY,
  STILL_BUILDING_TITLE,
} from '@/lib/workspace/stillBuilding';

type AppPreviewFrameProps = {
  liveUrl: string | null;
  cacheKey?: string | null;
  tall?: boolean;
  onElementPicked?: (picked: PickedElement) => void;
  guardWhileBuilding?: boolean;
};

const LOAD_TIMEOUT_MS = 6000;

export type PreviewDevice = 'desktop' | 'tablet' | 'mobile';

export const PREVIEW_DEVICES: ReadonlyArray<{
  id: PreviewDevice;
  label: string;
  width: number | null;
}> = [
  { id: 'desktop', label: 'Desktop', width: null },
  { id: 'tablet', label: 'Tablet', width: 768 },
  { id: 'mobile', label: 'Mobile', width: 375 },
];

export function deviceFrameStyle(device: PreviewDevice): { maxWidth: string } | undefined {
  const width = PREVIEW_DEVICES.find((d) => d.id === device)?.width ?? null;
  return width === null ? undefined : { maxWidth: `${width}px` };
}

export function AppPreviewFrame({
  liveUrl,
  cacheKey,
  tall = false,
  onElementPicked,
  guardWhileBuilding = false,
}: AppPreviewFrameProps) {
  const [blocked, setBlocked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [pickerReady, setPickerReady] = useState(false);
  const [picking, setPicking] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readiness = useAppReadiness(liveUrl);
  const appReady = readiness.state === 'ready';
  const stillBuilding = guardWhileBuilding;

  useEffect(() => {
    if (!onElementPicked || !liveUrl) return;
    const expectedOrigin = originOf(liveUrl);
    if (!expectedOrigin) return;

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;

      if (isPickerReadyMessage(event.data, event.origin, expectedOrigin)) {
        setPickerReady(true);
        return;
      }

      const picked = parsePickedMessage(event.data, event.origin, expectedOrigin);
      if (picked) {
        onElementPicked(picked);
        setPicking(false);
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onElementPicked, liveUrl]);

  useEffect(() => {
    setPickerReady(false);
    setPicking(false);
  }, [liveUrl, cacheKey, nonce]);

  const togglePicking = () => {
    const expectedOrigin = originOf(liveUrl);
    const target = iframeRef.current?.contentWindow;
    if (!expectedOrigin || !target) return;
    const next = !picking;
    target.postMessage({ type: PICKER_SET_TYPE, enabled: next }, expectedOrigin);
    setPicking(next);
  };
  const loadedRef = useRef(false);
  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);

  useEffect(() => {
    setBlocked(false);
    setLoaded(false);
    loadedRef.current = false;
    if (!liveUrl || !appReady || stillBuilding) return;
    timerRef.current = setTimeout(() => {
      setBlocked((prev) => (prev ? prev : !loadedRef.current));
    }, LOAD_TIMEOUT_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveUrl, cacheKey, nonce, appReady, stillBuilding]);

  if (!liveUrl) {
    return null;
  }

  const src = cacheKey ? `${liveUrl}${liveUrl.includes('?') ? '&' : '?'}_v=${encodeURIComponent(cacheKey)}` : liveUrl;

  const refresh = () => {
    if (!appReady) readiness.retry();
    setNonce((n) => n + 1);
  };

  const frameStyle = deviceFrameStyle(device);

  return (
    <div className="mt-4 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 lg:shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-inkMuted">Live preview</span>
          <div
            className="flex items-center gap-0.5 rounded-full bg-[#f2f2f2] p-0.5"
            role="group"
            aria-label="Preview device"
          >
            {PREVIEW_DEVICES.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setDevice(d.id)}
                aria-pressed={device === d.id}
                className={
                  device === d.id
                    ? 'rounded-full bg-white px-2.5 py-1 text-xs font-medium text-ink shadow-sm'
                    : 'rounded-full px-2.5 py-1 text-xs font-medium text-inkSoft transition-colors hover:text-ink'
                }
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {}
          {onElementPicked && pickerReady && (
            <button
              type="button"
              onClick={togglePicking}
              aria-pressed={picking}
              className={
                picking
                  ? 'rounded-full bg-ink px-2.5 py-1 text-xs font-medium text-cream'
                  : 'text-xs font-medium text-inkSoft underline-offset-2 hover:text-ink hover:underline'
              }
            >
              {picking ? 'Click an element…' : 'Select element'}
            </button>
          )}
          <button
            type="button"
            onClick={refresh}
            className="text-xs font-medium text-inkSoft underline-offset-2 hover:text-ink hover:underline"
          >
            Refresh
          </button>
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-inkSoft underline-offset-2 hover:text-ink hover:underline"
          >
            Open in new tab
          </a>
        </div>
      </div>

      {stillBuilding ? (
        <div
          data-testid="preview-still-building"
          className="relative mx-auto w-full overflow-hidden rounded-lg border border-[#ececec] bg-white lg:min-h-0 lg:flex-1"
          style={frameStyle}
        >
          <div
            role="status"
            className={`${tall ? "h-[520px] w-full lg:h-full lg:min-h-[320px]" : "h-[420px] w-full"} flex flex-col items-center justify-center gap-2 px-6 text-center`}
          >
            <p className="text-sm font-semibold text-ink">{STILL_BUILDING_TITLE}</p>
            <p className="max-w-[360px] text-sm text-inkMuted">{STILL_BUILDING_BODY}</p>
          </div>
        </div>
      ) : blocked ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-[#ececec] bg-[#f9f9f9] p-4 lg:min-h-0 lg:flex-1">
          <p className="text-base text-inkMuted">
            This app can&rsquo;t be shown inline (it blocks embedding). Open it in a new tab to view it.
          </p>
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-cream transition-colors hover:bg-inkSoft"
          >
            Open your app
          </a>
        </div>
      ) : !appReady ? (
        <div
          data-testid="preview-readiness-gate"
          className="relative mx-auto w-full overflow-hidden rounded-lg border border-[#ececec] bg-white transition-[max-width] duration-200 lg:min-h-0 lg:flex-1"
          style={frameStyle}
        >
          <div
            className={`${tall ? "h-[520px] w-full lg:h-full lg:min-h-[320px]" : "h-[420px] w-full"} flex items-center justify-center px-6`}
          >
            {readiness.state === 'checking' ? (
              <div role="status" className="flex flex-col items-center gap-3">
                <div className="h-4 w-24 animate-pulse rounded bg-[#ececec]" />
                <p className="text-xs font-medium text-inkMuted">Starting up your app…</p>
              </div>
            ) : (
              <div role="status" className="flex max-w-[360px] flex-col items-center gap-2 text-center">
                {readiness.state === 'suspended' && (
                  <p className="text-sm font-semibold text-ink">This app is paused</p>
                )}
                <p className="text-sm text-inkMuted">
                  {readiness.state === 'suspended'
                    ? 'It isn’t taking visitors right now, so there’s nothing to preview. Check again once it’s back on.'
                    : 'Your app is taking longer than usual to start. Open it in a new tab, or try again.'}
                </p>
                <div className="mt-1 flex items-center gap-3">
                  <a
                    href={liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-cream transition-colors hover:bg-inkSoft"
                  >
                    Open your app
                  </a>
                  <button
                    type="button"
                    onClick={readiness.retry}
                    className="text-xs font-medium text-inkSoft underline-offset-2 hover:text-ink hover:underline"
                  >
                    Try again
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          className="relative mx-auto w-full overflow-hidden rounded-lg border border-[#ececec] bg-white transition-[max-width] duration-200 lg:min-h-0 lg:flex-1"
          style={frameStyle}
        >
          {!loaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-white">
              <div className="h-4 w-24 animate-pulse rounded bg-[#ececec]" />
            </div>
          )}
          <iframe
            ref={iframeRef}
            key={`${src}#${nonce}`}
            src={src}
            title="Live preview of your app"
            sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
            referrerPolicy="no-referrer"
            loading="lazy"
            className={tall ? "h-[520px] w-full lg:h-full lg:min-h-[320px]" : "h-[420px] w-full"}
            onLoad={() => {
              setLoaded(true);
              setBlocked(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
