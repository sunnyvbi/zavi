"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { ConnectButton } from "@/app/connectors/ConnectButton";
import { OperatorDbForm } from "@/app/connectors/OperatorDbConnectButton";
import { useWorkspace } from "./WorkspaceShell";
import { useBuildProduct, type BuildStatus } from "@/lib/workspace/useBuildProduct";
import { gettingStartedCopy, resolveWorkspaceSegment } from "@/lib/workspace/segmentCopy";
import { NextChevron } from "@/components/ui/NextChevron";

type NextBestAction = { key: string; label: string; href: string };

type SlotStatus = "missing" | "thin" | "filled";
export type BrainSlotState = { slug: string; status: SlotStatus };
export type BrainState = { filled: number; total: 10; slots: BrainSlotState[] };

type ActivationState = {
  brain_seeded: boolean;
  connectors_count: number;
  agents_run_count: number;
  first_approval_acted: boolean;
  activated: boolean;
  next_best_action: NextBestAction;
  brain?: BrainState;
};

const HUMAN_GAP_SLUGS = ["disputes", "gtm_growth", "metrics_north_star"] as const;

const GAP_QUESTIONS: Record<string, string> = {
  disputes:
    "How do you handle disputes, refunds, or chargebacks? What's your default stance?",
  gtm_growth:
    "How do you get customers? What are your main growth channels and rough CAC/LTV if you know them?",
  metrics_north_star:
    "What's the single most important metric your team optimizes for right now?",
};

const GAP_LABELS: Record<string, string> = {
  disputes: "Disputes",
  gtm_growth: "Go-to-market & growth",
  metrics_north_star: "Metrics & north star",
};

const CONNECT_TILES = [
  {
    slug: "slack",
    label: "Slack",
    helps: "Helps fill Support & Team",
    icon: "/logos/slack-color.svg",
  },
  {
    slug: "github",
    label: "GitHub",
    helps: "Helps fill Engineering",
    icon: "/logos/github-icon.svg",
  },
  {
    slug: "jira",
    label: "Jira",
    helps: "Helps fill Engineering & Product",
    icon: "/integrations/jira.svg",
  },
  {
    slug: "operator_db",
    label: "Database",
    helps: "Connect your main database",
    icon: "/logos/database-icon.svg",
  },
] as const;

function hasProductCompleted(s: ActivationState): number {
  let n = 0;
  if (s.connectors_count > 0) n++;
  if (s.agents_run_count > 0) n++;
  if (s.first_approval_acted) n++;
  return n;
}

export function freshBuildCompleted(s: ActivationState, build: BuildStatus): number {
  let n = 0;
  if (build === "building" || build === "live" || build === "failed") n++;
  if (build === "live") n++;
  if (s.first_approval_acted) n++;
  return n;
}

export function freshBuildCta(
  build: BuildStatus,
  paused = false,
): { label: string; cta: string } {
  if (build === "failed" && paused) {
    return { label: "Your build is paused. Continue it on Home", cta: "Continue build" };
  }
  switch (build) {
    case "building":
      return { label: "Your app is building. Track it on Home", cta: "View build" };
    case "live":
      return { label: "Your app is live. Refine it by chat", cta: "Refine app" };
    case "failed":
      return { label: "Your last build hit an error. Pick it back up on Home", cta: "Retry build" };
    case "none":
    default:
      return { label: "Describe your app to get started", cta: "Describe your app" };
  }
}

export function resolveRailPosture(
  buildAppIntent: "fresh" | "existing",
  buildEnabled: boolean,
): "fresh" | "existing" {
  return resolveWorkspaceSegment(buildAppIntent) === "fresh_build" && buildEnabled
    ? "fresh"
    : "existing";
}

export function GettingStartedCard() {
  const { openTab, openAgentTab, tabs, setActiveTab, requestBuilderRetry } =
    useWorkspace();
  const {
    buildAppIntent,
    companyScaleSegment,
    status: buildStatus,
    loaded: buildLoaded,
    enabled: buildEnabled,
    runPaused,
  } = useBuildProduct();
  const [state, setState] = useState<ActivationState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/workspace/activation");
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as ActivationState;
        if (!cancelled) setState(data);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onAction = useCallback(
    (action: NextBestAction) => {
      switch (action.key) {
        case "connect":
          openTab({
            kind: "settings",
            title: "Settings",
            payload: { kind: "settings" },
            dirty: false,
            pinned: false,
          });
          break;
        case "run_agent":
          void openAgentTab("engineer");
          break;
        case "review_approval":
          openTab({
            kind: "home",
            title: "Home",
            payload: { kind: "home" },
            dirty: false,
            pinned: true,
          });
          break;
        case "seed_brain":
        default:
          window.location.href = action.href;
          break;
      }
    },
    [openTab, openAgentTab],
  );

  const goToBuild = useCallback(() => {
    const home = tabs.find((t) => t.kind === "home");
    setActiveTab(home ? home.id : "home-default");
    requestAnimationFrame(() => {
      document
        .getElementById("workspace-build")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    if (buildStatus === "failed" && runPaused) return;
    if (buildStatus === "failed") {
      requestBuilderRetry();
      return;
    }
    let tries = 0;
    const tryFocus = () => {
      const ta = document.getElementById(
        "workspace-build-composer",
      ) as HTMLTextAreaElement | null;
      if (ta && !ta.disabled) {
        ta.focus({ preventScroll: true });
        return;
      }
      if (++tries < 5) setTimeout(tryFocus, 200);
    };
    setTimeout(tryFocus, 200);
  }, [tabs, setActiveTab, buildStatus, runPaused, requestBuilderRetry]);

  if (!state || state.activated || dismissed || !buildLoaded) return null;

  const effectiveIntent = resolveRailPosture(buildAppIntent, buildEnabled);
  const isFreshBuild = effectiveIntent === "fresh";

  const { milestones, railLabel } = gettingStartedCopy(effectiveIntent, companyScaleSegment);
  const done = isFreshBuild
    ? freshBuildCompleted(state, buildStatus)
    : hasProductCompleted(state);

  const fresh = isFreshBuild ? freshBuildCta(buildStatus, runPaused) : null;
  const actionLabel = fresh ? fresh.label : state.next_best_action.label;
  const actionCta = fresh ? fresh.cta : ctaText(state.next_best_action.key);
  const onCtaClick = fresh ? goToBuild : () => onAction(state.next_best_action);

  if (isFreshBuild && done >= milestones.length) return null;

  return (
    <div
      role="region"
      aria-label={railLabel}
      className="flex items-center gap-4 border-b border-ink/[0.08] bg-white px-4 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="hidden shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-inkMuted sm:inline">
          {railLabel}
        </span>
        {}
        <span className="flex shrink-0 items-center gap-2" aria-hidden>
          {milestones.map((m, i) => (
            <span
              key={m}
              title={m}
              className={`h-1.5 w-6 rounded-full ${
                i < done ? "bg-emerald-500" : "bg-ink/[0.12]"
              }`}
            />
          ))}
        </span>
        <span className="shrink-0 text-[12px] font-medium text-inkMuted">
          {done} of {milestones.length}
        </span>
      </div>

      <span className="min-w-0 flex-1 truncate text-[16px] text-ink">
        {actionLabel}
      </span>

      <button
        type="button"
        onClick={onCtaClick}
        aria-label={fresh ? `${actionLabel}: ${actionCta}` : undefined}
        className="shrink-0 cursor-pointer rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-cream transition-colors duration-150 hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
      >
        {actionCta}
      </button>

      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss getting started"
        className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-inkMuted transition-colors duration-150 hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
          <path d="M6 6 18 18M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

function ctaText(key: string): string {
  switch (key) {
    case "seed_brain":
      return "Finish setup";
    case "connect":
      return "Connect";
    case "run_agent":
      return "Run an agent";
    case "review_approval":
      return "Review";
    default:
      return "Open";
  }
}

function CloseGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12.9167 12.9167" fill="none" aria-hidden className={className}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M0.183058 0.183058C0.427136 -0.0610194 0.822864 -0.0610194 1.06694 0.183058L6.45833 5.57445L11.8497 0.183058C12.0938 -0.0610194 12.4895 -0.0610194 12.7336 0.183058C12.9777 0.427136 12.9777 0.822864 12.7336 1.06694L7.34222 6.45833L12.7336 11.8497C12.9777 12.0938 12.9777 12.4895 12.7336 12.7336C12.4895 12.9777 12.0938 12.9777 11.8497 12.7336L6.45833 7.34222L1.06694 12.7336C0.822864 12.9777 0.427136 12.9777 0.183058 12.7336C-0.0610194 12.4895 -0.0610194 12.0938 0.183058 11.8497L5.57445 6.45833L0.183058 1.06694C-0.0610194 0.822864 -0.0610194 0.427136 0.183058 0.183058Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function BrainSetupPanel({
  brain,
  onDismiss,
  defaultExpanded = false,
}: {
  brain: BrainState;
  onDismiss: () => void;
  defaultExpanded?: boolean;
}) {
  const { openTab } = useWorkspace();
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [slots, setSlots] = useState<BrainSlotState[]>(brain.slots);
  const [submitted, setSubmitted] = useState<Set<string>>(new Set());
  const [gapList] = useState<string[]>(() => {
    const bySlug: Record<string, SlotStatus> = {};
    for (const s of brain.slots) bySlug[s.slug] = s.status;
    return HUMAN_GAP_SLUGS.filter(
      (slug) => bySlug[slug] === "missing" || bySlug[slug] === "thin",
    );
  });
  const [gapIdx, setGapIdx] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dbFormOpen, setDbFormOpen] = useState(false);
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled || !tenantId) return;
        const { data, error: readErr } = await sb
          .from("connector_metadata")
          .select("slug")
          .eq("tenant_id", tenantId);
        if (cancelled || readErr || !data) return;
        const map: Record<string, boolean> = {};
        for (const row of data as Array<{ slug: string }>) map[row.slug] = true;
        if (!cancelled) setConnected(map);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const statusBySlug = useMemo(() => {
    const m: Record<string, SlotStatus> = {};
    for (const s of slots) m[s.slug] = s.status;
    return m;
  }, [slots]);

  const filled = slots.filter((s) => s.status === "filled").length;

  const remaining = gapList.filter(
    (slug) =>
      !submitted.has(slug) &&
      (statusBySlug[slug] === "missing" || statusBySlug[slug] === "thin"),
  );
  const step = Math.min(gapIdx, Math.max(gapList.length - 1, 0));
  const currentSlug =
    remaining.length > 0 ? (gapList[step] ?? null) : null;
  const answer = currentSlug ? (drafts[currentSlug] ?? "") : "";

  const goBack = () => {
    setError(null);
    setGapIdx((i) => Math.max(0, i - 1));
  };

  async function submit() {
    if (!currentSlug) return;
    const text = answer.trim();
    if (text.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/onboarding/gap-answer", {
        method: "POST",
        body: JSON.stringify({ slug: currentSlug, answer: text }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      const data = (await res.json()) as {
        ok: boolean;
        slot?: { slug: string; status: SlotStatus };
      };
      const newStatus: SlotStatus = data.slot?.status ?? "filled";
      setSlots((prev) =>
        prev.map((s) =>
          s.slug === currentSlug ? { ...s, status: newStatus } : s,
        ),
      );
      setSubmitted((prev) => new Set(prev).add(currentSlug));
      setGapIdx((i) => Math.min(i + 1, Math.max(gapList.length - 1, 0)));
    } catch (e) {
      setError((e as Error).message ?? "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  const openSettingsTab = () => {
    openTab({
      kind: "settings",
      title: "Settings",
      payload: { kind: "settings" },
      dirty: false,
      pinned: false,
    });
  };

  return (
    <section
      role="region"
      aria-label="Finish setting up your company"
      className="flex flex-col gap-5 rounded-[17px] border border-[#f0f0f0] bg-white p-4"
    >
      {}
      <header className="flex items-center gap-4 sm:gap-8">
        <h2 className="min-w-0 flex-1 text-[20px] font-semibold leading-7 text-[#0e0f11]">
          Finish setting up your company
        </h2>
        <span className="shrink-0 whitespace-nowrap text-[16px] font-semibold leading-6 text-[#1f1f1f]">
          {filled}/{brain.total} Setups
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss brain setup"
          className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[#f0f0f0] bg-[#f9f9f9] text-[#1f1f1f] transition-colors hover:bg-[#f0f0f0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          <CloseGlyph className="h-[13px] w-[13px]" />
        </button>
      </header>

      {!expanded && (
        <p className="text-[16px] leading-[1.55] text-[#595959]">
          The more your AI team knows about your business, the more it runs
          growth, support, and ops for you, automatically.{" "}
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="font-semibold text-[#0e0f11] underline-offset-2 hover:underline"
          >
            Finish setup <NextChevron />
          </button>
        </p>
      )}

      {expanded && (
        <>
          {}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[16px] leading-[26px] tracking-[0.16px] text-[#595959]">
                Connect your tools
              </h3>
              <button
                type="button"
                onClick={openSettingsTab}
                className="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-2xl px-2.5 text-[13px] font-semibold leading-5 tracking-[0.01px] text-[#027bff] transition-colors hover:bg-[#027bff]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#027bff]/40"
              >
                Browse Tools
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {CONNECT_TILES.map((tile) => (
                <div
                  key={tile.slug}
                  className="flex flex-col gap-5 rounded-2xl border border-[#f0f0f0] bg-white p-4"
                >
                  <div className="flex items-start gap-2.5">
                    <img
                      src={tile.icon}
                      alt=""
                      aria-hidden
                      className="h-6 w-6 shrink-0"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="text-[16px] font-semibold leading-5 text-[#0e0f11]">
                        {tile.label}
                      </div>
                      <div className="truncate text-[13px] leading-[18px] tracking-[0.13px] text-[#595959]">
                        {tile.helps}
                      </div>
                    </div>
                  </div>
                  <div className="mt-auto">
                    {tile.slug === "operator_db" ? (
                      <button
                        type="button"
                        onClick={() => setDbFormOpen((v) => !v)}
                        className="inline-flex h-10 w-full items-center justify-center whitespace-nowrap rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold leading-[20px] tracking-[0.01px] text-[#1f1f1f] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa]"
                      >
                        {dbFormOpen
                          ? "Cancel"
                          : connected[tile.slug]
                            ? "Reconnect"
                            : "Connect"}
                      </button>
                    ) : (
                      <ConnectButton
                        slug={tile.slug}
                        connected={!!connected[tile.slug]}
                        className="w-full"
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
            {}
            {dbFormOpen && <OperatorDbForm onClose={() => setDbFormOpen(false)} />}
          </section>

          {}
          <div className="w-full border-t border-[#f0f0f0]" aria-hidden />

          {}
          <section>
            {currentSlug ? (
              <div className="flex flex-col gap-3">
                <label
                  htmlFor={`gap-${currentSlug}`}
                  className="block text-[16px] font-medium leading-[26px] tracking-[0.16px] text-[#0e0f11]"
                >
                  {GAP_QUESTIONS[currentSlug]}
                </label>
                <textarea
                  id={`gap-${currentSlug}`}
                  value={answer}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [currentSlug]: e.target.value }))
                  }
                  rows={3}
                  maxLength={4000}
                  placeholder="Type your answer…"
                  className="w-full resize-y rounded-xl border border-[#f0f0f0] bg-white px-3.5 py-2.5 text-[16px] leading-5 text-[#0e0f11] outline-none transition-colors placeholder:text-[#8f8f8f] focus:border-[#d0d0d0]"
                />
                {error && (
                  <div role="alert" className="text-[13px] font-medium text-rose-700">
                    {error}
                  </div>
                )}
                {}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="inline-flex items-center rounded-full bg-white px-3 py-1.5 text-[13px] font-medium leading-[18px] tracking-[0.13px] text-[#595959]">
                    {GAP_LABELS[currentSlug] ?? currentSlug} · {remaining.length} left
                  </span>
                  <div className="flex items-center gap-3">
                    {step > 0 && (
                      <button
                        type="button"
                        onClick={goBack}
                        disabled={submitting}
                        className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold leading-[20px] tracking-[0.01px] text-[#1f1f1f] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa] disabled:opacity-50"
                      >
                        Back
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={submit}
                      disabled={submitting || answer.trim().length === 0}
                      className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-cta bg-[#0e0f11] pl-5 pr-4 text-[16px] font-semibold leading-[20px] tracking-[0.01px] text-white transition-colors hover:bg-[#0e0f11]/85 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
                    >
                      {submitting ? "Saving…" : "Save & continue"}
                      <NextChevron />
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[16px] leading-[1.55] text-[#595959]">
                All set. Your team has what it needs from you. Connect more
                sources above to fill the rest automatically.
              </p>
            )}
          </section>
        </>
      )}
    </section>
  );
}

type OnboardingMemoryStatus = "pending" | "ready" | "failed" | null;
export const ONBOARDING_MEMORY_POLL_MS = 5_000;
const ONBOARDING_MEMORY_MAX_FAILED_READS = 5;

export function OnboardingMemoryBanner() {
  const [status, setStatus] = useState<OnboardingMemoryStatus>(null);
  const [round, setRound] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = round > 0;
    let failedReads = 0;
    const poll = async () => {
      let readOk = false;
      try {
        const res = await apiFetch("/api/workspace/activation");
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { memory_status?: OnboardingMemoryStatus };
          if (cancelled) return;
          const next = data.memory_status ?? null;
          setStatus(next);
          pending = next === "pending";
          readOk = true;
          failedReads = 0;
        }
      } catch {
      }
      if (!readOk) failedReads += 1;
      const again = pending || (!readOk && failedReads <= ONBOARDING_MEMORY_MAX_FAILED_READS);
      if (!cancelled && again) timer = setTimeout(() => void poll(), ONBOARDING_MEMORY_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [round]);

  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await apiFetch("/api/workspace/onboarding-memory/retry", { method: "POST" });
      if (res.ok) {
        setStatus("pending");
        setRound((n) => n + 1);
      } else if (res.status === 409) {
        setRound((n) => n + 1);
      } else {
        setRetryError(
          res.status === 429
            ? "Too many tries. Wait a minute, then try again."
            : "Couldn't start that again. Please try again.",
        );
      }
    } catch {
      setRetryError("Couldn't reach Zavi. Check your connection and try again.");
    } finally {
      setRetrying(false);
    }
  };

  if (status === "pending")
    return (
      <div className="mb-4 flex items-center gap-2 rounded-2xl border border-rule bg-white px-4 py-3 text-[14px] text-ink">
        <p role="status" className="zavi-shimmer">Zavi is reading your site…</p>
      </div>
    );
  if (status === "failed")
    return (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rule bg-white px-4 py-3 text-[14px] text-ink">
        <div className="min-w-0">
          <p role="alert">Zavi couldn&apos;t finish reading your site</p>
          {retryError && <p className="mt-1 text-[13px] text-ink/60">{retryError}</p>}
        </div>
        <button
          type="button"
          onClick={() => void retry()}
          disabled={retrying}
          className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-white disabled:opacity-60"
        >
          Retry
        </button>
      </div>
    );
  return null;
}

export function BrainSetupCard() {
  const { buildAppIntent } = useBuildProduct();
  const [brain, setBrain] = useState<BrainState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/workspace/activation");
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as ActivationState;
        if (!cancelled) setBrain(data.brain ?? null);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isFreshBuild = resolveWorkspaceSegment(buildAppIntent) === "fresh_build";
  const showPanel = !dismissed && !isFreshBuild && !!brain && brain.filled < brain.total;
  return (
    <>
      <OnboardingMemoryBanner />
      {showPanel && brain && (
        <BrainSetupPanel brain={brain} onDismiss={() => setDismissed(true)} />
      )}
    </>
  );
}
