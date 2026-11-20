"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BookOpen, CheckCircle2, ListChecks, Loader2, Search, Sparkles, Telescope } from "lucide-react";
import {
  useAgentDashboard,
  DashboardShell,
  btn,
  num,
} from "./dashboard-ui";
import { apiFetch } from "@/lib/api";
import { useAgentRun } from "@/lib/workspace/useAgentRun";
import { InlineStatusRow } from "../InlineStatusRow";
import {
  BackLink,
  Btn,
  Lnk,
  InvestorReadView,
  Monogram,
  OutreachPlanView,
  StatusPill,
} from "./FundraisingInvestorViews";
import {
  FundraisingStageSwitcher,
  isStage,
  roundWithArticle,
  type Stage,
} from "./FundraisingStageSwitcher";
import {
  applyStatusOverride,
  computeNextStep,
  deepRoundFailureShort,
  hasNamedPartner,
  investorKey,
  investorStatus,
  investorWriteKey,
  listCounts,
  pickForDeepRound,
  splitTiers,
  tierLabel,
  type DeepRoundFailure as DeepFailure,
  type FundraisingInvestor,
  type InvestorStatus,
  type OutreachChannel,
} from "./fundraising-dashboard-util";
import { NextChevron } from "@/components/ui/NextChevron";

const SLUG = "fundraising";

const PER_TIER = 8;

const DEEP_POLL_MS = 5000;

const SETTLE_TICKS = 3;

const MAX_POLL_MISSES = 12;

type MergeSummary = {
  added: number;
  already_saved: number;
  dropped: string[];
};

type Payload = {
  generic?: boolean;
  latest: {
    run_id: string;
    generated_at: string | null;
    investors: FundraisingInvestor[];
    merge?: MergeSummary | null;
  } | null;
  round_config?: { stage?: string | null } | null;
  coverage?: {
    total: number;
  };
  deep_in_flight?: Array<{ identity_key: string; run_id: string }>;
};

async function post(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function persistStatus(
  investorId: string,
  status: InvestorStatus,
  channel?: OutreachChannel,
): Promise<boolean> {
  if (status === "reached out") {
    if (!channel) return false;
    return await post("/api/fundraising/outreach-sent", {
      investor_id: investorId,
      channel,
    });
  }
  if (status === "replied") {
    return await post("/api/fundraising/outreach-replied", {
      investor_id: investorId,
      replied: true,
    });
  }
  if (status === "passed") {
    return await post("/api/fundraising/review-state", {
      investor_id: investorId,
      state: "removed",
    });
  }
  const clearedReplied = await post("/api/fundraising/outreach-replied", {
    investor_id: investorId,
    replied: false,
  });
  const clearedReview = await post("/api/fundraising/review-state", {
    investor_id: investorId,
    state: "undecided",
  });
  return clearedReplied && clearedReview;
}

async function dispatchDeepRound(
  inv: FundraisingInvestor,
): Promise<string | null> {
  try {
    const res = await apiFetch(`/api/agents/${SLUG}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "deep",
        deep: {
          firm: inv.firm,
          name: inv.name,
          identity_key: investorWriteKey(inv),
          source_url: inv.source_url,
        },
      }),
      idempotent: true,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { run_id?: string };
    return body.run_id ?? null;
  } catch {
    return null;
  }
}

type StatTone = "ink" | "amber" | "emerald" | "blue";

const STAT_DOT: Record<StatTone, string> = {
  ink: "bg-ink",
  amber: "bg-amber-500",
  emerald: "bg-emerald-500",
  blue: "bg-blue-500",
};

function Stat({
  n,
  label,
  tone,
  muted,
}: {
  n: number;
  label: string;
  tone: StatTone;
  muted?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-rule bg-cream px-3 py-1 tabular-nums ${
        muted ? "text-inkLight" : "text-inkSoft"
      }`}
    >
      <i
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 rounded-full ${muted ? "bg-inkLight/50" : STAT_DOT[tone]}`}
      />
      <b className={muted ? "font-medium" : "font-semibold text-ink"}>{num(n)}</b>{" "}
      {label}
    </span>
  );
}

export function FundraisingDashboard() {
  const state = useAgentDashboard<Payload>(SLUG);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold leading-7 tracking-tight text-ink">
            Fundraising
          </h2>
          <p className="mt-0.5 text-[16px] text-inkMuted">
            Your investor list, and the one thing worth doing next.
          </p>
        </div>
        <button
          type="button"
          onClick={state.refresh}
          disabled={state.refreshing}
          className={`${btn.secondary} shrink-0`}
        >
          {state.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    <DashboardShell
      state={state}
      getActiveRun={() => null}
      genericFallback={
        <EmptyNote title="No investors saved yet.">
          Ask the Fundraising agent in chat for investors, or describe who you
          want in plain English once a list exists.
        </EmptyNote>
      }
      render={(d) => <FundraisingBody d={d} refresh={state.refresh} />}
    />
    </div>
  );
}

function EmptyNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-inkMuted/30 bg-cream px-6 py-8 text-center">
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-[16px] leading-5 text-inkMuted">{children}</p>
    </div>
  );
}

type View = { kind: "list" } | { kind: "investor"; key: string } | { kind: "plan" };

type DeepJob = {
  key: string;
  runId: string;
  phase: "running" | "settling";
  ticks: number;
  misses: number;
};

function FundraisingBody({
  d,
  refresh,
}: {
  d: Payload;
  refresh: () => void;
}) {
  const raw = useMemo(() => d.latest?.investors ?? [], [d.latest]);

  const [view, setView] = useState<View>({ kind: "list" });
  const [jobs, setJobs] = useState<DeepJob[]>([]);
  const [failures, setFailures] = useState<Record<string, DeepFailure>>({});
  const [overrides, setOverrides] = useState<Record<string, InvestorStatus>>({});
  const overridesRef = useRef<Record<string, InvestorStatus>>({});
  useEffect(() => {
    overridesRef.current = overrides;
  }, [overrides]);
  const [expanded, setExpanded] = useState<Record<1 | 2 | 3, boolean>>({
    1: false,
    2: false,
    3: false,
  });
  const [planOpened, setPlanOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [refineRunId, setRefineRunId] = useState<string | null>(null);
  const [refineBaseline, setRefineBaseline] = useState<number | null>(null);
  const [showDropped, setShowDropped] = useState(false);

  const { send } = useAgentRun();

  const investors = useMemo(() => {
    if (Object.keys(overrides).length === 0) return raw;
    const now = new Date().toISOString();
    return raw.map((inv) => {
      const k = investorWriteKey(inv);
      const ov = k ? overrides[k] : undefined;
      return ov ? applyStatusOverride(inv, ov, now) : inv;
    });
  }, [raw, overrides]);

  useEffect(() => {
    setOverrides((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const next: Record<string, InvestorStatus> = {};
      let changed = false;
      for (const inv of raw) {
        const k = investorWriteKey(inv);
        if (!k || !(k in prev)) continue;
        if (investorStatus(inv) === prev[k]) changed = true;
        else next[k] = prev[k];
      }
      if (Object.keys(next).length !== keys.length) changed = true;
      return changed ? next : prev;
    });
  }, [raw]);

  const serverInFlight = d.deep_in_flight;
  useEffect(() => {
    if (!serverInFlight || serverInFlight.length === 0) return;
    setJobs((prev) => {
      const known = new Set(prev.map((j) => j.key));
      const add = serverInFlight
        .filter((r) => r.identity_key && r.run_id && !known.has(r.identity_key))
        .map((r) => ({
          key: r.identity_key,
          runId: r.run_id,
          phase: "running" as const,
          ticks: 0,
          misses: 0,
        }));
      return add.length === 0 ? prev : [...prev, ...add];
    });
  }, [serverInFlight]);

  const researching = useMemo(
    () => new Set(jobs.map((j) => j.key)),
    [jobs],
  );

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const jobsRef = useRef<DeepJob[]>(jobs);
  jobsRef.current = jobs;
  const postingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const live = new Set(jobs.map((j) => j.key));
    for (const k of Array.from(postingRef.current)) {
      if (live.has(k)) postingRef.current.delete(k);
    }
  }, [jobs]);

  const anyJobs = jobs.length > 0;
  useEffect(() => {
    if (!anyJobs) return;
    let cancelled = false;
    const id = setInterval(async () => {
      const current = jobsRef.current;
      if (current.length === 0) return;
      const drop = new Map<string, DeepFailure | null>();
      const toSettling = new Set<string>();
      const read = new Set<string>();
      const missed = new Set<string>();

      await Promise.all(
        current.map(async (job) => {
          if (job.phase !== "running") return;
          try {
            const res = await apiFetch(
              `/api/agents/runs/${encodeURIComponent(job.runId)}`,
            );
            if (!res.ok) {
              missed.add(job.key);
              return;
            }
            const body = (await res.json()) as {
              run?: { status?: string } | null;
            };
            const s = body.run?.status ?? "";
            if (s) read.add(job.key);
            else missed.add(job.key);
            if (!s || s === "queued" || s === "running") return;
            if (s === "success") toSettling.add(job.key);
            else drop.set(job.key, "run_failed");
          } catch {
            missed.add(job.key);
          }
        }),
      );

      for (const job of current) {
        if (job.phase !== "settling") continue;
        if (job.ticks + 1 >= SETTLE_TICKS) drop.set(job.key, "no_dossier");
      }

      for (const job of current) {
        if (!missed.has(job.key)) continue;
        if (job.misses + 1 >= MAX_POLL_MISSES) drop.set(job.key, "no_dossier");
      }

      if (cancelled) return;
      const verdicts = Array.from(drop).filter(
        (e): e is [string, DeepFailure] => e[1] !== null,
      );
      if (verdicts.length > 0) {
        setFailures((prev) => ({ ...prev, ...Object.fromEntries(verdicts) }));
      }
      const settlingNow =
        toSettling.size > 0 || current.some((j) => j.phase === "settling");
      if (drop.size > 0 || settlingNow || missed.size > 0 || read.size > 0) {
        setJobs((prev) =>
          prev.flatMap((j) => {
            if (drop.has(j.key)) return [];
            const misses = read.has(j.key)
              ? 0
              : missed.has(j.key)
                ? j.misses + 1
                : j.misses;
            if (toSettling.has(j.key))
              return [{ ...j, phase: "settling" as const, ticks: 0, misses }];
            if (j.phase === "settling")
              return [{ ...j, ticks: j.ticks + 1, misses }];
            return [{ ...j, misses }];
          }),
        );
      }
      if (settlingNow) refreshRef.current();
    }, DEEP_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [anyJobs]);

  useEffect(() => {
    const done = new Set(
      raw.filter((i) => i.dossier).map((i) => investorKey(i)),
    );
    if (done.size === 0) return;
    setJobs((prev) => {
      const next = prev.filter((j) => !done.has(j.key));
      return next.length === prev.length ? prev : next;
    });
    setFailures((prev) => {
      const keys = Object.keys(prev).filter((k) => done.has(k));
      if (keys.length === 0) return prev;
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  }, [raw]);

  const startDeepRound = useCallback(
    async (targets: FundraisingInvestor[]) => {
      for (const inv of targets) {
        const key = investorKey(inv);
        if (
          postingRef.current.has(key) ||
          jobsRef.current.some((j) => j.key === key)
        ) {
          continue;
        }
        postingRef.current.add(key);
        setFailures((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        const runId = await dispatchDeepRound(inv);
        if (!runId) {
          postingRef.current.delete(key);
          setFailures((prev) => ({ ...prev, [key]: "dispatch_failed" }));
          continue;
        }
        setJobs((prev) =>
          prev.some((j) => j.key === key)
            ? prev
            : [...prev, { key, runId, phase: "running", ticks: 0, misses: 0 }],
        );
      }
    },
    [],
  );

  const onMark = useCallback(
    async (
      inv: FundraisingInvestor,
      status: InvestorStatus,
      channel?: OutreachChannel,
    ) => {
      const key = investorWriteKey(inv);
      if (!key) return;
      if (status === "reached out" && !channel) return;
      const previous = overridesRef.current[key];
      setOverrides((prev) => ({ ...prev, [key]: status }));
      const stored = await persistStatus(key, status, channel);
      if (!stored) {
        setOverrides((prev) => {
          const next = { ...prev };
          if (previous === undefined) delete next[key];
          else next[key] = previous;
          return next;
        });
        return;
      }
      refreshRef.current();
    },
    [],
  );

  const nextStep = useMemo(
    () =>
      computeNextStep({
        investors,
        researching,
        planBuilt: planOpened,
      }),
    [investors, researching, planOpened],
  );

  const runNextStep = useCallback(() => {
    const action = nextStep.action;
    if (!action) return;
    if (action.kind === "deep_top") {
      void startDeepRound(
        pickForDeepRound(investors, researching, action.count),
      );
      return;
    }
    setPlanOpened(true);
    setView({ kind: "plan" });
  }, [nextStep, investors, researching, startDeepRound]);

  const submitRefine = useCallback(() => {
    const q = query.trim();
    if (!q || refineRunId) return;
    const baseline = investors.length;
    setRefineBaseline(null);
    setShowDropped(false);
    setQuery("");
    void (async () => {
      const result = await send(
        SLUG,
        `Refine my investor list: ${q}. Merge what you find into the list I already have and keep every investor already on it. Only add a firm you can confirm on a page you actually fetched, and report the ones you dropped.`,
      );
      if (result && result.kind === "queued") {
        setRefineBaseline(baseline);
        setRefineRunId(result.run_id);
      }
    })();
  }, [query, refineRunId, investors.length, send]);

  const switchStage = useCallback(
    (next: Stage) => {
      if (refineRunId) return;
      const baseline = investors.length;
      setRefineBaseline(null);
      setShowDropped(false);
      void (async () => {
        const result = await send(
          SLUG,
          `I'm raising ${roundWithArticle(next)}. Find the investors who actually write checks at ${next} for a company like mine. Merge what you find into the list I already have; never replace it. Only add a firm you can confirm on a page you actually fetched, and report the ones you dropped.`,
          null,
          { message_origin: "app_action" },
        );
        if (result && result.kind === "queued") {
          setRefineBaseline(baseline);
          setRefineRunId(result.run_id);
        }
      })();
    },
    [refineRunId, investors.length, send],
  );

  const openInvestor = useCallback((inv: FundraisingInvestor) => {
    setView({ kind: "investor", key: investorKey(inv) });
  }, []);
  const backToList = useCallback(() => setView({ kind: "list" }), []);

  if (view.kind === "investor") {
    const inv = investors.find((i) => investorKey(i) === view.key);
    if (!inv) {
      return (
        <div className="text-[16px] text-inkSoft">
          <BackLink onBack={backToList} />
          <p>That investor is no longer on your list.</p>
        </div>
      );
    }
    return (
      <InvestorReadView
        inv={inv}
        researching={researching.has(view.key)}
        failure={failures[view.key] ?? null}
        onBack={backToList}
        onDeepRound={(target) => void startDeepRound([target])}
        onMark={onMark}
      />
    );
  }

  if (view.kind === "plan") {
    return (
      <OutreachPlanView
        investors={investors}
        onBack={backToList}
        onOpen={openInvestor}
      />
    );
  }

  const c = listCounts(investors);
  const { tier1, tier2, tier3 } = splitTiers(investors);
  const rawStage = d.round_config?.stage ?? null;
  const stage: Stage | null = isStage(rawStage) ? rawStage : null;

  const rawMerge = d.latest?.merge ?? null;
  const merge =
    rawMerge &&
    (rawMerge.added > 0 ||
      rawMerge.already_saved > 0 ||
      rawMerge.dropped.length > 0)
      ? rawMerge
      : null;
  const localAdded =
    !merge && refineBaseline !== null && !refineRunId
      ? Math.max(0, c.total - refineBaseline)
      : null;

  return (
    <div className="flex flex-col gap-4">
      {}
      <section className="flex items-start gap-3.5 rounded-2xl border-[1.5px] border-ink bg-cream px-4 py-4 shadow-[0_1px_0_rgb(var(--c-ink)/0.04)]">
        <span
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink text-cream"
          aria-hidden="true"
        >
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-inkMuted">Next step</div>
          <div className="text-[16px] font-semibold leading-7 tracking-tight text-ink">
            {nextStep.title}
          </div>
          <p className="mt-1 max-w-[72ch] text-[16px] leading-6 text-inkMuted">
            {nextStep.why}
          </p>
          {nextStep.cta ? (
            <div className="mt-3">
              <Btn onClick={runNextStep}>{nextStep.cta} <NextChevron /></Btn>
            </div>
          ) : null}
        </div>
      </section>

      {}
      <div className="rounded-2xl border border-rule bg-cream">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 pt-4 text-[13px]">
        <Stat n={c.total} label="saved" tone="ink" muted={c.total === 0} />
        <Stat n={c.noPartner} label="no named partner" tone="amber" muted={c.noPartner === 0} />
        <Stat n={c.withEmail} label="with email" tone="emerald" muted={c.withEmail === 0} />
        <Stat n={c.researched} label="researched" tone="blue" muted={c.researched === 0} />
      </div>

      {}
      <div className="px-4 pt-3.5">
      <FundraisingStageSwitcher
        stage={stage}
        busy={Boolean(refineRunId)}
        onSwitched={switchStage}
      />
      </div>

      {}
      <div className="mt-3.5 border-t border-rule px-4 py-3.5">
        <label htmlFor="fr-refine" className="sr-only">
          Refine your investor list in plain English
        </label>
        <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-inkMuted" aria-hidden />
        <input
          id="fr-refine"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitRefine();
            }
          }}
          disabled={Boolean(refineRunId)}
          placeholder="Refine in plain English, e.g. “B2B SaaS seed funds in NY who write first checks”"
          className="h-11 w-full rounded-xl border border-rule bg-creamDeep/60 pl-10 pr-16 text-[16px] text-ink outline-none transition-colors placeholder:text-inkLight hover:border-inkMuted/40 focus:border-inkMuted focus:bg-cream focus:ring-2 focus:ring-ink/10 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md border border-rule bg-cream px-1.5 py-0.5 font-sans text-[12px] text-inkMuted">
          Enter
        </kbd>
        </div>
        <p className="mt-2 text-[13px] text-inkMuted">
          It merges into the list you already have. A query never replaces it.
        </p>
        {refineRunId ? (
          <div className="mt-3 rounded-xl border border-rule bg-creamDeep px-3 py-2.5">
            <InlineStatusRow
              key={refineRunId}
              agentSlug={SLUG}
              runId={refineRunId}
              onComplete={() => {
                setRefineRunId(null);
                refreshRef.current();
              }}
            />
          </div>
        ) : null}
      </div>
      </div>

      {}
      {merge ? (
        <div className="rounded-xl bg-emerald-500/10 px-4 py-3 text-[16px] text-emerald-600">
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
            <span>
              <b>+{num(merge.added)} new</b> · {num(merge.already_saved)} already
              saved · {num(merge.dropped.length)} dropped
            </span>
          </span>
          <div className="mt-1.5 text-[13px] text-inkMuted">
            Dropped means Zavi couldn&apos;t confirm the firm on a page it
            actually fetched, so it never enters your list.{" "}
            {merge.dropped.length > 0 ? (
              <Lnk onClick={() => setShowDropped((v) => !v)}>
                {showDropped ? "hide" : "see what was dropped"}
              </Lnk>
            ) : null}
          </div>
          {showDropped && merge.dropped.length > 0 ? (
            <div className="mt-2 text-[13px] leading-6 text-inkSoft">
              {merge.dropped.map((x, i) => (
                <span key={`${x}-${i}`} className="block">
                  · {x}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : localAdded !== null ? (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 px-4 py-3 text-[16px] text-emerald-600">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          <span>
            <b>+{num(localAdded)} new</b> · your list is now {num(c.total)}{" "}
            investors.
          </span>
        </div>
      ) : null}

      {}
      {c.researched >= 2 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rule bg-creamDeep px-4 py-3 text-[16px] text-inkSoft">
          <span className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
            <span>
            {planOpened ? (
              "Your outreach plan is ready."
            ) : (
              <>
                <b className="text-ink">{num(c.researched)} investors researched.</b> Enough to
                sequence who to approach first.
              </>
            )}
            </span>
          </span>
          <Btn
            ghost
            onClick={() => {
              setPlanOpened(true);
              setView({ kind: "plan" });
            }}
          >
            {planOpened ? "Open the plan" : "Build outreach plan"}
          </Btn>
        </div>
      ) : null}

      {}
      {c.total === 0 ? (
        <EmptyNote title="No investors saved yet.">
          Ask the Fundraising agent in chat for some.
        </EmptyNote>
      ) : null}

      {([
        [1, tier1],
        [2, tier2],
        [3, tier3],
      ] as Array<[1 | 2 | 3, FundraisingInvestor[]]>).map(([t, rows]) =>
        rows.length === 0 ? null : (
          <section key={t} className="mt-3">
            <div className="mb-3 flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${t === 1 ? "bg-emerald-500" : t === 2 ? "bg-blue-500" : "bg-inkLight"}`}
              />
              <h3 className="m-0 text-[16px] font-semibold tracking-tight text-ink">
                {tierLabel(t)}
              </h3>
              <span className="rounded-full bg-bone px-2 py-px text-[13px] font-medium tabular-nums text-inkMuted">
                {rows.length}
              </span>
            </div>
            <div className="flex flex-col gap-2">
            {(expanded[t] ? rows : rows.slice(0, PER_TIER)).map((inv) => (
              <InvestorCard
                key={investorKey(inv)}
                inv={inv}
                researching={researching.has(investorKey(inv))}
                failure={failures[investorKey(inv)] ?? null}
                onOpen={openInvestor}
                onDeepRound={(target) => void startDeepRound([target])}
              />
            ))}
            </div>
            {rows.length > PER_TIER ? (
              <div className="mt-2.5">
              <Lnk
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [t]: !prev[t] }))
                }
              >
                {expanded[t] ? "Show less" : "Show more"}
              </Lnk>
              </div>
            ) : null}
          </section>
        ),
      )}
    </div>
  );
}

function InvestorCard({
  inv,
  researching,
  failure,
  onOpen,
  onDeepRound,
}: {
  inv: FundraisingInvestor;
  researching: boolean;
  failure: DeepFailure | null;
  onOpen: (inv: FundraisingInvestor) => void;
  onDeepRound: (inv: FundraisingInvestor) => void;
}) {
  const status = investorStatus(inv);
  const warm = hasNamedPartner(inv);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(inv)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(inv);
        }
      }}
      className="flex cursor-pointer items-start gap-3.5 rounded-2xl border border-rule bg-cream px-4 py-3.5 transition-colors hover:border-inkMuted/50 hover:bg-creamDeep/50 focus:outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/10 motion-reduce:transition-none"
    >
      <Monogram name={inv.firm} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 max-w-full truncate text-[14px] font-semibold leading-6 text-ink" title={inv.firm}>{inv.firm}</span>
          {warm ? <span className="text-[16px] text-inkMuted">{inv.name}</span> : null}
        </div>
        {!warm || status !== "new" ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {warm ? null : (
              <span className="inline-block whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-px text-[13px] font-medium text-amber-600 first-letter:uppercase">
                no named partner
              </span>
            )}
            {status !== "new" ? <StatusPill status={status} /> : null}
          </div>
        ) : null}
        {inv.fit_rationale ? (
          <p className="m-0 mt-1.5 line-clamp-2 text-[13px] leading-5 text-inkMuted" title={inv.fit_rationale}>
            {inv.fit_rationale}
          </p>
        ) : null}
      </div>
      <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {inv.dossier ? (
          <Btn ghost onClick={() => onOpen(inv)}>
            <BookOpen className="h-4 w-4" aria-hidden />
            Read
          </Btn>
        ) : researching ? (
          <span
            className="inline-flex items-center gap-2 whitespace-nowrap text-[13px] text-inkMuted"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            <span>researching…</span>
          </span>
        ) : failure ? (
          <span className="flex items-center gap-2 whitespace-nowrap">
            <span className="text-[13px] text-amber-600" role="status">
              {deepRoundFailureShort(failure)}
            </span>
            <Btn ghost onClick={() => onDeepRound(inv)}>Try again</Btn>
          </span>
        ) : (
          <Btn ghost onClick={() => onDeepRound(inv)}>
            <Telescope className="h-4 w-4" aria-hidden />
            Deep round
          </Btn>
        )}
      </div>
    </div>
  );
}
