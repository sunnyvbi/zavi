"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MessageSquare, Pencil, X } from "lucide-react";
import { CHANNELS, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import type { GrowthBet, GrowthChannel, GrowthPlanDetail } from "@/lib/workspace/useGrowthPlan";
import { GrowthMovesList } from "./GrowthPlanDetail";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/formatDate";
import { GrowthChannelLabel } from "./GrowthChannelLabel";
import { humanize } from "./growthPresentation";
import { lockedTierOf } from "@/lib/workspace/planUpgrade";
import { tierDisplayName } from "@/lib/marketing/pricing";
import { StoryBox, StoryRow } from "./StoryStep";
import {
  EmptyNote,
  MemoBlock,
  PrimaryButton,
  SecondaryButton,
  SectionAction,
  StatusChip,
  SuggestionChip,
  type ChipTone,
} from "./GrowthSection";

export type ChannelWork = {
  counts: Record<string, number>;
  running: ReadonlySet<string>;
};

export function channelStatus(channel: GrowthChannel, work: ChannelWork | null | undefined): string {
  if (work?.running.has(channel.slug)) return "Running now";
  const n = work?.counts[channel.slug] ?? 0;
  if (n > 0) return `${n} ready`;
  if (channel.last_run_at) return `Last ran ${formatDate(channel.last_run_at, "en-US", "UTC")}`;
  return "Not run yet";
}

export function channelStatusTone(status: string): ChipTone {
  if (status === "Running now") return "live";
  if (status.endsWith(" ready")) return "wait";
  return "quiet";
}

const SPEND_TOOL = /_propose_(?:budget_change|new_campaign|new_ad_set|video_campaign)$/;
const SEND_TOOLS = new Set(["email_send", "outbound__propose_email"]);
export const RISK_BY_SLUG = new Map<string, string>(
  CHANNELS.flatMap((c): Array<[string, string]> =>
    c.tools.some((t) => SPEND_TOOL.test(t))
      ? [[c.slug, "spend money"]]
      : c.tools.some((t) => SEND_TOOLS.has(t))
        ? [[c.slug, "send to your customers"]]
        : [],
  ),
);

export function riskConfirmLine(name: string, risk: string): string {
  if (name === "ChatGPT Ads") return "Allow CGO to create, launch and manage ChatGPT campaigns using your Growth budget and prepaid ChatGPT wallet. This does not enable wallet refills. Pauses and budget cuts still ask you first.";
  return risk === "spend money"
    ? `CGO may run ${name} without asking you, and spend money within your ad budget.`
    : `CGO may run ${name} without asking you. Marketing email sends go out within Autopilot's limits (up to 1,000 people, one send per list a week); anything else it would ${risk} still waits for you.`;
}

const SUGGESTION_ORDER = ["seo", "google_ads", "email_marketing", "meta_ads"];

const NAME_BY_SLUG = new Map<string, string>(CHANNELS.map((c) => [c.slug, c.name]));
export const channelName = (slug: string) => NAME_BY_SLUG.get(slug);

function orderedRegistry(): string[] {
  const rest = CHANNELS.map((c) => c.slug).filter(
    (s) => !SUGGESTION_ORDER.includes(s) && !RETIRED_CHANNEL_SLUGS.has(s),
  );
  return [...SUGGESTION_ORDER.filter((s) => NAME_BY_SLUG.has(s)), ...rest];
}

export function channelsInPlan(
  channels: GrowthChannel[],
  hasLivePlan: boolean,
): GrowthChannel[] {
  return channels.filter(
    (c) =>
      c.plan_selected &&
      (hasLivePlan || c.plan_selected_set_by === "founder"),
  );
}

export function orderedPlanChannels(
  channels: GrowthChannel[],
  bets: GrowthBet[],
  hasLivePlan: boolean,
): GrowthChannel[] {
  const order = new Map<string, number>();
  for (const b of bets) {
    if (b.channel_slug && !order.has(b.channel_slug)) {
      order.set(b.channel_slug, b.sort_order ?? Number.MAX_SAFE_INTEGER);
    }
  }
  const nameOf = (c: GrowthChannel) => channelName(c.slug) ?? c.slug;
  return channelsInPlan(channels, hasLivePlan).sort((a, b) => {
    const oa = order.get(a.slug) ?? Number.POSITIVE_INFINITY;
    const ob = order.get(b.slug) ?? Number.POSITIVE_INFINITY;
    return oa !== ob ? oa - ob : nameOf(a).localeCompare(nameOf(b));
  });
}

export function GrowthChannels({
  channels,
  bets,
  moves,
  unavailable,
  hasLivePlan,
  hasPlan,
  canEdit,
  canStop = canEdit,
  savingSlugs,
  onToggleAutorun,
  onSetInPlan,
  onAskZavi,
  asking,
  error,
  onAsk,
  work = null,
  autopilot = false,
  channelLocks,
  variant = "memo",
  lead,
}: {
  variant?: "memo" | "story";
  lead?: ReactNode;
  channels: GrowthChannel[];
  bets: GrowthBet[];
  moves?: GrowthPlanDetail["growth_moves"];
  unavailable: boolean;
  hasLivePlan: boolean;
  hasPlan: boolean;
  canEdit: boolean;
  canStop?: boolean;
  savingSlugs: ReadonlySet<string>;
  onToggleAutorun: (slug: string, next: boolean) => Promise<void>;
  onSetInPlan: (slug: string, inPlan: boolean) => Promise<void>;
  onAskZavi: () => void;
  asking: boolean;
  error?: string | null;
  onAsk?: (text: string) => void;
  work?: ChannelWork | null;
  autopilot?: boolean;
  channelLocks?: Record<string, unknown> | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!error) return;
    errorRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const inPlan = orderedPlanChannels(channels, bets, hasLivePlan);
  const inPlanSlugs = new Set(inPlan.map((c) => c.slug));
  const pausedByZavi = channels.filter((c) => c.cgo_reason && !inPlanSlugs.has(c.slug));
  const addable = orderedRegistry().filter((s) => !inPlanSlugs.has(s));
  const lockOf = (slug: string): string | null | undefined =>
    channelLocks === undefined
      ? null
      : channelLocks && slug in channelLocks
        ? lockedTierOf({ locked_tier: channelLocks[slug] })
        : undefined;
  const betBySlug = new Map(
    bets.filter((b) => b.channel_slug).map((b) => [b.channel_slug as string, b]),
  );

  const add = (slug: string) => {
    setMenuOpen(false);
    void onSetInPlan(slug, true);
  };

  const menu = (trigger: ReactNode) =>
    canEdit && (
      <div ref={menuRef} className="relative">
        {trigger}
        {menuOpen && (
          <ul
            role="menu"
            aria-label="Channels you can add"
            className="raised-surface absolute left-0 z-20 mt-2 max-h-80 w-64 overflow-y-auto rounded-xl border border-rule bg-cream p-1.5 shadow-lg"
          >
            {addable.map((slug) => (
              <li key={slug} role="none">
                <button
                  type="button"
                  role="menuitem"
                  disabled={savingSlugs.has(slug)}
                  onClick={() => add(slug)}
                  className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm text-ink hover:bg-creamDeep disabled:opacity-40"
                >
                  <GrowthChannelLabel slug={slug} name={channelName(slug)} compact />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );

  if (variant === "story") {
    const askAbout = (slug: string) =>
      onAsk
        ? () =>
            onAsk(
              `Talk me through ${channelName(slug) ?? slug} in my plan: why it's there, how it's doing, and what you'd change.`,
            )
        : undefined;
    return (
      <>
        {error && (
          <p
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="mb-2 text-sm text-warn focus:outline-none dark:text-marigold"
          >
            {error}
          </p>
        )}
        <StoryBox>
          {lead && <StoryRow>{lead}</StoryRow>}
          {unavailable ? (
            <StoryRow>
              <p className="text-sm text-inkMuted">Channels could not be loaded.</p>
            </StoryRow>
          ) : (
            <>
              {inPlan.length === 0 ? (
                <StoryRow>
                  <p className="text-sm text-inkMuted">
                    No channels yet. Add one to put it in your plan.
                    {!hasPlan && (
                      <>
                        {" "}
                        <button
                          type="button"
                          onClick={onAskZavi}
                          disabled={asking}
                          className="font-medium text-ink underline underline-offset-2 disabled:opacity-50"
                        >
                          {asking ? "Asking Zavi…" : "Or ask Zavi to pick them."}
                        </button>
                      </>
                    )}
                  </p>
                </StoryRow>
              ) : (
                inPlan.map((channel) => (
                  <StoryChannelRow
                    key={channel.slug}
                    channel={channel}
                    bet={betBySlug.get(channel.slug)}
                    autopilot={autopilot}
                    lockedTier={lockOf(channel.slug)}
                    canEdit={canEdit}
                    canStop={canStop}
                    saving={savingSlugs.has(channel.slug)}
                    onToggleAutorun={onToggleAutorun}
                    onRemove={() => void onSetInPlan(channel.slug, false)}
                    onAsk={askAbout(channel.slug)}
                  />
                ))
              )}
              {pausedByZavi.length > 0 && (
                <StoryRow>
                  <ul className="space-y-1 text-[13px] text-inkMuted">
                    {pausedByZavi.map((c) => (
                      <li key={c.slug}>
                        {`I paused ${channelName(c.slug) ?? c.slug}: ${c.cgo_reason}`}
                        {canEdit ? " You can add it back below." : ""}
                      </li>
                    ))}
                  </ul>
                </StoryRow>
              )}
              {canEdit && (
                <StoryRow className="py-2.5">
                  {menu(
                    <button
                      type="button"
                      aria-label="Add a channel"
                      disabled={addable.length === 0}
                      onClick={() => setMenuOpen((v) => !v)}
                      className="inline-flex items-center gap-1 text-[13px] font-semibold text-ink underline decoration-rule underline-offset-4 hover:decoration-ink disabled:opacity-40"
                    >
                      + Add a channel
                    </button>,
                  )}
                </StoryRow>
              )}
            </>
          )}
        </StoryBox>
        {!unavailable && moves && moves.length > 0 && (
          <div className="mt-4">
            <GrowthMovesList moves={moves} />
          </div>
        )}
      </>
    );
  }

  return (
    <MemoBlock
      n={3}
      title="What I'm doing about it"
      aside={
        unavailable ? undefined : (
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums text-inkMuted">{`${inPlan.length} active`}</span>
            {}
            {canEdit && addable.length > 0 && (
              <SectionAction
                onClick={() => {
                  setMenuOpen(true);
                  menuRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
                }}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                Change this
              </SectionAction>
            )}
          </div>
        )
      }
    >
      {error && (
        <p
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="mb-4 text-sm text-warn focus:outline-none dark:text-marigold"
        >
          {error}
        </p>
      )}
      {unavailable ? (
        <p className="text-sm text-inkMuted">Channels could not be loaded.</p>
      ) : (
        <>
          {inPlan.length === 0 ? (
            <EmptyNote>
              No channels yet. Add one to put it in your plan.
              {!hasPlan && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={onAskZavi}
                    disabled={asking}
                    className="font-medium text-ink underline underline-offset-2 disabled:opacity-50"
                  >
                    {asking ? "Asking Zavi…" : "Or ask Zavi to pick them."}
                  </button>
                </>
              )}
            </EmptyNote>
          ) : (
            <ul className="divide-y divide-rule">
              {inPlan.map((channel) => (
                <ChannelRow
                  key={channel.slug}
                  channel={channel}
                  bet={betBySlug.get(channel.slug)}
                  work={work}
                  canEdit={canEdit}
                  canStop={canStop}
                  saving={savingSlugs.has(channel.slug)}
                  onToggleAutorun={onToggleAutorun}
                  onRemove={() => void onSetInPlan(channel.slug, false)}
                  onAsk={
                    onAsk
                      ? () =>
                          onAsk(
                            `Talk me through ${channelName(channel.slug) ?? channel.slug} in my plan: why it's there, how it's doing, and what you'd change.`,
                          )
                      : undefined
                  }
                />
              ))}
            </ul>
          )}

          {pausedByZavi.length > 0 && (
            <ul className="mt-3 space-y-1 text-[13px] text-inkMuted">
              {pausedByZavi.map((c) => (
                <li key={c.slug}>
                  {`I paused ${channelName(c.slug) ?? c.slug}: ${c.cgo_reason}`}
                  {canEdit ? " You can add it back below." : ""}
                </li>
              ))}
            </ul>
          )}

          {canEdit && (
            <div ref={menuRef} className="relative mt-4">
              <SuggestionChip
                label="Add a channel"
                disabled={addable.length === 0}
                onClick={() => setMenuOpen((v) => !v)}
              >
                Add a channel
              </SuggestionChip>
              {menuOpen && (
                <ul
                  role="menu"
                  aria-label="Channels you can add"
                  className="raised-surface absolute left-0 z-20 mt-2 max-h-80 w-64 overflow-y-auto rounded-xl border border-rule bg-cream p-1.5 shadow-lg"
                >
                  {addable.map((slug) => (
                    <li key={slug} role="none">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={savingSlugs.has(slug)}
                        onClick={() => add(slug)}
                        className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm text-ink hover:bg-creamDeep disabled:opacity-40"
                      >
                        <GrowthChannelLabel slug={slug} name={channelName(slug)} compact />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {moves && moves.length > 0 && (
            <div className="mt-6">
              <GrowthMovesList moves={moves} />
            </div>
          )}
        </>
      )}
    </MemoBlock>
  );
}

function ChannelRow({
  channel,
  bet,
  work,
  canEdit,
  canStop,
  saving,
  onToggleAutorun,
  onRemove,
  onAsk,
}: {
  channel: GrowthChannel;
  bet: GrowthBet | undefined;
  work?: ChannelWork | null;
  canEdit: boolean;
  canStop: boolean;
  saving: boolean;
  onToggleAutorun: (slug: string, next: boolean) => Promise<void>;
  onRemove: () => void;
  onAsk?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const name = channelName(channel.slug) ?? humanize(channel.slug);
  const founderAdded = channel.plan_selected_set_by === "founder";
  const risk = RISK_BY_SLUG.get(channel.slug);
  const status = channelStatus(channel, work);
  const controlDisabled = saving || (!canEdit && !(canStop && channel.slug === "chatgpt_ads" && channel.autorun));
  const mayRun = channel.autorun && channel.auto_capable !== false;
  const letItRun = () => {
    if (risk) setConfirming(true);
    else void onToggleAutorun(channel.slug, true);
  };
  const link =
    "rounded px-1.5 py-0.5 text-[13px] font-medium text-inkSoft hover:bg-creamDeep hover:text-ink";
  return (
    <li className="py-4 first:pt-1 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[16px] font-semibold text-ink" title={bet?.intent}>
            <GrowthChannelLabel slug={channel.slug} name={name} />
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-2 text-[13px] font-semibold",
              mayRun ? "text-mintDeep" : "text-inkMuted",
            )}
          >
            <span
              aria-hidden="true"
              className={cn("inline-block h-2 w-2 rounded-full", mayRun ? "bg-mintDeep" : "bg-rule")}
            />
            {channel.auto_capable === false
              ? channel.slug === "chatgpt_ads"
                ? "Manual paid control · separate ads wallet"
                : "Starts only when asked"
              : channel.autorun ? "CGO may run this" : "Asks you first"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {bet && (
            <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={link}>
              {open ? "Less" : "Why"}
            </button>
          )}
          {onAsk && (
            <button type="button" aria-label={`Ask Zavi about ${name}`} onClick={onAsk} className={link}>
              Ask
            </button>
          )}
          {channel.auto_capable !== false && (
          <span className="ml-1">
            {channel.autorun ? (
              <SecondaryButton
                label={`Make ${name} ask you first`}
                disabled={controlDisabled}
                onClick={() => void onToggleAutorun(channel.slug, false)}
                className="!px-3 !py-1 text-[13px]"
              >
                Stop
              </SecondaryButton>
            ) : (
              <SecondaryButton
                label={`Let CGO run ${name}`}
                disabled={controlDisabled}
                onClick={letItRun}
                className="!px-3 !py-1 text-[13px]"
              >
                Let it run
              </SecondaryButton>
            )}
          </span>
          )}
          {}
          {canEdit && founderAdded && !bet && (
            <button
              type="button"
              aria-label={`Remove ${name} from the plan`}
              disabled={saving}
              onClick={onRemove}
              className="rounded p-1 text-inkMuted hover:bg-creamDeep hover:text-ink disabled:opacity-40"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {}
      <p className="mt-1 flex items-center gap-2 pl-[42px] text-[13px] text-inkMuted">
        <StatusChip tone={channelStatusTone(status)}>{status}</StatusChip>
        {!bet && (founderAdded ? "Added by you." : "In your plan.")}
      </p>
      {bet && open && (
        <div className="mt-1.5 space-y-1.5 pl-[42px] text-sm text-inkMuted">
          <p className="text-ink">{bet.intent}</p>
          <p>
            {bet.rationale
              ? `Why: ${bet.rationale}`
              : "Why: not recorded yet. Zavi adds it the next time the plan updates."}
          </p>
          {}
          {bet.expected_effect?.trim() && <p>{`Expected: ${bet.expected_effect}`}</p>}
          {bet.falsifier?.trim() && <p>{`Call it failed if: ${bet.falsifier}`}</p>}
        </div>
      )}
      {confirming && risk && (
        <div
          role="alertdialog"
          aria-label={`Let CGO run ${name}?`}
          className="ml-[42px] mt-3 rounded-xl border border-rule bg-creamDeep p-4"
        >
          <p className="text-[14px] font-semibold text-ink">{riskConfirmLine(name, risk)}</p>
          <p className="text-sm text-inkMuted">You can stop it here any time.</p>
          <div className="mt-3 flex gap-2">
            <PrimaryButton
              onClick={() => {
                setConfirming(false);
                void onToggleAutorun(channel.slug, true);
              }}
            >
              Yes, let it run
            </PrimaryButton>
            <SecondaryButton onClick={() => setConfirming(false)}>Cancel</SecondaryButton>
          </div>
        </div>
      )}
    </li>
  );
}

function StoryChannelRow({
  channel,
  bet,
  autopilot = false,
  lockedTier,
  canEdit,
  canStop,
  saving,
  onToggleAutorun,
  onRemove,
  onAsk,
}: {
  channel: GrowthChannel;
  bet: GrowthBet | undefined;
  autopilot?: boolean;
  lockedTier?: string | null | undefined;
  canEdit: boolean;
  canStop: boolean;
  saving: boolean;
  onToggleAutorun: (slug: string, next: boolean) => Promise<void>;
  onRemove: () => void;
  onAsk?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const name = channelName(channel.slug) ?? humanize(channel.slug);
  const founderAdded = channel.plan_selected_set_by === "founder";
  const risk = RISK_BY_SLUG.get(channel.slug);
  const controlDisabled = saving || (!canEdit && !(canStop && channel.slug === "chatgpt_ads" && channel.autorun));
  const flip = () => {
    if (channel.autorun) void onToggleAutorun(channel.slug, false);
    else if (risk) setConfirming(true);
    else void onToggleAutorun(channel.slug, true);
  };
  const chatgpt = channel.slug === "chatgpt_ads";
  const locked = typeof lockedTier === "string";
  const lockKnown = lockedTier !== undefined;
  const showSwitch = lockKnown && !locked && channel.auto_capable !== false && (autopilot || chatgpt);
  const runLine =
    !autopilot && !chatgpt
      ? "runs by itself once Autopilot is on"
      : autopilot
        ? chatgpt ? "CGO manages ads within Growth budget · prepaid wallet" : "CGO may run this, posts wait for you"
        : "CGO may manage ads once Autopilot is on";
  const mode = !lockKnown
    ? null
    : locked
      ? `needs ${tierDisplayName(lockedTier)}`
      : channel.auto_capable === false
        ? chatgpt
          ? "manual paid control · separate ads wallet"
          : "starts only when asked"
        : (autopilot || chatgpt) && !channel.autorun
          ? "asks you first"
          : runLine;
  const sub = mode
    ? founderAdded ? `Added by you · ${mode}` : `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`
    : founderAdded ? "Added by you" : null;
  return (
    <StoryRow>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="text-[14px] font-bold text-ink" title={bet?.intent}>
            <GrowthChannelLabel slug={channel.slug} name={name} compact />
          </p>
          {sub && <p className="text-[13px] text-inkMuted">{sub}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {(bet || onAsk) && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="text-[13px] font-semibold text-inkMuted underline decoration-rule underline-offset-2 hover:text-ink"
            >
              {open ? "Less" : "Why?"}
            </button>
          )}
          {}
          {showSwitch && (
          <button
            type="button"
            role="switch"
            aria-checked={channel.autorun}
            aria-label={channel.autorun ? `Make ${name} ask you first` : `Let CGO run ${name}`}
            disabled={controlDisabled}
            onClick={flip}
            className="inline-flex items-center gap-2 text-[13px] font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span
              aria-hidden="true"
              className={cn(
                "relative h-[22px] w-[38px] rounded-full transition-colors duration-150",
                channel.autorun ? "bg-[linear-gradient(90deg,#1e9d63,#167F50)]" : "bg-rule",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-[left] duration-150",
                  channel.autorun ? "left-[19px]" : "left-[3px]",
                )}
              />
            </span>
            Let it run
          </button>
          )}
          {canEdit && founderAdded && !bet && (
            <button
              type="button"
              aria-label={`Remove ${name} from the plan`}
              disabled={saving}
              onClick={onRemove}
              className="rounded p-1 text-inkMuted hover:bg-creamDeep hover:text-ink disabled:opacity-40"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-2 space-y-1.5 text-sm text-inkMuted">
          {bet && (
            <>
              <p className="text-ink">{bet.intent}</p>
              <p>
                {bet.rationale
                  ? `Why: ${bet.rationale}`
                  : "Why: not recorded yet. Zavi adds it the next time the plan updates."}
              </p>
              {bet.expected_effect?.trim() && <p>{`Expected: ${bet.expected_effect}`}</p>}
              {bet.falsifier?.trim() && <p>{`Call it failed if: ${bet.falsifier}`}</p>}
            </>
          )}
          {onAsk && (
            <button
              type="button"
              aria-label={`Ask Zavi about ${name}`}
              onClick={onAsk}
              className="mt-1 inline-flex h-9 items-center gap-1.5 self-start rounded-full border border-rule bg-cream px-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']"
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden />
              Ask Zavi
            </button>
          )}
        </div>
      )}
      {confirming && risk && (
        <div role="alertdialog" aria-label={`Let CGO run ${name}?`} className="mt-3 rounded-xl border border-rule bg-creamDeep p-4">
          <p className="text-[14px] font-semibold text-ink">{riskConfirmLine(name, risk)}</p>
          <p className="text-sm text-inkMuted">You can stop it here any time.</p>
          <div className="mt-3 flex gap-2">
            <PrimaryButton
              onClick={() => {
                setConfirming(false);
                void onToggleAutorun(channel.slug, true);
              }}
            >
              Yes, let it run
            </PrimaryButton>
            <SecondaryButton onClick={() => setConfirming(false)}>Cancel</SecondaryButton>
          </div>
        </div>
      )}
    </StoryRow>
  );
}
