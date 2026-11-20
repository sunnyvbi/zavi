"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Registry = {
  report: (id: string, retry: (() => void) | null) => void;
  failed: ReadonlyArray<() => void>;
  reportCached: (id: string, at: number | null) => void;
  cachedAt: number | null;
};

const ChannelRefreshContext = createContext<Registry | null>(null);

export function ChannelRefreshProvider({ children }: { children: ReactNode }) {
  const [failed, setFailed] = useState<Readonly<Record<string, () => void>>>({});
  const report = useCallback((id: string, retry: (() => void) | null) => {
    setFailed((cur) => {
      if (retry) {
        if (cur[id] === retry) return cur;
        return { ...cur, [id]: retry };
      }
      if (!(id in cur)) return cur;
      const next = { ...cur };
      delete next[id];
      return next;
    });
  }, []);
  const [cached, setCached] = useState<Readonly<Record<string, number>>>({});
  const reportCached = useCallback((id: string, at: number | null) => {
    setCached((cur) => {
      if (at !== null) {
        if (cur[id] === at) return cur;
        return { ...cur, [id]: at };
      }
      if (!(id in cur)) return cur;
      const next = { ...cur };
      delete next[id];
      return next;
    });
  }, []);
  const value = useMemo(() => {
    const times = Object.values(cached);
    return {
      report,
      failed: Object.values(failed),
      reportCached,
      cachedAt: times.length > 0 ? Math.min(...times) : null,
    };
  }, [report, failed, reportCached, cached]);
  return <ChannelRefreshContext.Provider value={value}>{children}</ChannelRefreshContext.Provider>;
}

export function useChannelReadFailure(failed: boolean, retry: () => void): boolean {
  const host = useContext(ChannelRefreshContext);
  const report = host?.report;
  const id = useId();
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const stable = useCallback(() => retryRef.current(), []);
  useEffect(() => {
    report?.(id, failed ? stable : null);
  }, [report, id, failed, stable]);
  useEffect(() => () => report?.(id, null), [report, id]);
  return failed && !host;
}

export function useChannelReadCachedAt(at: number | null): boolean {
  const host = useContext(ChannelRefreshContext);
  const reportCached = host?.reportCached;
  const id = useId();
  useEffect(() => {
    reportCached?.(id, at);
  }, [reportCached, id, at]);
  useEffect(() => () => reportCached?.(id, null), [reportCached, id]);
  return at !== null && !host;
}

export function updatedAgo(at: number, now = Date.now()): string {
  const mins = Math.floor((now - at) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} h ago`;
}

export function ChannelCachedLine({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return (
    <p data-testid="channel-cached-line" className="mt-3 text-[13px] leading-5 text-inkMuted">
      Updated {updatedAgo(at, now)}
    </p>
  );
}

export function ChannelRefreshLine({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="status" data-testid="channel-refresh-line" className="mt-3 text-[13px] leading-5 text-inkMuted">
      Couldn&rsquo;t refresh just now.{" "}
      <button
        type="button"
        onClick={onRetry}
        className="font-medium text-ink underline underline-offset-2"
      >
        Try again
      </button>
    </p>
  );
}

export function ChannelRefreshNotice() {
  const host = useContext(ChannelRefreshContext);
  const cachedShown = useRef(false);
  if (host?.cachedAt != null) cachedShown.current = true;
  if (!host) return null;
  const retries = host.failed;
  return (
    <>
      {host.cachedAt !== null ? <ChannelCachedLine at={host.cachedAt} /> : cachedShown.current && (
        <p aria-hidden data-testid="channel-cached-slot" className="invisible mt-3 text-[13px] leading-5">&nbsp;</p>
      )}
      {retries.length > 0 && <ChannelRefreshLine onRetry={() => retries.forEach((r) => r())} />}
    </>
  );
}
