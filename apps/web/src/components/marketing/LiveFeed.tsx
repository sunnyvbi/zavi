"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { apiUrl } from "@/lib/api";

type Event = { ts: string; agent_slug: string; verb: string };
type FeedCounts = { lifetime: number; day: number; hour: number; now: number };
type FeedPayload = {
  events: Event[];
  counts?: FeedCounts;
  lifetime_count?: number;
  window_24h_count?: number;
  generated_at: string;
};

const POLL_MS = 30_000;
const TICK_MS = 1_000;
const ROW_COUNT = 8;

const COLOR_BY_SLUG: Record<string, string> = {
  operator: "#fb923c",
  engineer: "#60a5fa",
  pm: "#c084fc",
  "chief-of-staff": "#2dd4bf",
  "performance-marketer": "#f87171",
  advisor: "#facc15",
  "growth-lead": "#f472b6",
  research: "#22d3ee",
  "dispute-response": "#fbbf24",
  "support-lead": "#4ade80",
  qa: "#a78bfa",
  "daily-brief": "#94a3b8",
};

function colorFor(slug: string): string {
  return COLOR_BY_SLUG[slug] ?? "#9ca3af";
}

function relTime(iso: string, now: number): string {
  const ts = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function LiveFeed() {
  const [payload, setPayload] = useState<FeedPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(apiUrl("/api/public/live-feed"), { cache: "no-store" });
        if (!res.ok) throw new Error(`http ${res.status}`);
        const j = (await res.json()) as FeedPayload;
        if (!cancelled) {
          setPayload(j);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "fetch failed");
      }
    }
    void load();
    const poll = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(tick);
  }, []);

  const rows = (payload?.events ?? []).slice(0, ROW_COUNT);
  const counts: FeedCounts = payload?.counts ?? {
    lifetime: payload?.lifetime_count ?? 0,
    day: payload?.window_24h_count ?? 0,
    hour: 0,
    now: 0,
  };

  const showSkeleton = payload === null && error === null;

  return (
    <div className="mx-auto w-full max-w-[680px] space-y-3">
      {}
      <CounterStrip counts={counts} loading={showSkeleton} />

      {}
      <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.4)]">
        {}
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-neutral-400">
              live · agents working
            </span>
          </div>
          <span className="font-mono text-[11px] text-neutral-500">
            {counts.day.toLocaleString()} runs · last 24h
          </span>
        </div>

        {}
        <div className="px-4 py-3" style={{ minHeight: `${ROW_COUNT * 32 + 12}px` }}>
          {showSkeleton ? (
            <SkeletonRows />
          ) : error ? (
            <ErrorRow message={error} />
          ) : rows.length === 0 ? (
            <EmptyRow />
          ) : (
            <AnimatePresence initial={false}>
              {rows.map((e, i) => (
                <motion.div
                  key={`${e.agent_slug}-${e.ts}-${i}`}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.35 }}
                  className="grid grid-cols-[72px_1fr] items-center gap-3 font-mono text-[13px] leading-[32px] text-neutral-300"
                >
                  <span className="text-neutral-500">{relTime(e.ts, now)}</span>
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: colorFor(e.agent_slug),
                        boxShadow: `0 0 8px ${colorFor(e.agent_slug)}66`,
                      }}
                    />
                    <span
                      className="shrink-0 font-semibold"
                      style={{ color: colorFor(e.agent_slug) }}
                    >
                      {e.agent_slug}
                    </span>
                    <span className="truncate text-neutral-300">{e.verb}</span>
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          )}
        </div>

        {}
        <div className="border-t border-neutral-800 px-4 py-3 text-center">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-neutral-500">
            ↓ {counts.lifetime.toLocaleString()} lifetime runs · trained on $1.2M of real operating data
          </span>
        </div>
      </div>
    </div>
  );
}

function CounterStrip({ counts, loading }: { counts: FeedCounts; loading: boolean }) {
  return (
    <div className="grid grid-cols-4 gap-2 rounded-2xl border border-neutral-200 bg-white/70 px-2 py-3 backdrop-blur-md">
      <CounterCell value={counts.lifetime} label="lifetime" loading={loading} />
      <CounterCell value={counts.day} label="last 24h" loading={loading} />
      <CounterCell value={counts.hour} label="last hour" loading={loading} />
      <CounterCell value={counts.now} label="right now" loading={loading} highlight={counts.now > 0} />
    </div>
  );
}

function CounterCell({
  value,
  label,
  loading,
  highlight,
}: {
  value: number;
  label: string;
  loading?: boolean;
  highlight?: boolean;
}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    const duration = 600;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <div className="flex flex-col items-center px-2">
      <span
        className={`font-mono text-[22px] font-semibold leading-[1] tracking-tight tabular-nums ${
          highlight ? "text-emerald-600" : "text-neutral-900"
        }`}
      >
        {loading ? "-" : display.toLocaleString()}
      </span>
      <span className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-neutral-500">
        {label}
      </span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2 py-1">
      {Array.from({ length: ROW_COUNT }).map((_, i) => (
        <div key={i} className="h-[24px] animate-pulse rounded bg-neutral-900" />
      ))}
    </div>
  );
}

function EmptyRow() {
  return (
    <div className="flex h-full items-center justify-center py-8 font-mono text-[12px] text-neutral-500">
      no public agent activity yet. Check back shortly
    </div>
  );
}

function ErrorRow({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center py-8 font-mono text-[12px] text-neutral-500">
      live feed unavailable · {message}
    </div>
  );
}
