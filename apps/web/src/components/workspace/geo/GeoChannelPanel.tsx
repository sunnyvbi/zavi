"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, Gauge, Loader2, Play, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cx, FOCUS_RING } from "../layout/shared";
import {
  CardNote,
  CardSkeleton,
  CardTitle,
  ChecklistCard,
  CrawlerHitsCard,
  GEO_CARD,
  ProgressCard,
  ReadinessCard,
  SiteFilesCard,
  SourceMixCard,
  TopSourcesCard,
  VisibilityCard,
  VisibilityKpis,
} from "./cards";
import { fetchWindowFor, isLaneError, type CrawlerView } from "./derive";
import { GeoPromptSetup } from "./GeoPromptSetup";
import type {
  CrawlerHitsPanel,
  GeoMetricsPayload,
  ReadinessLane,
  VisibilityPanel,
} from "./types";

const POLL_MS = 6_000;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

async function apiMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return body?.error?.message ?? fallback;
}

type SweepProgress = { sweep_id: string; collected: number; planned: number };

function RunNowButton({
  disabled,
  running,
  busy,
  onRun,
}: {
  disabled: boolean;
  running: SweepProgress | null;
  busy: boolean;
  onRun: () => void;
}) {
  if (running) {
    return (
      <span
        aria-live="polite"
        className="inline-flex h-8 items-center gap-2 rounded-full border border-rule bg-white px-3.5 text-[13px] font-medium text-inkMuted"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        Sampling {running.collected} of {running.planned}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onRun}
      className={cx(
        "inline-flex h-8 shrink-0 items-center gap-2 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-cream hover:bg-inkSoft disabled:opacity-50",
        FOCUS_RING,
      )}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        <Play className="h-3.5 w-3.5" aria-hidden />
      )}
      Run now
    </button>
  );
}

function contextLine(v: VisibilityPanel): string {
  const country =
    v.config.countries.find((c) => c.country === v.country)?.label ?? v.country;
  const m = v.metrics;
  if (!m) return `${country} · last ${v.window_days} days`;
  return `${country} · last ${v.window_days} days · ${m.responses.collected.toLocaleString()} answers from ${m.responses.prompts} ${m.responses.prompts === 1 ? "prompt" : "prompts"}`;
}

function PromptsPanel({
  panel,
  autoStart,
  onChanged,
}: {
  panel: VisibilityPanel;
  autoStart: boolean;
  onChanged: () => void;
}) {
  return (
    <GeoPromptSetup brand={panel.config.brand} autoStart={autoStart} onChanged={onChanged} />
  );
}

function VisibilityStateNote({
  panel,
  onChanged,
}: {
  panel: VisibilityPanel;
  onChanged: () => void;
}) {
  if (panel.state === "ok") {
    if (panel.config.suggestions_pending > 0) {
      return (
        <div className={cx(GEO_CARD, "border-dashed py-3.5")}>
          <p className="text-[13px] font-semibold text-ink">
            {panel.config.suggestions_pending} suggested{" "}
            {panel.config.suggestions_pending === 1 ? "prompt is" : "prompts are"} waiting
          </p>
          <PromptsPanel panel={panel} autoStart={false} onChanged={onChanged} />
        </div>
      );
    }
    return null;
  }

  const copy: Record<Exclude<VisibilityPanel["state"], "ok">, { title: string; body: string }> = {
    not_configured: {
      title: "Sampling AI answers is not switched on yet",
      body: "Zavi asks ChatGPT, Claude, Gemini and Perplexity your buyers' questions and reads the answers. That runs on a provider Zavi has not enabled for this workspace. Readiness and crawler hits below do not depend on it.",
    },
    no_prompts: {
      title: "Zavi is starting your prompt set",
      body: "These are the unbranded questions a buyer types before they know which company to pick. Every rate above is measured over them. Zavi picks a first set from what it knows about the company; remove any that are wrong for you, and add your own.",
    },
    never_run: {
      title: "No answers sampled yet",
      body: "Run a sweep and Zavi asks your tracked prompts across the engines, then reads each answer for your brand and your sources.",
    },
    no_data_in_window: {
      title: `No sweep in the last ${panel.window_days} days`,
      body: "The rates above describe this window only. Run a sweep to put a fresh point on the line.",
    },
  };
  const c = copy[panel.state];
  return (
    <div className={cx(GEO_CARD, "border-dashed py-3.5")}>
      <p className="text-[13px] font-semibold text-ink">{c.title}</p>
      <p className="mt-1 text-[13px] leading-[1.5] text-inkMuted">{c.body}</p>
      {}
      {panel.state === "no_prompts" && (
        <PromptsPanel panel={panel} autoStart onChanged={onChanged} />
      )}
    </div>
  );
}

export function GeoChannelPanel({ fixes }: { fixes: ReactNode }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [data, setData] = useState<GeoMetricsPayload | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [view, setView] = useState<CrawlerView>(7);
  const [extended, setExtended] = useState<CrawlerHitsPanel | null>(null);
  const [sweep, setSweep] = useState<SweepProgress | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showPrompts, setShowPrompts] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/geo/metrics");
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      setData((await res.json()) as GeoMetricsPayload);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (fetchWindowFor(view) !== 90 || extended !== null) return;
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch("/api/geo/crawler-hits?days=90");
        if (!res.ok) return;
        const body = (await res.json()) as CrawlerHitsPanel;
        if (live) setExtended(body);
      } catch {
      }
    })();
    return () => {
      live = false;
    };
  }, [view, extended]);

  const visibility = data && !isLaneError(data.visibility) ? data.visibility : null;
  const readiness: ReadinessLane | null =
    data && !isLaneError(data.readiness) ? data.readiness : null;
  const crawler = data && !isLaneError(data.crawler_hits) ? data.crawler_hits : null;

  const inFlight = useMemo<SweepProgress | null>(
    () =>
      sweep ??
      (visibility?.running
        ? {
            sweep_id: visibility.running.sweep_id,
            collected: visibility.running.collected,
            planned: visibility.running.planned,
          }
        : null),
    [sweep, visibility],
  );

  const sweepId = inFlight?.sweep_id ?? null;
  useEffect(() => {
    if (!sweepId) return;
    let live = true;
    const tick = async () => {
      try {
        const res = await apiFetch(`/api/geo/sweeps/${sweepId}`);
        if (!res.ok || !live) return;
        const s = (await res.json()) as {
          status: string;
          collected: number;
          planned: number;
        };
        if (!live) return;
        if (s.status === "running") {
          setSweep({ sweep_id: sweepId, collected: s.collected, planned: s.planned });
        } else {
          setSweep(null);
          void load();
        }
      } catch {
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [sweepId, load]);

  const runNow = async () => {
    if (!visibility) return;
    setRunBusy(true);
    setRunError(null);
    try {
      const res = await apiFetch("/api/geo/sweeps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country: visibility.country }),
      });
      if (!res.ok) {
        setRunError(await apiMessage(res, "Zavi couldn't start a sweep just now."));
        return;
      }
      const body = (await res.json()) as { sweep_id: string; planned: number };
      setSweep({ sweep_id: body.sweep_id, collected: 0, planned: body.planned });
    } catch {
      setRunError("Zavi couldn't start a sweep just now.");
    } finally {
      setRunBusy(false);
    }
  };

  const cols = width === 0 ? 3 : width >= 780 ? 3 : width >= 520 ? 2 : 1;
  const grid = cols === 3 ? "grid-cols-3" : cols === 2 ? "grid-cols-2" : "grid-cols-1";
  const kpiGrid = width !== 0 && width < 520 ? "grid-cols-1" : "grid-cols-3";

  const loading = data === null && !loadFailed;

  return (
    <div ref={ref} className="flex flex-col gap-6">
      {}
      {visibility && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] leading-5 text-inkMuted">{contextLine(visibility)}</p>
          <div className="flex shrink-0 items-center gap-2">
            {}
            {visibility.config.prompts_active > 0 && (
              <button
                type="button"
                aria-expanded={showPrompts}
                onClick={() => setShowPrompts((v) => !v)}
                className={cx(
                  "inline-flex h-8 items-center gap-2 rounded-full border border-rule bg-white px-3.5 text-[13px] font-medium text-ink hover:bg-creamDeep",
                  FOCUS_RING,
                )}
              >
                {visibility.config.prompts_active}{" "}
                {visibility.config.prompts_active === 1 ? "prompt" : "prompts"}
              </button>
            )}
            <RunNowButton
              disabled={
                !visibility.config.configured ||
                !visibility.config.enabled ||
                visibility.config.prompts_active === 0
              }
              running={inFlight}
              busy={runBusy}
              onRun={() => void runNow()}
            />
          </div>
        </div>
      )}
      {visibility && showPrompts && visibility.config.prompts_active > 0 && (
        <div className={cx(GEO_CARD, "-mt-4 border-dashed py-3.5")}>
          <PromptsPanel panel={visibility} autoStart={false} onChanged={load} />
        </div>
      )}
      {runError && (
        <p role="alert" className="-mt-4 text-[13px] font-medium text-danger">
          {runError}
        </p>
      )}
      {loadFailed && (
        <div className={cx(GEO_CARD, "border-dashed py-3.5")}>
          <p className="text-[13px] font-semibold text-ink">Couldn&apos;t load the GEO numbers</p>
          <p className="mt-1 text-[13px] leading-[1.5] text-inkMuted">
            The fixes below are unaffected.{" "}
            <button
              type="button"
              onClick={() => void load()}
              className={cx("font-semibold underline hover:text-ink", FOCUS_RING)}
            >
              Try again
            </button>
          </p>
        </div>
      )}

      <div className={cx("grid gap-4", kpiGrid)}>
        {loading ? (
          <>
            <CardSkeleton className="min-h-[86px]" />
            <CardSkeleton className="min-h-[86px]" />
            <CardSkeleton className="min-h-[86px]" />
          </>
        ) : (
          <VisibilityKpis panel={visibility} />
        )}
      </div>

      {visibility && <VisibilityStateNote panel={visibility} onChanged={load} />}
      {}
      {data && isLaneError(data.visibility) && (
        <div className={cx(GEO_CARD, "border-dashed py-3.5")}>
          <p className="text-[13px] font-semibold text-ink">
            Couldn&apos;t read the sampled AI answers
          </p>
          <p className="mt-1 text-[13px] leading-[1.5] text-inkMuted">
            Mention rate, citation rate and share of voice are unavailable until that
            read works. Readiness and crawler hits do not depend on it.
          </p>
        </div>
      )}

      <div className={cx("grid items-start gap-4", grid)}>
        {loading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : (
          <>
            {crawler ? (
              <CrawlerHitsCard
                panel={view === 30 ? (extended ?? crawler) : crawler}
                view={view}
                onView={setView}
              />
            ) : (
              <section className={GEO_CARD} aria-label="AI crawler hits">
                <CardTitle icon={Bot}>AI crawler hits</CardTitle>
                <CardNote>Zavi couldn&apos;t read your crawler logs just now.</CardNote>
              </section>
            )}
            {visibility ? (
              <VisibilityCard panel={visibility} />
            ) : (
              <section className={GEO_CARD} aria-label="AI visibility">
                <CardTitle icon={Sparkles}>AI visibility</CardTitle>
                <CardNote>Zavi couldn&apos;t read the sampled answers just now.</CardNote>
              </section>
            )}
            {data && isLaneError(data.readiness) ? (
              <section className={GEO_CARD} aria-label="Readiness">
                <CardTitle icon={Gauge}>Readiness</CardTitle>
                <CardNote>Zavi couldn&apos;t read your site&apos;s readiness just now.</CardNote>
              </section>
            ) : (
              <ReadinessCard readiness={readiness} />
            )}
          </>
        )}
      </div>

      {fixes}

      <div className={cx("grid items-start gap-4", grid)}>
        {loading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : (
          <>
            {visibility && <ProgressCard panel={visibility} />}
            <ChecklistCard readiness={readiness} />
            <div className="flex flex-col gap-4">
              <SiteFilesCard readiness={readiness} />
              {visibility && <SourceMixCard panel={visibility} />}
              {visibility && <TopSourcesCard panel={visibility} />}
            </div>
          </>
        )}
      </div>

      {(visibility?.metrics || readiness || crawler) && (
        <details className="rounded-2xl border border-rule bg-white px-4 py-3">
          <summary className={cx("cursor-pointer text-[13px] font-semibold text-ink", FOCUS_RING)}>
            How these numbers are measured
          </summary>
          <ul className="mt-2 flex flex-col gap-2 text-[13px] leading-[1.5] text-inkMuted">
            {visibility?.metrics && <li>Mention, citation and share of voice: {visibility.metrics.disclosure}</li>}
            {readiness && <li>Readiness: {readiness.disclosure}</li>}
            {crawler && <li>AI crawler hits: {crawler.disclosure}</li>}
            {readiness && readiness.not_checked.length > 0 && (
              <li>
                Not checked on the last read:
                <ul className="mt-1 list-disc pl-4">
                  {readiness.not_checked.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}
