"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";

const ConnectedSlugs = createContext<ReadonlySet<string> | null>(null);

function useConnectedSlugs(open: boolean): ReadonlySet<string> | null {
  const [slugs, setSlugs] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/connectors");
        if (!res.ok) return;
        const body = (await res.json()) as { connectors?: { slug: string }[] };
        const set = new Set(
          (body.connectors ?? []).map((c) => c.slug.replace(/^(?:pipedream|composio)\./, "")),
        );
        if (!cancelled) setSlugs(set);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);
  return slugs;
}

export type HowZaviAction =
  | "ask"
  | "connectSlack"
  | "connect"
  | "brain"
  | "team"
  | "review"
  | "autopilot";

export function howZaviConnectDestination(
  action: "connectSlack" | "connect",
): "messaging" | "brain" {
  return action === "connectSlack" ? "messaging" : "brain";
}

type StepAction = { label: string; action: HowZaviAction; primary?: boolean };
type Step = {
  headline: string;
  line: string;
  actions: StepAction[];
  visual: ReactNode;
};

function SlackChatVisual() {
  return (
    <div className="w-full max-w-[420px] rounded-xl border border-ink/[0.08] bg-white p-3.5 shadow-sm">
      <div className="mb-2.5 flex items-center gap-2 border-b border-ink/[0.06] pb-2.5">
        <img src="/logos/slack-color.svg" alt="" aria-hidden className="h-4 w-4" />
        <span className="text-[12px] font-semibold text-ink">#founders</span>
      </div>
      <div className="flex flex-col gap-2.5 text-[13px] leading-[1.5]">
        <div>
          <span className="font-semibold text-ink">You</span>{" "}
          <span className="text-ink/80">@Zavi how did signups trend this week?</span>
        </div>
        <div>
          <span className="font-semibold text-[#611f69]">Zavi</span>{" "}
          <span className="text-ink/80">
            Up 18% week-over-week, 332 signups. Bookings flat, so activation is the
            bottleneck.
          </span>
        </div>
      </div>
    </div>
  );
}

function ChatVisual() {
  return (
    <div className="flex w-full max-w-[420px] flex-col gap-3">
      <div className="self-end rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[13px] text-cream shadow-sm">
        What needs my attention right now?
      </div>
      <div className="self-start rounded-2xl rounded-bl-md border border-ink/[0.08] bg-white px-4 py-3 text-[13px] leading-[1.5] text-ink shadow-sm">
        <span className="font-medium">3 things.</span> A $1,388 refund to review, an
        ad running below your ROAS floor, and 2 hosts stuck in verification.
        <div className="mt-2.5 flex items-end gap-1" aria-hidden>
          {[34, 41, 38, 52, 47, 63, 71].map((h, i) => (
            <span
              key={i}
              className="w-full rounded-sm bg-emerald-400/70"
              style={{ height: `${h}px` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const CONNECTORS = [
  { name: "Slack", slug: "slack", icon: "/logos/slack-color.svg", on: true, featured: true },
  { name: "Your database", slug: "operator_db", icon: "/logos/database-icon.svg", on: false },
  { name: "Stripe", slug: "stripe", icon: "/logos/stripe-icon.svg", on: false },
  { name: "GitHub", slug: "github", icon: "/logos/github-icon.svg", on: false },
  { name: "Meta Ads", slug: "meta_ads", icon: "/logos/meta-icon.svg", on: false },
  { name: "Google Ads", slug: "google_ads", icon: "/logos/google-icon.svg", on: false },
  { name: "Jira", slug: "jira", icon: "/integrations/jira.svg", on: false },
  { name: "Linear", slug: "linear", icon: "/logos/linear-icon.svg", on: false },
];

function ConnectorsVisual() {
  const connected = useContext(ConnectedSlugs);
  return (
    <div className="grid w-full max-w-[440px] grid-cols-2 gap-2.5">
      {CONNECTORS.map((known) => {
        const c = connected
          ? { ...known, on: connected.has(known.slug), featured: known.featured && !connected.has(known.slug) }
          : known;
        return (
        <div
          key={c.name}
          className={`flex items-center gap-2.5 rounded-xl border bg-white px-3 py-2.5 shadow-sm ${
            c.featured ? "border-emerald-400 ring-1 ring-emerald-400/40" : "border-ink/[0.08]"
          }`}
        >
          <img src={c.icon} alt="" aria-hidden className="h-5 w-5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
            {c.name}
          </span>
          {c.featured ? (
            <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-[11px] font-semibold text-white">
              Start here
            </span>
          ) : c.on ? (
            <span className="text-[11px] font-medium text-emerald-600">On</span>
          ) : (
            <span className="text-[11px] font-medium text-inkMuted/70">Connect</span>
          )}
        </div>
        );
      })}
    </div>
  );
}

function BrainVisual() {
  const filled = 4;
  return (
    <div className="w-full max-w-[400px] rounded-2xl border border-ink/[0.08] bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-ink">Company brain</span>
        <span className="text-[13px] font-semibold text-ink">{filled}/10</span>
      </div>
      <div className="mt-3 grid grid-cols-10 gap-2" aria-hidden>
        {Array.from({ length: 10 }).map((_, i) => (
          <span
            key={i}
            className={`h-2 rounded-full ${i < filled ? "bg-emerald-500" : "bg-ink/[0.12]"}`}
          />
        ))}
      </div>
      <div className="mt-4 rounded-xl bg-[#f7f7f8] px-3.5 py-3 text-[13px] leading-[1.5] text-ink/80">
        What&apos;s the single metric your team optimizes for right now?
      </div>
    </div>
  );
}

const TEAM = [
  { name: "Engineer", role: "ships fixes & features", tone: "bg-blue-100 text-blue-700" },
  { name: "Ads Manager", role: "tunes paid spend", tone: "bg-amber-100 text-amber-700" },
  { name: "Product Manager", role: "specs & prioritizes", tone: "bg-violet-100 text-violet-700" },
  { name: "Research", role: "intel & hard answers", tone: "bg-rose-100 text-rose-700" },
];

function TeamVisual() {
  return (
    <div className="flex w-full max-w-[420px] flex-col gap-2.5">
      {TEAM.map((a) => (
        <div
          key={a.name}
          className="flex items-center gap-3 rounded-xl border border-ink/[0.08] bg-white px-3.5 py-2.5 shadow-sm"
        >
          <span
            aria-hidden
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${a.tone}`}
          >
            {a.name[0]}
          </span>
          <span className="text-[13px] font-semibold text-ink">{a.name}</span>
          <span className="ml-auto text-[12px] text-inkMuted">{a.role}</span>
        </div>
      ))}
      <div className="pl-1 text-[12px] text-inkMuted">
        + Content Designer, Fundraising, Browser Operator, and more
      </div>
    </div>
  );
}

function ApprovalVisual() {
  return (
    <div className="w-full max-w-[420px] rounded-2xl border border-ink/[0.08] bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-[12px] font-medium text-inkMuted">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        Needs you now · Ads Manager
      </div>
      <p className="mt-2 text-[16px] leading-[1.5] text-ink">
        Pause &quot;Bay Area Rentals.&quot; It&apos;s spent $340 at 1.03&times; ROAS,
        below your 1.5&times; floor.
      </p>
      <div className="mt-3 space-y-1 text-[12px] leading-[1.5]">
        <div>
          <span className="font-medium text-emerald-700">If approved</span>
          <span className="text-inkMuted">: stops delivering, stops spending.</span>
        </div>
        <div>
          <span className="font-medium text-rose-700">If rejected</span>
          <span className="text-inkMuted">: keeps running at a loss.</span>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <span className="rounded-lg bg-ink px-3.5 py-1.5 text-[13px] font-medium text-cream">
          Approve
        </span>
        <span className="rounded-lg border border-ink/[0.14] px-3.5 py-1.5 text-[13px] font-medium text-ink">
          Edit
        </span>
        <span className="px-2 py-1.5 text-[13px] font-medium text-inkMuted">Dismiss</span>
      </div>
    </div>
  );
}

function AutopilotVisual() {
  return (
    <div className="w-full max-w-[400px] rounded-2xl border border-ink/[0.08] bg-white p-4 shadow-sm">
      <div className="text-[12px] font-medium uppercase tracking-[0.1em] text-inkMuted">
        Goal
      </div>
      <p className="mt-1.5 text-[14px] font-semibold text-ink">
        Grow weekly signups
      </p>
      <div className="mt-4 flex items-center justify-between text-[12px] text-inkMuted">
        <span>Signups this week</span>
        <span>
          <span className="font-semibold text-ink">612</span> / 800
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-ink/[0.1]" aria-hidden>
        <div className="h-full rounded-full bg-emerald-500" style={{ width: "76%" }} />
      </div>
      <div className="mt-4 rounded-xl bg-[#f7f7f8] px-3.5 py-2.5 text-[12px] leading-[1.5] text-ink/80">
        This week: shortened the signup form, drafted 3 reactivation emails.
        Flagged 1 thing for you.
      </div>
    </div>
  );
}

const STEPS: Step[] = [
  {
    headline: "Get answers about your business in seconds",
    line: "Ask your team anything in plain English and it pulls your live numbers, then tells you what they mean.",
    actions: [{ label: "Ask Zavi", action: "ask", primary: true }],
    visual: <ChatVisual />,
  },
  {
    headline: "It runs on your real data, not a demo",
    line: "Slack is the fastest to connect and lets you chat where you work. Then plug in your database, Stripe, GitHub, ads, and trackers. The more you connect, the more your team runs without you.",
    actions: [{ label: "Connect tools", action: "connect", primary: true }],
    visual: <ConnectorsVisual />,
  },
  {
    headline: "It gets smarter about your company",
    line: "Answer a few questions once: how you make money, your customers, your north-star metric. Every agent then acts on your context, not generically.",
    actions: [{ label: "Finish setup", action: "brain", primary: true }],
    visual: <BrainVisual />,
  },
  {
    headline: "A full team of specialists",
    line: "Beyond Zavi you have a human. Hand each job to the agent built for it.",
    actions: [{ label: "Meet your team", action: "team", primary: true }],
    visual: <TeamVisual />,
  },
  {
    headline: "You approve, they act",
    line: "Your team proposes, you decide. Anything that needs a call lands in “Needs you now.” Approve, edit, or dismiss in one tap.",
    actions: [{ label: "Review what needs you", action: "review", primary: true }],
    visual: <ApprovalVisual />,
  },
  {
    headline: "Let it run on autopilot",
    line: "Set a goal and your team works toward it between check-ins, then reports back what it did and flags only what needs you.",
    actions: [{ label: "Open your growth plan", action: "autopilot", primary: true }],
    visual: <AutopilotVisual />,
  },
];

export function HowZaviWorksModal({
  open,
  onClose,
  onAction,
}: {
  open: boolean;
  onClose: () => void;
  onAction: (action: HowZaviAction) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const connected = useConnectedSlugs(open);

  if (!open) return null;

  return (
    <ConnectedSlugs.Provider value={connected}>
      {}
      <div aria-hidden onClick={onClose} className="fixed inset-0 z-[80] bg-ink/30" />

      {}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="How Zavi works"
        className="fixed left-1/2 top-1/2 z-[90] flex max-h-[88vh] w-[min(680px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-ink/[0.1] bg-white shadow-[0_24px_70px_rgba(25,25,25,0.28)]"
      >
        {}
        <div className="flex items-start gap-4 border-b border-[#f0f0f0] px-6 py-4">
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[20px] font-semibold text-ink">
              How Zavi works
            </h1>
            <p className="mt-0.5 text-[13px] text-inkMuted">
              Zavi, working on your growth.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
          >
            <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
              <path d="M6 6 18 18M18 6 6 18" />
            </svg>
          </button>
        </div>

        {}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {}
          {!connected?.has("slack") && (
          <div className="mb-8 flex flex-col gap-3 rounded-2xl border border-emerald-300 bg-emerald-50/60 p-4">
            <div className="flex items-center gap-2.5">
              <img src="/logos/slack-color.svg" alt="" aria-hidden className="h-6 w-6" />
              <span className="rounded-full bg-emerald-500 px-2.5 py-0.5 text-[11px] font-semibold text-white">
                Best first move
              </span>
            </div>
            <div>
              <h2 className="font-display text-[16px] font-semibold text-ink">
                Connect Slack and start chatting with Zavi
              </h2>
              <p className="mt-1 text-[16px] leading-[1.55] text-ink/80">
                It&apos;s the fastest tool to connect, and it lets you talk to your
                whole team right where you already work. @mention or DM Zavi in any
                channel and it answers in the thread.
              </p>
            </div>
            <SlackChatVisual />
            <div>
              <button
                type="button"
                onClick={() => onAction("connectSlack")}
                className="inline-flex cursor-pointer items-center rounded-cta bg-ink px-4 py-2 text-[13px] font-medium text-cream transition-colors hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
              >
                Connect Slack
              </button>
            </div>
          </div>
          )}

          {}
          <ol className="flex flex-col gap-9">
            {STEPS.map((s, i) => (
              <li key={s.headline} className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-semibold text-cream"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[16px] font-semibold leading-snug text-ink">
                      {s.headline}
                    </h3>
                    <p className="mt-1 text-[16px] leading-[1.55] text-inkMuted">
                      {s.line}
                    </p>
                  </div>
                </div>
                {}
                <div className="flex justify-center rounded-2xl bg-[#fafafb] px-4 py-6">
                  {s.visual}
                </div>
                <div className="flex flex-wrap gap-2.5">
                  {s.actions.map((a) => (
                    <button
                      key={a.action}
                      type="button"
                      onClick={() => onAction(a.action)}
                      className={
                        a.primary
                          ? "inline-flex cursor-pointer items-center rounded-cta bg-ink px-4 py-2 text-[13px] font-medium text-cream transition-colors hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
                          : "inline-flex cursor-pointer items-center rounded-cta border border-ink/[0.14] bg-white px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
                      }
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </ConnectedSlugs.Provider>
  );
}
