"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  useAgentDashboard,
  DashboardShell,
  num,
  ago,
  type AttentionItem,
} from "./dashboard-ui";

type Role = "guest" | "host" | "public";

type CaseRow = {
  id: string;
  title: string;
  role: Role;
  source: "agent-onboarding" | "operator-chat" | "other";
  created_at: string | null;
  manual_tested_at: string | null;
};

type ReportRow = {
  id: string;
  filename: string;
  created_at: string | null;
  slack_delivered: boolean;
};

type RunSummary = {
  at: string | null;
  ran: number;
  pass: number;
  fail: number;
  blocked: number;
  pass_rate: number | null;
};

type BrittleCase = {
  id: string;
  title: string;
  role: Role;
  consecutive_red: number;
  last_run_at: string | null;
};

type Execution = {
  latest: RunSummary | null;
  trend: Array<{ at: string | null; pass_rate: number | null }>;
  red_now: number;
  brittle: BrittleCase[];
  healed: number;
  last_executed_at: string | null;
};

type InFlight = {
  started_at: string | null;
  total: number;
  done: number;
};

type Payload = {
  generic?: boolean;
  counts: { total: number; guest: number; host: number; public: number };
  cases: CaseRow[];
  reports: ReportRow[];
  attention: AttentionItem[];
  execution?: Execution;
  in_flight?: InFlight | null;
};

const INK = "#0e0f11";
const MUTED = "#595959";
const GOOD = "#167f50";
const BAD = "#cb2029";
const WARN = "#8a6d00";
const BORDER = "#f0f0f0";

const ROLE_CHIP: Record<Role, { bg: string; fg: string; label: string }> = {
  guest: { bg: "#eef0f3", fg: "#3c4350", label: "Guest" },
  host: { bg: "#ecefff", fg: "#3a3f8a", label: "Host" },
  public: { bg: "#eef6ef", fg: "#3a6a45", label: "Public" },
};

function sourceLabel(s: CaseRow["source"]): string {
  if (s === "agent-onboarding") return "Seeded";
  if (s === "operator-chat") return "In-chat";
  return "-";
}

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-[#f0f0f0] bg-white p-4 ${className}`}
    >
      {children}
    </section>
  );
}

function RoleChip({ role }: { role: Role }) {
  const c = ROLE_CHIP[role];
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ backgroundColor: c.bg, color: c.fg }}
    >
      {c.label}
    </span>
  );
}

function Stage({
  value,
  label,
  meta,
  tone,
  last,
}: {
  value: string;
  label: string;
  meta: string;
  tone?: "good";
  last?: boolean;
}) {
  return (
    <div
      className="relative flex-1 px-1 text-center"
      role="listitem"
      aria-label={`${label}: ${value}, ${meta}`}
    >
      <div
        className="text-[30px] font-bold leading-none tabular-nums tracking-tight"
        style={{ color: tone === "good" ? GOOD : INK }}
      >
        {value}
      </div>
      <div
        className="mt-1.5 text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: MUTED }}
      >
        {label}
      </div>
      <div className="mt-0.5 text-[11px]" style={{ color: MUTED }}>
        {meta}
      </div>
      {!last ? (
        <span
          aria-hidden="true"
          className="absolute right-0 top-3 h-11 w-px"
          style={{ backgroundColor: BORDER }}
        />
      ) : null}
    </div>
  );
}

function ReportDownload({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await apiFetch(`/api/run-artifacts/${id}/url`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { signed_url?: string };
      if (!json.signed_url) throw new Error("no url");
      window.open(json.signed_url, "_blank", "noopener,noreferrer");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={busy}
      className="cursor-pointer rounded-cta border border-[#f0f0f0] bg-white px-2.5 py-1 text-[12px] font-semibold text-[#1f1f1f] hover:bg-[#f7f4ee] disabled:opacity-50"
    >
      {busy ? "Opening…" : failed ? "Retry" : "Download"}
    </button>
  );
}

function TestedToggle({
  caseId,
  testedAt,
}: {
  caseId: string;
  testedAt: string | null;
}) {
  const [checked, setChecked] = useState(testedAt !== null);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    const next = !checked;
    setChecked(next);
    setBusy(true);
    try {
      const res = await apiFetch(`/api/agents/qa/test-cases/${caseId}/tested`, {
        method: "POST",
        body: JSON.stringify({ tested: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setChecked(!next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={busy}
      onChange={() => void toggle()}
      aria-label={
        checked ? "Mark test case as not tested" : "Mark test case as tested"
      }
      className="h-4 w-4 cursor-pointer accent-[#167f50] disabled:opacity-50"
    />
  );
}

function dur(sinceIso: string | null, nowMs: number): string {
  if (!sinceIso) return "";
  const t = new Date(sinceIso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 120) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

function PipelineControl({
  inFlight,
  refreshSilent,
}: {
  inFlight: InFlight | null;
  refreshSilent?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [optimisticSince, setOptimisticSince] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const prevActive = useRef(false);
  const catchupTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (catchupTimer.current) window.clearTimeout(catchupTimer.current);
    },
    [],
  );

  const active = inFlight != null || optimisticSince != null;

  useEffect(() => {
    if (inFlight != null && optimisticSince != null) setOptimisticSince(null);
  }, [inFlight, optimisticSince]);

  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const tick = window.setInterval(() => setNowMs(Date.now()), 5000);
    const poll = window.setInterval(() => refreshSilent?.(), 15000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [active, refreshSilent]);

  useEffect(() => {
    if (optimisticSince == null) return;
    const id = window.setTimeout(() => setOptimisticSince(null), 150_000);
    return () => window.clearTimeout(id);
  }, [optimisticSince]);

  useEffect(() => {
    if (active) {
      prevActive.current = true;
      return;
    }
    if (prevActive.current) {
      prevActive.current = false;
      const a = window.setTimeout(() => refreshSilent?.(), 30_000);
      const b = window.setTimeout(() => refreshSilent?.(), 120_000);
      return () => {
        window.clearTimeout(a);
        window.clearTimeout(b);
      };
    }
  }, [active, refreshSilent]);

  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetch("/api/agents/qa/run-tests", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const json = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: { code?: string; message?: string };
      };
      if (res.status === 202) {
        setOptimisticSince(Date.now());
        if (catchupTimer.current) window.clearTimeout(catchupTimer.current);
        catchupTimer.current = window.setTimeout(() => refreshSilent?.(), 4000);
      } else if (res.status === 409 && json.error?.code === "already_running") {
        setNote("A test batch is already running. Tracking it below.");
        refreshSilent?.();
      } else if (res.status === 429) {
        setNote("A batch just ran. Try again in a few minutes.");
      } else if (res.status === 403) {
        setNote("Test execution isn't enabled for this workspace yet.");
      } else if (res.status === 409) {
        setNote("Set your staging URL in QA Setup first.");
      } else {
        setNote(
          json.error?.message ?? `Couldn't start the run (HTTP ${res.status}).`,
        );
      }
    } catch {
      setNote("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const total = inFlight?.total ?? 0;
  const done = inFlight ? Math.max(0, Math.min(total, inFlight.done)) : 0;
  const determinate = inFlight != null && total > 0;
  const pctDone = determinate ? Math.round((done / total) * 100) : 0;
  const since =
    inFlight?.started_at ??
    (optimisticSince != null ? new Date(optimisticSince).toISOString() : null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || active}
          className="inline-flex cursor-pointer items-center gap-2 rounded-cta bg-[#0e0f11] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#26282c] disabled:opacity-50"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
          {busy ? "Starting…" : active ? "Running…" : "Run pipeline"}
        </button>
        {!active && note ? (
          <span className="text-[12px] text-[#595959]">{note}</span>
        ) : null}
      </div>

      {active ? (
        <div
          className="rounded-xl border border-[#dbe8fb] bg-[#f5f9ff] px-4 py-3"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[#027bff] opacity-60 motion-safe:animate-ping" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#027bff]" />
              </span>
              <span className="text-[13px] font-semibold text-[#0e0f11]">
                {inFlight ? "Running QA pipeline" : "Starting QA pipeline…"}
              </span>
            </div>
            <span className="text-[12px] tabular-nums text-[#595959]">
              {since ? `running ${dur(since, nowMs)}` : null}
              {determinate ? ` · ${done}/${total} tests done` : null}
            </span>
          </div>

          {determinate ? (
            <div
              className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-[#e2ecfb]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={done}
              aria-label={`${done} of ${total} test cases finished`}
            >
              <div
                className="h-full rounded-full bg-[#027bff] motion-safe:transition-all"
                style={{ width: `${pctDone}%` }}
              />
            </div>
          ) : (
            <div
              className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-[#e2ecfb]"
              aria-hidden="true"
            >
              <div className="h-full w-1/3 rounded-full bg-[#9cc4f7] motion-safe:animate-pulse" />
            </div>
          )}

          <p className="m-0 mt-2 text-[12px] text-[#595959]">
            Each active test runs via browser-operator, typically 10–45 min. The
            pass/fail digest also lands in{" "}
            <span className="font-semibold text-[#1f1f1f]">Needs you</span>, so you
            can leave this page.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function BlockerRow({ item }: { item: AttentionItem }) {
  const high = item.severity === "high";
  const tileBg = high ? "#fbeaeb" : "#f7f1df";
  const tileFg = high ? "#cb2029" : "#8a6d00";
  return (
    <div className="flex gap-3 border-t border-[#f0f0f0] py-3 first:border-t-0">
      <div
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px]"
        style={{ backgroundColor: tileBg }}
        aria-hidden="true"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tileFg} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="m-0 flex items-center gap-2 text-[13px] font-semibold text-[#0e0f11]">
          {item.title}
          <span
            className="rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
            style={{ backgroundColor: tileBg, color: tileFg }}
          >
            {high ? "high" : "gap"}
          </span>
        </p>
        <p className="m-0 mt-0.5 text-[13px] text-[#595959]">{item.detail}</p>
        <p className="m-0 mt-1.5 text-[12px] italic text-[#8a8a8a]">
          Ask in chat → “{item.ask}”
        </p>
      </div>
    </div>
  );
}

function PassRateSparkline({
  trend,
}: {
  trend: Array<{ at: string | null; pass_rate: number | null }>;
}) {
  const pts = trend
    .map((t) => t.pass_rate)
    .filter((v): v is number => typeof v === "number");
  if (pts.length < 2) return null;
  const W = 200;
  const H = 44;
  const max = 100;
  const min = Math.min(40, ...pts);
  const span = Math.max(1, max - min);
  const step = W / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = i * step;
    const y = H - ((v - min) / span) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const label = `Pass rate trend, last ${pts.length} runs: ${pts.join(", ")} percent`;
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      className="overflow-visible"
    >
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke={GOOD}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={(pts.length - 1) * step}
        cy={H - ((pts[pts.length - 1] - min) / span) * H}
        r="2.5"
        fill={GOOD}
      />
    </svg>
  );
}

function CounterTile({
  value,
  label,
  meta,
  tone,
}: {
  value: number;
  label: string;
  meta: string;
  tone: "bad" | "warn" | "good" | "ink";
}) {
  const color =
    tone === "bad" ? BAD : tone === "warn" ? WARN : tone === "good" ? GOOD : INK;
  return (
    <div className="px-1">
      <div
        className="text-[22px] font-bold leading-none tabular-nums tracking-tight"
        style={{ color }}
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
        {label}
      </div>
      <div className="mt-0.5 text-[11px] text-[#8a8a8a]">{meta}</div>
    </div>
  );
}

function ExecutionPanel({ exec }: { exec: Execution }) {
  const l = exec.latest;
  return (
    <div className="mt-4 rounded-xl border border-[#f0f0f0] bg-white px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 text-[12px] font-semibold uppercase tracking-wide text-[#595959]">
            Latest pipeline run
          </p>
          {l ? (
            <p className="m-0 mt-1 text-[13px] text-[#0e0f11]">
              <span className="font-semibold text-[#167f50]">{num(l.pass)} passed</span>
              {" · "}
              <span className="font-semibold" style={{ color: l.fail > 0 ? BAD : MUTED }}>
                {num(l.fail)} failed
              </span>
              {" · "}
              <span className="text-[#595959]">{num(l.blocked)} blocked</span>
              <span className="text-[#8a8a8a]"> of {num(l.ran)} run</span>
              {l.at ? (
                <span className="text-[#a8a8a8]"> · {ago(l.at)}</span>
              ) : null}
            </p>
          ) : (
            <p className="m-0 mt-1 text-[13px] text-[#595959]">
              No completed run summary yet. Per-case results below.
            </p>
          )}
        </div>
        {l && l.pass_rate !== null ? (
          <div className="flex items-center gap-3">
            <PassRateSparkline trend={exec.trend} />
            <div className="text-right">
              <div className="text-[22px] font-bold leading-none tabular-nums text-[#0e0f11]">
                {l.pass_rate}
                <span className="text-[13px]">%</span>
              </div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
                Pass rate
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-3.5 grid grid-cols-3 gap-0 border-t border-[#f0f0f0] pt-3">
        <CounterTile
          value={exec.red_now}
          label="Red now"
          meta="last run failed"
          tone={exec.red_now > 0 ? "bad" : "ink"}
        />
        <div className="border-l border-[#f0f0f0] pl-4">
          <CounterTile
            value={exec.brittle.length}
            label="Brittle"
            meta="failed ≥3× in a row"
            tone={exec.brittle.length > 0 ? "warn" : "ink"}
          />
        </div>
        <div className="border-l border-[#f0f0f0] pl-4">
          <CounterTile
            value={exec.healed}
            label="Healed"
            meta="self-repaired"
            tone={exec.healed > 0 ? "good" : "ink"}
          />
        </div>
      </div>
    </div>
  );
}

const placeholder = (
  <div className="rounded-2xl border border-dashed border-[#d8d2c4] bg-white px-6 py-8 text-center">
    <div className="text-[16px] font-semibold text-[#1f1f1f]">
      No test cases yet
    </div>
    <p className="mx-auto mt-1 max-w-md text-[12px] text-[#595959]">
      Ask qa to draft tests for your core flows (e.g. “add tests for my signup and checkout”) and they’ll show up here as a reviewable pipeline.
    </p>
  </div>
);

export function QaDashboard() {
  const state = useAgentDashboard<Payload>("qa");

  return (
    <DashboardShell
      title="Test pipeline"
      subtitle="Your test catalog, framed as a build → review → report flow."
      state={state}
      genericFallback={placeholder}
      render={(d) => {
        if (d.counts.total === 0 && d.reports.length === 0) return placeholder;

        const manualVerified = d.cases.filter(
          (c) => c.manual_tested_at !== null,
        ).length;
        const reportCount = d.reports.length;

        const total = Math.max(1, d.counts.total);
        const guestW = (d.counts.guest / total) * 100;
        const hostW = (d.counts.host / total) * 100;
        const publicW = (d.counts.public / total) * 100;

        return (
          <>
            {}
            <PipelineControl
              inFlight={d.in_flight ?? null}
              refreshSilent={state.refreshSilent}
            />

            {}
            <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
              {}
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="m-0 text-[14px] font-semibold text-[#0e0f11]">
                      Pipeline stages
                    </h3>
                    <p className="m-0 text-[13px] text-[#595959]">
                      Where the catalog sits in the build → review → report flow.
                    </p>
                  </div>
                  <span className="whitespace-nowrap rounded-full bg-[#e7f1ff] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#027bff]">
                    {num(d.counts.total)} in catalog
                  </span>
                </div>

                <div
                  className="mt-4 flex items-stretch"
                  role="list"
                  aria-label="Pipeline stage distribution"
                >
                  <Stage
                    value={num(d.counts.total)}
                    label="Active"
                    meta="in catalog"
                  />
                  <Stage
                    value={num(manualVerified)}
                    label="Verified"
                    meta="human-checked"
                  />
                  <Stage
                    value={num(reportCount)}
                    label="Reported"
                    meta="recent digests"
                    tone="good"
                    last
                  />
                </div>

                {}
                {d.execution ? (
                  <ExecutionPanel exec={d.execution} />
                ) : (
                  <div
                    className="mt-4 rounded-xl border border-[#f0f0f0] bg-[#f7f4ee] px-4 py-3"
                    role="note"
                  >
                    <p className="m-0 text-[12px] font-semibold text-[#1f1f1f]">
                      Live run status: appears after your first run
                    </p>
                    <p className="m-0 mt-0.5 text-[12px] text-[#595959]">
                      Pass/fail, red/brittle and pass-rate trend appear here once
                      a pipeline run finishes. Hit{" "}
                      <span className="font-semibold text-[#1f1f1f]">Run pipeline</span>{" "}
                      above. Results also land in{" "}
                      <span className="font-semibold text-[#1f1f1f]">Needs you</span>{" "}
                      and as digest reports below.
                    </p>
                  </div>
                )}
              </Card>

              {}
              <Card>
                <h3 className="m-0 text-[14px] font-semibold text-[#0e0f11]">
                  Coverage health
                </h3>
                <p className="m-0 text-[13px] text-[#595959]">
                  Catalog size and human-verified coverage.
                </p>

                <div className="mt-3 grid grid-cols-2 gap-0">
                  <div className="pr-4">
                    <div className="text-[26px] font-bold tabular-nums tracking-tight text-[#0e0f11]">
                      {num(d.counts.total)}
                    </div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
                      Active cases
                    </div>
                  </div>
                  <div className="border-l border-[#f0f0f0] pl-4">
                    <div className="text-[26px] font-bold tabular-nums tracking-tight text-[#167f50]">
                      {num(manualVerified)}
                    </div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
                      Human-verified
                    </div>
                  </div>
                </div>

                {}
                <div className="mt-5">
                  <div className="flex justify-between text-[12px] font-semibold text-[#595959]">
                    <span>Coverage by role</span>
                    <span className="tabular-nums">{num(d.counts.total)} cases</span>
                  </div>
                  <div
                    className="mt-2.5 flex h-2 overflow-hidden rounded-full bg-[#f0f0f0]"
                    role="img"
                    aria-label={`Coverage by role: ${d.counts.guest} guest, ${d.counts.host} host, ${d.counts.public} public`}
                  >
                    <i
                      className="block h-full"
                      style={{ width: `${guestW}%`, backgroundColor: "#7c8596" }}
                    />
                    <i
                      className="block h-full"
                      style={{ width: `${hostW}%`, backgroundColor: "#5a61a8" }}
                    />
                    <i
                      className="block h-full"
                      style={{ width: `${publicW}%`, backgroundColor: "#5a9a6a" }}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3.5 text-[12px] text-[#595959]">
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ backgroundColor: "#7c8596" }} />
                      Guest {num(d.counts.guest)}
                    </span>
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ backgroundColor: "#5a61a8" }} />
                      Host {num(d.counts.host)}
                    </span>
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ backgroundColor: "#5a9a6a" }} />
                      Public {num(d.counts.public)}
                    </span>
                  </div>
                </div>
              </Card>
            </div>

            {}
            {d.attention.length > 0 ? (
              <Card>
                <div className="mb-2">
                  <h3 className="m-0 flex items-center gap-2 text-[14px] font-semibold text-[#0e0f11]">
                    Pipeline blockers
                    <span className="rounded-full bg-[#f7f1df] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#8a6d00]">
                      {d.attention.length} to unblock
                    </span>
                  </h3>
                  <p className="m-0 text-[13px] text-[#595959]">
                    Coverage gaps stopping the catalog from giving full,
                    trustworthy coverage. Each one has a chat nudge.
                  </p>
                </div>
                <div className="grid gap-x-8 md:grid-cols-2">
                  {d.attention.map((a, i) => (
                    <BlockerRow key={i} item={a} />
                  ))}
                </div>
              </Card>
            ) : null}

            {}
            <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
              {}
              <Card>
                <div className="flex items-center justify-between">
                  <h3 className="m-0 text-[14px] font-semibold text-[#0e0f11]">
                    Case catalog
                  </h3>
                  <span className="rounded-full bg-[#f7f4ee] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
                    {num(d.counts.total)} active
                  </span>
                </div>
                <p className="m-0 mt-0.5 text-[13px] text-[#595959]">
                  Every case the agent keeps for your product.
                </p>

                {d.cases.length === 0 ? (
                  <div className="mt-3 rounded-xl border border-dashed border-[#e5e7eb] px-4 py-3 text-[12px] text-[#a8a8a8]">
                    No active test cases.
                  </div>
                ) : (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full border-collapse text-[13px]">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wide text-[#8a8a8a]">
                          <th className="border-b border-[#f0f0f0] px-3 pb-2.5 font-semibold">
                            Case
                          </th>
                          <th className="border-b border-[#f0f0f0] px-3 pb-2.5 font-semibold">
                            Role
                          </th>
                          <th className="border-b border-[#f0f0f0] px-3 pb-2.5 font-semibold">
                            Source
                          </th>
                          <th className="border-b border-[#f0f0f0] px-3 pb-2.5 text-center font-semibold">
                            Verified
                          </th>
                          <th className="border-b border-[#f0f0f0] px-3 pb-2.5 text-right font-semibold">
                            Added
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.cases.map((c) => (
                          <tr
                            key={c.id}
                            className="hover:bg-[#fcfbf9] last:[&>td]:border-b-0"
                          >
                            <td className="border-b border-[#f0f0f0] px-3 py-3 align-middle">
                              <div className="font-semibold text-[#0e0f11]">
                                {c.title || "(untitled)"}
                              </div>
                            </td>
                            <td className="border-b border-[#f0f0f0] px-3 py-3 align-middle">
                              <RoleChip role={c.role} />
                            </td>
                            <td className="border-b border-[#f0f0f0] px-3 py-3 align-middle text-[12px] text-[#595959]">
                              {sourceLabel(c.source)}
                            </td>
                            <td className="border-b border-[#f0f0f0] px-3 py-3 text-center align-middle">
                              <TestedToggle
                                caseId={c.id}
                                testedAt={c.manual_tested_at}
                              />
                            </td>
                            <td className="border-b border-[#f0f0f0] px-3 py-3 text-right align-middle text-[12px] tabular-nums text-[#8a8a8a]">
                              {ago(c.created_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              {}
              <Card>
                <h3 className="m-0 text-[14px] font-semibold text-[#0e0f11]">
                  Run reports
                </h3>
                <p className="m-0 text-[13px] text-[#595959]">
                  Digest artifacts from each cycle, also landing in Needs you.
                </p>

                {d.reports.length === 0 ? (
                  <div className="mt-3 rounded-xl border border-dashed border-[#e5e7eb] px-4 py-3 text-[12px] text-[#a8a8a8]">
                    No reports yet.
                  </div>
                ) : (
                  <div className="mt-1">
                    {d.reports.map((r) => (
                      <div
                        key={r.id}
                        className="flex items-center gap-3 border-t border-[#f0f0f0] py-3 first:border-t-0"
                      >
                        <div
                          className="flex h-9 w-[30px] shrink-0 items-center justify-center rounded-md border border-[#f0f0f0] bg-[#f7f4ee]"
                          aria-hidden="true"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="1.8">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <path d="M14 2v6h6" />
                          </svg>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold text-[#0e0f11]">
                            {r.filename}
                          </div>
                          <div className="mt-0.5 text-[12px] text-[#595959]">
                            {ago(r.created_at)}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          {r.slack_delivered ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#e9f4ee] px-2 py-0.5 text-[11px] font-semibold text-[#167f50]">
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                              </svg>
                              Slack sent
                            </span>
                          ) : (
                            <span className="text-[11px] text-[#a8a8a8]">
                              Not delivered
                            </span>
                          )}
                          <ReportDownload id={r.id} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-4 border-t border-[#f0f0f0] pt-4">
                  <div className="flex items-center gap-2 text-[13px] text-[#595959]">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 16v-4M12 8h.01" />
                    </svg>
                    Manual coverage:{" "}
                    <strong className="text-[#0e0f11]">
                      {num(manualVerified)} of {num(d.counts.total)}
                    </strong>{" "}
                    cases human-verified.
                  </div>
                </div>
              </Card>
            </div>
          </>
        );
      }}
    />
  );
}
