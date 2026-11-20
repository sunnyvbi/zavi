"use client";

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import {
  useResizablePane,
  type ClampSpec,
  type UseResizablePaneOptions,
} from "@/hooks/useResizablePane";
import { apiFetch } from "@/lib/api";
import { useWorkspace } from "../../WorkspaceShell";
import { normalizeSummary } from "../summary";
import type { HomeSummaryPayload } from "../types";
import { coerceGoals, type HomeGoal } from "./calmTypes";
import { SetupStrip } from "./SetupStrip";
import { BusinessInboxAddress } from "../../BusinessInboxAddress";
import { CalmHomeSkeleton } from "./CalmHomeSkeleton";
import { NeedsYouNow } from "./NeedsYouNow";
import { GoalsSection } from "./GoalsSection";
import { AddGoalModal } from "./AddGoalModal";
import { HomeChatPanel } from "./HomeChatPanel";
import { BrainSetupPanel, OnboardingMemoryBanner, type BrainState } from "../../GettingStartedCard";
import { BuilderChatCard } from "../BuilderChatCard";
import { NextChevron } from "@/components/ui/NextChevron";

type ActivationLite = { brain: BrainState | null; connectorsCount: number | null };

const SUGGESTIONS = [
  "What did the team do this week?",
  "What needs my attention right now?",
  "Draft a short update for investors",
];

const HOME_CHAT_WIDTH_KEY = "zavi.homeChatWidth";
const CHAT_MIN_PX = 340;
const CHAT_MAX_FRACTION = 0.4;
const CHAT_DEFAULT_PX = 405;

const HOME_CHAT_CLAMP: ClampSpec = {
  min: CHAT_MIN_PX,
  maxFraction: CHAT_MAX_FRACTION,
  round: "max",
};

export const HOME_CHAT_PANE_OPTIONS: UseResizablePaneOptions = {
  ...HOME_CHAT_CLAMP,
  storageKey: HOME_CHAT_WIDTH_KEY,
  defaultPx: CHAT_DEFAULT_PX,
  resetTo: CHAT_DEFAULT_PX,
  trackDragging: true,
  ariaLabel: "Resize chat",
};

function fmtCredits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return `${n}`;
}

function greetingName(email?: string): string | null {
  if (!email) return null;
  const local = (email.split("@")[0] ?? "").replace(/[._-]/g, " ").replace(/\d+/g, " ");
  const first = local.trim().split(/\s+/)[0] ?? "";
  if (first.length < 2) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function timeGreeting(now: Date): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function countAnswered(runs: HomeSummaryPayload["active_runs_today"]): number {
  let n = 0;
  for (const r of runs) {
    if (r.presentation_status) {
      if (r.presentation_status === "answered") n++;
    } else if (r.status === "success") n++;
  }
  return n;
}

export function CalmHome() {
  const { userEmail, openTab, creditsRemaining, role } = useWorkspace();
  const canEditGoals = role == null || role === "owner" || role === "admin";

  const [phase, setPhase] = useState<"loading" | "provisioning" | "error" | "ok">(
    "loading",
  );
  const [summary, setSummary] = useState<HomeSummaryPayload | null>(null);
  const [goals, setGoals] = useState<HomeGoal[]>([]);
  const [activation, setActivation] = useState<ActivationLite>({
    brain: null,
    connectorsCount: null,
  });
  const [activationLoaded, setActivationLoaded] = useState(false);

  const [goalModalOpen, setGoalModalOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);

  const {
    sizePx: chatWidthOrNull,
    dragging: chatDragging,
    separatorProps: chatSeparatorProps,
  } = useResizablePane(HOME_CHAT_PANE_OPTIONS);
  const chatWidth = chatWidthOrNull ?? CHAT_DEFAULT_PX;

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const res = await apiFetch("/api/home/summary");
      if (res.status === 202) {
        setPhase("provisioning");
        return;
      }
      if (!res.ok) {
        setPhase("error");
        return;
      }
      const raw: unknown = await res.json();
      setSummary(normalizeSummary(raw));
      setGoals(coerceGoals(raw));
      setPhase("ok");
    } catch {
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/workspace/activation");
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as {
          brain?: {
            filled?: number;
            total?: number;
            slots?: Array<{ slug?: string; status?: string }>;
          };
          connectors_count?: number;
        };
        if (cancelled) return;
        const brain: BrainState | null =
          data.brain && typeof data.brain.filled === "number"
            ? {
                filled: data.brain.filled,
                total: 10,
                slots: Array.isArray(data.brain.slots)
                  ? data.brain.slots.flatMap((s) =>
                      typeof s?.slug === "string" &&
                      (s.status === "missing" || s.status === "thin" || s.status === "filled")
                        ? [{ slug: s.slug, status: s.status }]
                        : [],
                    )
                  : [],
              }
            : null;
        setActivation({
          brain,
          connectorsCount:
            typeof data.connectors_count === "number" ? data.connectors_count : null,
        });
      } catch {
      } finally {
        if (!cancelled) setActivationLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openStaticTab = useCallback(
    (kind: "settings" | "brain") => {
      if (kind === "settings") {
        openTab({
          kind: "settings",
          title: "Settings",
          payload: { kind: "settings" },
          dirty: false,
          pinned: false,
        });
      } else {
        openTab({
          kind: "brain",
          title: "Brain",
          payload: { kind: "brain" },
          dirty: false,
          pinned: false,
        });
      }
    },
    [openTab],
  );

  if (phase === "provisioning") {
    return (
      <Center>
        <Spinner />
        <h2 className="font-display text-[20px] font-semibold text-ink">
          Setting up your workspace…
        </h2>
        <p className="max-w-md text-[16px] leading-[1.55] text-inkMuted">
          Your team is writing your company brief and priorities from your signup
          signals. Usually about 10 seconds.
        </p>
        <RetryButton onClick={() => void load()} label="Refresh" />
      </Center>
    );
  }

  if (phase === "error") {
    return (
      <Center>
        <h2 className="font-display text-[20px] font-semibold text-ink">
          Couldn&apos;t load your home
        </h2>
        <p className="max-w-md text-[16px] leading-[1.55] text-inkMuted">
          We hit a snag loading your Home summary. Your workspace is fine. This
          is usually temporary.
        </p>
        <RetryButton onClick={() => void load()} label="Retry" />
      </Center>
    );
  }

  const name = greetingName(userEmail);
  const now = new Date();
  const greeting = `${timeGreeting(now)}${name ? `, ${name}.` : "."}`;

  const runs = summary?.active_runs_today ?? [];
  const runsToday = runs.length;
  const answered = countAnswered(runs);
  const needsYou = summary?.pending_approvals_count ?? 0;

  const initialLoading = phase === "loading" || !activationLoaded;

  const pulse =
    phase === "loading" ? (
      <span className="inline-block h-4 w-64 animate-pulse rounded bg-[#f0f0f0] align-middle" />
    ) : runsToday === 0 ? (
      <>No runs yet today. Hand your team something below.</>
    ) : (
      <>
        Your team ran <b className="text-ink">{runsToday}</b>{" "}
        {runsToday === 1 ? "task" : "tasks"} today
        {answered > 0 && (
          <>
            {" "}
            and handled <b className="text-ink">{answered}</b> on its own
          </>
        )}
        .{" "}
        {needsYou > 0 ? (
          <>
            {}
            <button
              type="button"
              onClick={() =>
                openTab({ kind: "needs-you", title: "Needs you", payload: { kind: "needs-you" }, dirty: false, pinned: false })
              }
              className="font-bold text-ink underline decoration-rule underline-offset-2 hover:decoration-ink"
            >
              {needsYou} {needsYou === 1 ? "thing" : "things"}
            </button>{" "}
            {needsYou === 1 ? "needs" : "need"} a call from you.
          </>
        ) : (
          <>Nothing needs a call from you right now.</>
        )}
      </>
    );

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden bg-white"
      style={{ "--home-chat-w": `${chatWidth + 6}px` } as CSSProperties}
    >
      {}
      <div
        aria-hidden={chatExpanded}
        className={`h-full min-w-0 overflow-y-auto overflow-x-auto transition-opacity duration-200 lg:mr-[var(--home-chat-w)] ${
          chatExpanded ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <div className="mx-auto flex min-w-[480px] max-w-[900px] flex-col px-6 pb-16 pt-6">
          {initialLoading ? (
            <CalmHomeSkeleton />
          ) : (
            <>
          {}
          <OnboardingMemoryBanner />
          <SetupStrip brain={activation.brain} onFinish={() => setSetupOpen(true)} />
          {setupOpen && activation.brain && (
            <div className="mb-6">
              <BrainSetupPanel
                brain={activation.brain}
                defaultExpanded
                onDismiss={() => setSetupOpen(false)}
              />
            </div>
          )}

          {}

          {}
          <div id="workspace-build" className="w-full [&:not(:empty)]:py-6">
            <BuilderChatCard />
          </div>

          {}
          <NeedsYouNow />

          {}
          <GoalsSection goals={goals} onAddGoal={canEditGoals ? () => setGoalModalOpen(true) : undefined} />

          {}
          <footer className="mt-9 flex flex-wrap items-center gap-3.5 border-t border-[#f0f0f0] pt-4 text-[11px] text-inkMuted/70">
            {activation.connectorsCount != null && (
              <span className="inline-flex items-center gap-2">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                connectors {activation.connectorsCount}
              </span>
            )}
            {typeof creditsRemaining === "number" && (
              <>
                <span aria-hidden>·</span>
                <span>{fmtCredits(creditsRemaining)} credits</span>
              </>
            )}
            <BusinessInboxAddress variant="inline" />
            <button
              type="button"
              onClick={() => openStaticTab("brain")}
              className="ml-auto border-b border-ink/[0.2] text-inkMuted transition-colors hover:border-ink/50 hover:text-ink"
            >
              company brain <NextChevron />
            </button>
          </footer>
            </>
          )}
        </div>
      </div>

      {}
      <HomeChatPanel
        greeting={greeting}
        pulse={pulse}
        suggestions={SUGGESTIONS}
        expanded={chatExpanded}
        onExpandedChange={setChatExpanded}
        width={chatWidth}
        dragging={chatDragging}
        separatorProps={chatSeparatorProps}
      />

      <AddGoalModal
        open={goalModalOpen}
        onClose={() => setGoalModalOpen(false)}
        onCreated={(g) => setGoals((prev) => [g, ...prev])}
      />
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 bg-white px-6 py-12 text-center">
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6 animate-spin text-inkMuted" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M21 12a9 9 0 1 1-6.2-8.55" />
    </svg>
  );
}

function RetryButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-cta bg-ink px-4 py-2 text-[16px] font-medium text-white transition-colors hover:bg-ink/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
    >
      {label}
    </button>
  );
}
