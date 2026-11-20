"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useWorkspace } from "../WorkspaceShell";
import { cx, FOCUS_RING, useOpenStatic, type StaticKind } from "./shared";
import { apiFetch } from "@/lib/api";

type SlotStatus = "missing" | "thin" | "filled";

type Activation = {
  brain_seeded: boolean;
  connectors_count: number;
  agents_run_count: number;
  first_approval_acted: boolean;
  activated: boolean;
  brain?: { filled: number; total: number; slots: Array<{ slug: string; status: SlotStatus }> };
};

type Step = {
  key: string;
  title: string;
  detail: string;
  done: boolean;
  cta: string;
  go: StaticKind | "chat";
  required?: boolean;
};

type Section = { title: string; steps: Step[] };

let cached: Promise<Activation | null> | null = null;

function loadActivation(force = false): Promise<Activation | null> {
  if (!cached || force) {
    cached = apiFetch("/api/workspace/activation")
      .then(async (res) => (res.ok ? ((await res.json()) as Activation) : null))
      .catch(() => null);
  }
  return cached;
}

const humanize = (slug: string) =>
  slug.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function sectionsFor(a: Activation): Section[] {
  const brainSteps: Step[] = a.brain
    ? a.brain.slots.map((s) => ({
        key: `brain:${s.slug}`,
        title: humanize(s.slug),
        detail:
          s.status === "thin"
            ? "Partially filled. Add detail so plans stop guessing"
            : "Every agent reads this before it proposes work",
        done: s.status === "filled",
        cta: s.status === "thin" ? "Add detail" : "Fill in",
        go: "brain",
      }))
    : [
        {
          key: "brain",
          title: "Seed the business brain",
          detail: "What you sell, who buys it, how you make money",
          done: a.brain_seeded,
          cta: "Open Brain",
          go: "brain",
          required: true,
        },
      ];
  return [
    {
      title: "Connect your data",
      steps: [
        {
          key: "connect",
          title: "Connect a data source",
          detail: "Slack, GitHub, Meta Ads, your database. Agents read from these",
          done: a.connectors_count > 0,
          cta: "Connect",
          go: "brain",
          required: true,
        },
      ],
    },
    { title: "Teach Zavi your business", steps: brainSteps },
    {
      title: "Put the team to work",
      steps: [
        {
          key: "run",
          title: "Run your first agent",
          detail: "Ask Zavi for anything. It routes to the right specialist",
          done: a.agents_run_count > 0,
          cta: "Ask Zavi",
          go: "chat",
          required: true,
        },
        {
          key: "approve",
          title: "Approve your first action",
          detail: "Agents propose; nothing ships until you say so",
          done: a.first_approval_acted,
          cta: "Review",
          go: "home",
        },
      ],
    },
  ];
}

export function useOnboarding() {
  const [state, setState] = useState<Activation | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback((force = false) => {
    setLoading(true);
    void loadActivation(force).then((a) => {
      setState(a);
      setLoading(false);
    });
  }, []);
  useEffect(() => load(), [load]);
  const sections = useMemo(() => (state ? sectionsFor(state) : []), [state]);
  const steps = sections.flatMap((s) => s.steps);
  const done = steps.filter((s) => s.done).length;
  const total = steps.length;
  return {
    loading,
    sections,
    done,
    total,
    pct: total ? Math.round((done / total) * 100) : 0,
    refresh: () => load(true),
  };
}

export function ProgressRing({
  pct,
  size,
  label,
}: {
  pct: number;
  size: number;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const stroke = (Math.max(4, Math.round(size * 0.12)) / size) * 100;
  const radius = (100 - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? `${clamped}% complete`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className="block shrink-0 -rotate-90"
    >
      <circle
        cx="50"
        cy="50"
        r={radius}
        fill="none"
        stroke="rgb(var(--c-bone))"
        strokeWidth={stroke}
      />
      {clamped > 0 && (
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="rgb(var(--c-ink))"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
          className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
        />
      )}
    </svg>
  );
}

export function OnboardingView({ embedded = false }: { embedded?: boolean } = {}) {
  const shell = embedded ? "" : "mx-auto max-w-3xl px-6";
  const { tenantName, openAgentTab } = useWorkspace();
  const openStatic = useOpenStatic();
  const { loading, sections, done, total, pct, refresh } = useOnboarding();

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const go = (step: Step) => {
    if (step.go === "chat") void openAgentTab("operator");
    else openStatic(step.go);
  };

  if (loading && total === 0) {
    return (
      <div role="status" aria-busy="true" className={cx(shell, "py-8")}>
        <span className="sr-only">Loading onboarding…</span>
        <div className="flex items-center gap-4">
          <div className="h-[74px] w-[74px] animate-pulse rounded-full bg-bone motion-reduce:animate-none" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-1/2 animate-pulse rounded bg-bone motion-reduce:animate-none" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-bone motion-reduce:animate-none" />
          </div>
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="mt-5 h-40 animate-pulse rounded-2xl bg-bone motion-reduce:animate-none" />
        ))}
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className={cx(shell, "py-12 text-center")}>
        <p className="text-[16px] text-inkMuted">Couldn&apos;t load your setup status.</p>
        <button
          type="button"
          onClick={refresh}
          className={cx("mt-3 rounded-cta bg-ink px-4 py-2 text-[13px] font-semibold text-cream hover:bg-inkSoft", FOCUS_RING)}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={cx(shell, "flex flex-col gap-5", embedded ? "py-1" : "py-6")}>
      <div className="flex items-center gap-[18px]">
        <div className="relative">
          <ProgressRing pct={pct} size={74} label={`${done} of ${total} steps done`} />
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center text-[16px] font-bold tabular-nums tracking-[-0.3px]"
          >
            {pct}%
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[20px] font-bold tracking-[-0.2px] text-ink [text-wrap:balance]">
            {pct === 100 ? "You are all set" : `Finish setting up ${tenantName ?? "your workspace"}`}
          </h2>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-[19px] text-inkMuted [text-wrap:pretty]">
            {done} of {total} done. Each step unlocks work Zavi can do on its own. The more it can reach, the less sits waiting for your approval.
          </p>
        </div>
      </div>

      {sections.map((sec) => {
        const secDone = sec.steps.filter((s) => s.done).length;
        return (
          <section key={sec.title} className="overflow-hidden rounded-2xl border border-rule bg-cream">
            <div className="flex items-center gap-2.5 border-b border-rule bg-creamDeep px-3.5 py-[11px]">
              <h3 className="min-w-0 flex-1 text-[12px] font-bold uppercase tracking-[0.05em] text-inkMuted">
                {sec.title}
              </h3>
              <span className="text-[11px] font-semibold tabular-nums text-inkLight">
                {secDone}/{sec.steps.length}
              </span>
            </div>
            <ul>
              {sec.steps.map((step) => (
                <li
                  key={step.key}
                  className="flex items-center gap-3 border-b border-rule px-3.5 py-3 last:border-b-0"
                >
                  <span
                    aria-hidden
                    className={cx(
                      "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px]",
                      step.done ? "border-success bg-success text-cream" : "border-ink/20 bg-cream",
                    )}
                  >
                    {step.done && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cx(
                        "text-[13px] font-semibold leading-[18px]",
                        step.done ? "text-inkLight line-through" : "text-ink",
                      )}
                    >
                      {step.title}
                      <span className="sr-only">{step.done ? ", done" : ""}</span>
                    </p>
                    <p className="text-[12px] leading-4 text-inkMuted">
                      {step.detail}
                      {step.required && !step.done && (
                        <>
                          {" · "}
                          <span className="text-[11px] font-bold uppercase tracking-[0.04em] text-danger">
                            required
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  {!step.done && (
                    <button
                      type="button"
                      onClick={() => go(step)}
                      className={cx(
                        "shrink-0 rounded-cta px-3 py-[7px] text-[12px] font-semibold transition-colors duration-150 motion-reduce:transition-none",
                        step.required
                          ? "bg-ink text-cream hover:bg-inkSoft"
                          : "border border-rule bg-cream text-ink hover:bg-creamDeep",
                        FOCUS_RING,
                      )}
                    >
                      {step.cta}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
