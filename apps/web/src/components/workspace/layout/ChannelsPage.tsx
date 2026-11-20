"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  CircleDot,
  List as ListIcon,
  ChevronRight,
  Loader2,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import type { Channel } from "@zavi/shared";
import { MobileBackIcon } from "@/components/mobile";
import { useWorkspaceLocation } from "../navigation/useWorkspaceLocation";
import {
  CHANNEL_CARD_PARAM,
  CHANNEL_DRAWER_PARAMS,
  CHANNEL_PARAM,
  pushWorkspaceLocation,
  readWorkspaceLocation,
  replaceWorkspaceLocation,
} from "../navigation/workspaceRoutes";
import { cx, FOCUS_RING, prefersReducedMotion } from "./shared";
import { SourceIcon } from "./SourceIcon";
import { ChannelsWheel } from "./ChannelsWheel";
import { ChannelActionChat } from "./ChannelActionChat";
import {
  SIDE_CHAT_MIN_PX,
  SideChatFab,
  SideChatOverlay,
  SideChatRail,
  useSideChatState,
} from "../sidechat/SideChat";
import { platformFor } from "../actions/platforms";
import { BoundCampaignSafetyControls, CampaignSafetyControls } from "../actions/managed-campaigns/CampaignSafetyControls";
import { LockedChannelPreview } from "./LockedChannelPreview";
import { canExecuteChannel, canReadChannel, needYouTally, UPGRADE_TO_START, visibleWaiting } from "./channelTally";
import {
  ChannelChatProvider,
  type ChannelChatPin,
} from "../actions/channelChat";
import type { LockTier } from "@/lib/workspace/planUpgrade";
import { startChannelPreviewOnOpen } from "@/lib/workspace/channelPreviewOnOpen";
import {
  PRICING_FALLBACK,
  fetchLivePricingClient,
  isTierSlug,
  tierDisplayName,
} from "@/lib/marketing/pricing";
import { useMediaMatch } from "@/lib/responsive";

type PaidTier = Exclude<LockTier, "free">;
const CHANNEL_RAIL_PX = 280;
const CHANNEL_RAIL_COLLAPSED_PX = 76;
const MIN_DETAIL_PX = 360;
const ROOMY_DETAIL_PX = 640;
const CHANNEL_COMPACT_QUERY = "(max-width: 1023px)";

const PLAN_ORDER: readonly PaidTier[] = ["starter", "growth", "pro"];

export type ChannelEntry = {
  channel: Channel;
  count: number;
  waiting: number;
  noticeWaiting?: number;
  subtitle: string | null;
  description?: string | null;
  lock: { kind: "plan"; label: string; tier: PaidTier; open?: boolean } | { kind: "soon" } | null;
  running?: boolean;
  topAction?: string | null;
};

export { canExecuteChannel, canReadChannel, visibleWaiting };

export const OPEN_SECTIONS: ReadonlyArray<{ key: string; label: string; categories: readonly string[] }> = [
  { key: "organic", label: "Organic", categories: ["organic"] },
  { key: "creators", label: "Creators", categories: [] },
  { key: "paid", label: "Paid ads", categories: ["paid"] },
  { key: "owned", label: "Email and SMS", categories: ["owned"] },
];

export const sectionOf = (channel: { category?: string; section?: string }) =>
  channel.section === "creators"
    ? "creators"
    : channel.category === "paid"
      ? "paid"
      : channel.category === "owned"
        ? "owned"
        : "organic";

export const actionsNoun = (n: number) => `${n} ${n === 1 ? "action" : "actions"}`;

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      aria-hidden
      className={cx("h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none", className)}
    />
  );
}

export function waitingClause(waiting: number, separator = " · "): string {
  return waiting > 0 ? `${separator}${waitingLabel(waiting)} waiting` : "";
}

export const WAITING_DISPLAY_CAP = 5;

export function waitingLabel(waiting: number): string {
  return waiting > WAITING_DISPLAY_CAP ? `${WAITING_DISPLAY_CAP}+` : String(waiting);
}

export { CHANNEL_PARAM };
const LIST_COLLAPSED_KEY = "zavi:channels-list-collapsed";
const VIEW_KEY = "zavi:channels-view";
type ChannelsView = "wheel" | "list";
const CHAT_OPEN_KEY = "zavi:channel-chat-open";
const CHANNEL_PIN: ChannelChatPin = { target: "channel" };
const CHANNEL_PUSH_KEY = "zaviChannelPush";
const CLOSE_MS = 520;
const COMPACT_SLIDE_MS = 300;
const ROW_STAGGER_MS = 28;
const ROW_STAGGER_CAP = 10;

export function useOpenChannelSlug(): string | null {
  const location = useWorkspaceLocation();
  const params = new URL(location, "https://workspace.local").searchParams;
  return params.get("tab") === "channels" ? params.get(CHANNEL_PARAM) : null;
}

const LINKED_CARD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function useLinkedActionId(): string | null {
  const location = useWorkspaceLocation();
  const params = new URL(location, "https://workspace.local").searchParams;
  if (params.get("tab") !== "channels" || !params.get(CHANNEL_PARAM)) return null;
  const id = params.get(CHANNEL_CARD_PARAM);
  return id && LINKED_CARD_RE.test(id) ? id.toLowerCase() : null;
}

function useLinkedCard() {
  const link = useLinkedActionId();
  const [dropped, setDropped] = useState<string | null>(null);
  useEffect(() => {
    if (link === null) setDropped(null);
  }, [link]);
  const linkedActionId = link !== null && link !== dropped ? link : null;
  const linkRef = useRef(linkedActionId);
  linkRef.current = linkedActionId;
  const dropLink = useCallback(() => {
    const id = linkRef.current;
    if (!id) return;
    setDropped(id);
    const url = new URL(readWorkspaceLocation(), "https://workspace.local");
    if (url.searchParams.get(CHANNEL_CARD_PARAM)?.toLowerCase() !== id) return;
    url.searchParams.delete(CHANNEL_CARD_PARAM);
    replaceWorkspaceLocation(`${url.pathname}${url.search}${url.hash}`);
  }, []);
  return [linkedActionId, dropLink] as const;
}

function useChannelParam() {
  const slug = useOpenChannelSlug();
  const pushed = useRef<{ token: string; length: number } | null>(null);
  const setSlug = useCallback((next: string | null) => {
    const url = new URL(readWorkspaceLocation(), "https://workspace.local");
    if (url.searchParams.get("tab") !== "channels") return;
    const wasOpen = url.searchParams.has(CHANNEL_PARAM);
    const own = pushed.current;
    if (
      !next &&
      wasOpen &&
      own &&
      window.history.length === own.length &&
      (window.history.state as Record<string, unknown> | null)?.[CHANNEL_PUSH_KEY] === own.token
    ) {
      pushed.current = null;
      window.history.back();
      return;
    }
    if (url.searchParams.get(CHANNEL_PARAM) !== next) {
      for (const key of CHANNEL_DRAWER_PARAMS) url.searchParams.delete(key);
      url.searchParams.delete(CHANNEL_CARD_PARAM);
    }
    if (next) url.searchParams.set(CHANNEL_PARAM, next);
    else url.searchParams.delete(CHANNEL_PARAM);
    const href = `${url.pathname}${url.search}${url.hash}`;
    if (next && !wasOpen) {
      pushWorkspaceLocation(href);
      const token = `${Date.now()}-${Math.random()}`;
      window.history.replaceState({ ...(window.history.state ?? {}), [CHANNEL_PUSH_KEY]: token }, "");
      pushed.current = { token, length: window.history.length };
    } else {
      replaceWorkspaceLocation(href);
    }
  }, []);
  return [slug, setSlug] as const;
}

const fadeIn = "motion-safe:animate-fade-in motion-safe:[animation-fill-mode:backwards]";

export function ChannelRow({
  entry,
  loading,
  index,
  expanded,
  onOpen,
  onUpgrade,
  onPreview,
  className,
  style,
  children,
}: {
  entry: ChannelEntry;
  loading: boolean;
  index: number;
  expanded?: boolean;
  onOpen: () => void;
  onUpgrade: (entry: ChannelEntry) => void;
  onPreview?: () => void;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const { channel, waiting, subtitle } = entry;
  const lock = canReadChannel(entry) ? null : entry.lock;
  const noticeWaiting = visibleWaiting(entry);
  const row = cx("flex w-full items-center gap-3 px-4 py-3.5 text-left", FOCUS_RING);
  const hover =
    "transition-colors duration-150 hover:bg-creamDeep motion-reduce:transition-none";
  const accordion = expanded !== undefined;
  const previews = lock?.kind === "plan" && waiting > 0 && !!onPreview;
  const [startedLoading] = useState(loading);
  const arrived = startedLoading && !loading;

  return (
    <section className={cx("border-b border-rule", className)} style={style}>
      {lock ? (
        <button
          type="button"
          data-channel-slug={channel.slug}
          aria-disabled={lock.kind === "soon" ? "true" : undefined}
          aria-expanded={previews ? Boolean(expanded) : undefined}
          onClick={
            previews ? onPreview : lock.kind === "plan" ? () => onUpgrade(entry) : undefined
          }
          className={cx(row, lock.kind === "plan" ? hover : "cursor-default")}
        >
          {}
          <span className={lock.kind === "soon" ? "opacity-50" : undefined}>
            <SourceIcon channel={channel} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className={cx("truncate text-[14px] font-medium leading-5", lock.kind === "soon" ? "text-inkMuted" : "text-ink")}>
                {channel.name}
              </span>
              {lock.kind === "soon" && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bone px-2 py-[1px] text-[11px] font-medium text-inkMuted">
                  {`Coming soon${waitingClause(waiting)}`}
                </span>
              )}
            </span>
            {lock.kind === "plan" && subtitle && (
              <span className="flex items-center gap-2 truncate text-[13px] leading-[18px] text-inkMuted">
                {entry.running && <Spinner />}
                {}
                {waiting > 0 && !entry.running ? (
                  <span
                    data-waiting-highlight
                    className="mt-0.5 inline-flex items-center rounded-full bg-[#e6f0ff] px-2 py-[1px] text-[12px] font-semibold leading-[18px] text-[#0258b8] [font-variant-numeric:tabular-nums]"
                  >
                    {subtitle}
                  </span>
                ) : (
                  subtitle
                )}
              </span>
            )}
          </span>
          {lock.kind === "plan" && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bone px-2 py-[1px] text-[11px] font-medium text-inkMuted">
              <Lock className="h-3 w-3" aria-hidden />
              {tierDisplayName(lock.tier)}
            </span>
          )}
        </button>
      ) : (
        <button
          type="button"
          data-channel-slug={channel.slug}
          aria-expanded={accordion ? expanded : undefined}
          onClick={onOpen}
          className={cx(row, hover)}
        >
          <SourceIcon channel={channel} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium leading-5 text-ink">
              {channel.name}
            </span>
            {entry.description && (
              <span className="block truncate text-[13px] leading-[18px] text-inkMuted">
                {entry.description}
              </span>
            )}
            {loading ? null : noticeWaiting > 0 && subtitle && !entry.running ? (
              <span
                data-waiting-highlight
                data-row-status
                style={arrived ? { animationDelay: `${index * 40}ms` } : undefined}
                className={cx("mt-1 inline-flex items-center rounded-full bg-[#e6f0ff] px-2 py-[1px] text-[12px] font-semibold leading-[18px] text-[#0258b8] [font-variant-numeric:tabular-nums]", arrived && fadeIn)}
              >
                {subtitle}
              </span>
            ) : (
              subtitle && (
                <span
                  data-row-status
                  style={arrived ? { animationDelay: `${index * 40}ms` } : undefined}
                  className={cx("block truncate text-[13px] leading-[18px] text-inkMuted", arrived && fadeIn)}
                >
                  {subtitle}
                </span>
              )
            )}
          </span>
          {accordion ? (
            <ChevronDown
              className={cx(
                "h-4 w-4 shrink-0 text-inkLight transition-transform duration-150 motion-reduce:transition-none",
                expanded && "rotate-180",
              )}
              aria-hidden
            />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-inkLight" aria-hidden />
          )}
        </button>
      )}
      {children}
    </section>
  );
}

function RailItem({
  entry,
  active,
  onOpen,
  onUpgrade,
}: {
  entry: ChannelEntry;
  active: boolean;
  onOpen: () => void;
  onUpgrade: (entry: ChannelEntry) => void;
}) {
  const { channel, waiting, subtitle } = entry;
  const lock = canReadChannel(entry) ? null : entry.lock;
  const noticeWaiting = visibleWaiting(entry);
  const status = lock
    ? lock.kind === "plan"
      ? `needs ${lock.label}`
      : `coming soon${waitingClause(waiting, ", ")}`
    : subtitle;
  const inert = lock?.kind === "soon";
  return (
    <button
      type="button"
      data-channel-slug={channel.slug}
      title={channel.name}
      aria-label={status ? `${channel.name}, ${status}` : channel.name}
      aria-current={active ? "page" : undefined}
      aria-disabled={inert ? "true" : undefined}
      onClick={inert ? undefined : lock ? () => onUpgrade(entry) : onOpen}
      className={cx(
        "relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-[background-color,transform] duration-150 motion-reduce:transition-none",
        active ? "bg-ink/10" : !inert && "hover:bg-ink/[0.04]",
        inert ? "cursor-default" : "active:scale-[0.96]",
        FOCUS_RING,
      )}
    >
      <span className={cx(lock && "opacity-50")}>
        <SourceIcon channel={channel} />
      </span>
      {noticeWaiting > 0 && !lock && (
        <span className="absolute right-0 top-0 min-w-[20px] rounded-full border-2 border-cream bg-ink px-1 text-center text-[11px] font-bold leading-4 text-cream [font-variant-numeric:tabular-nums]">
          {waitingLabel(noticeWaiting)}
        </span>
      )}
      {lock && (
        <span className="absolute bottom-0.5 right-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-cream bg-bone text-inkMuted">
          <Lock className="h-2.5 w-2.5" aria-hidden />
        </span>
      )}
    </button>
  );
}

function ListItem({
  entry,
  active,
  onOpen,
  onUpgrade,
}: {
  entry: ChannelEntry;
  active: boolean;
  onOpen: () => void;
  onUpgrade: (entry: ChannelEntry) => void;
}) {
  const { channel, waiting, subtitle } = entry;
  const lock = canReadChannel(entry) ? null : entry.lock;
  const noticeWaiting = visibleWaiting(entry);
  const inert = lock?.kind === "soon";
  const status = lock
    ? lock.kind === "plan"
      ? `Needs ${lock.label}`
      : `Coming soon${waitingClause(waiting)}`
    : subtitle;
  return (
    <button
      type="button"
      data-channel-slug={channel.slug}
      aria-current={active ? "page" : undefined}
      aria-disabled={inert ? "true" : undefined}
      onClick={inert ? undefined : lock ? () => onUpgrade(entry) : onOpen}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-cta px-2.5 py-2 text-left transition-colors duration-150 motion-reduce:transition-none",
        active ? "bg-ink/10" : !inert && "hover:bg-ink/[0.04]",
        inert && "cursor-default",
        FOCUS_RING,
      )}
    >
      <span className={cx("shrink-0", lock && "opacity-50")}>
        <SourceIcon channel={channel} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span
            className={cx(
              "truncate text-[16px] font-medium leading-5",
              lock ? "text-inkMuted" : "text-ink",
            )}
          >
            {channel.name}
          </span>
          {noticeWaiting > 0 && !lock && (
            <span className="shrink-0 rounded-full bg-ink px-1.5 py-[1px] text-[11px] font-bold leading-4 text-cream [font-variant-numeric:tabular-nums]">
              {waitingLabel(noticeWaiting)}
            </span>
          )}
          {lock && (
            <Lock className="h-3 w-3 shrink-0 text-inkMuted" aria-hidden />
          )}
        </span>
        {status && (
          <span className="block truncate text-[13px] leading-4 text-inkMuted">
            {status}
          </span>
        )}
      </span>
    </button>
  );
}

const pickPrices = (tiers: typeof PRICING_FALLBACK.tiers) =>
  Object.fromEntries(
    PLAN_ORDER.map((t) => [t, tiers.find((x) => x.slug === t)?.usd ?? null]),
  ) as Record<PaidTier, number | null>;

function usePlanPrices(enabled: boolean): Record<PaidTier, number | null> {
  const [prices, setPrices] = useState(() => pickPrices(PRICING_FALLBACK.tiers));
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchLivePricingClient().then((p) => {
      if (!cancelled) setPrices(pickPrices(p.tiers));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return prices;
}

export function ChannelsPage({
  entries,
  loading,
  notices,
  onShow,
  onPeek = onShow,
  onUpgrade: onUpgradeProp,
  onPlanGate = onUpgradeProp,
  onUpgradePlan,
  renderDetail,
  companyName = null,
  currentPlan = null,
  canComparePlans = true,
  directUpgrade = false,
}: {
  entries: ChannelEntry[];
  loading: boolean;
  notices?: ReactNode;
  companyName?: string | null;
  currentPlan?: string | null;
  canComparePlans?: boolean;
  directUpgrade?: boolean;
  onShow: (entry: ChannelEntry, opened?: boolean) => void;
  onPeek?: (entry: ChannelEntry) => void;
  onUpgrade: (entry: ChannelEntry) => void;
  onPlanGate?: (entry: ChannelEntry) => void;
  onUpgradePlan?: (tier: PaidTier) => void;
  renderDetail: (slug: string, close: () => void, leading: ReactNode) => ReactNode;
}) {
  const onUpgrade = useCallback(
    (entry: ChannelEntry) => {
      if (entry.lock?.kind === "plan" && entry.lock.tier === "starter" && !canReadChannel(entry) && entry.waiting === 0) {
        startChannelPreviewOnOpen(entry.channel.slug);
      }
      onUpgradeProp(entry);
    },
    [onUpgradeProp],
  );
  const [slug, setSlug] = useChannelParam();
  const [linkedActionId, dropLink] = useLinkedCard();
  const [pin, setPin] = useState<ChannelChatPin | null>(null);
  const channelCompact = useMediaMatch(CHANNEL_COMPACT_QUERY);
  const sideChat = useSideChatState({
    storageKey: CHAT_OPEN_KEY,
    defaultOpen: false,
    compact: channelCompact,
  });
  const { compact, show: showChat, hide: hideChat } = sideChat;
  const chatOpen = sideChat.open;
  const compactChatOpen = sideChat.compactOpen;
  const [closing, setClosing] = useState(false);
  const [animated, setAnimated] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<ChannelsView>("wheel");
  const [leaving, setLeaving] = useState<ChannelEntry | null>(null);
  const [previewSlug, setPreviewSlug] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const focusSlug = useRef<string | null>(null);
  const selected =
    entries.find((e) => e.channel.slug === slug && canReadChannel(e)) ?? null;
  const [laneWidth, setLaneWidth] = useState(0);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => setLaneWidth(el.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [compact, selected !== null]);
  const besideRailPx = laneWidth - (collapsed ? CHANNEL_RAIL_COLLAPSED_PX : CHANNEL_RAIL_PX);
  const chatRoomPx = besideRailPx - MIN_DETAIL_PX;
  const chatMaxPx = Math.min(chatRoomPx, Math.max(SIDE_CHAT_MIN_PX, besideRailPx - ROOMY_DETAIL_PX));
  const chatOverlaysLane = !compact && laneWidth > 0 && chatRoomPx < SIDE_CHAT_MIN_PX;
  const chatLocked = selected !== null && !canExecuteChannel(selected);
  const askChat = useCallback(() => {
    if (selected && !canExecuteChannel(selected)) onPlanGate(selected);
    else showChat();
  }, [selected, onPlanGate, showChat]);
  const openChat = useCallback(
    (next: ChannelChatPin) => {
      if (selected && !canExecuteChannel(selected)) {
        onPlanGate(selected);
        return;
      }
      if (next.target === "action") dropLink();
      setPin(next);
      showChat();
    },
    [selected, onPlanGate, showChat, dropLink],
  );

  const [linkedPreview, setLinkedPreview] = useState<string | null>(null);
  const scrollToPreview = useRef(false);
  const shownSlug = useRef<string | null>(null);
  useEffect(() => {
    if (!slug) shownSlug.current = null;
    if (loading || !slug) return;
    if (selected) {
      const opened = shownSlug.current !== slug;
      shownSlug.current = slug;
      onShow(selected, opened);
      return;
    }
    setSlug(null);
    const locked = entries.find((e) => e.channel.slug === slug && e.lock?.kind === "plan");
    if (!locked) return;
    setView("list");
    setLinkedPreview(locked.channel.slug);
    setPreviewSlug(locked.channel.slug);
    scrollToPreview.current = true;
  }, [selected, slug, loading, onShow, setSlug, entries]);

  useEffect(() => {
    if (!scrollToPreview.current || !previewSlug || view !== "list") return;
    const el =
      rootRef.current?.querySelector<HTMLElement>(`[data-plan-group][data-has-channel~="${previewSlug}"]`) ??
      rootRef.current?.querySelector<HTMLElement>(`[data-channel-slug="${previewSlug}"]`);
    if (!el) return;
    scrollToPreview.current = false;
    el.scrollIntoView({ block: "start" });
  }, [previewSlug, view]);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(LIST_COLLAPSED_KEY) === "1") {
        setCollapsed(true);
      }
    } catch {
    }
  }, []);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(VIEW_KEY) === "list") setView("list");
    } catch {
    }
  }, []);

  const chooseView = (next: ChannelsView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
    }
  };

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(LIST_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
      }
      return next;
    });
  };

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => {
      setClosing(false);
      setSlug(null);
    }, CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [closing, setSlug]);

  useEffect(() => {
    if (!leaving) return;
    const drop = () => setLeaving(null);
    const onEnd = (e: TransitionEvent) => {
      if (e.target === e.currentTarget && e.propertyName === "transform") drop();
    };
    const track = trackRef.current;
    track?.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(drop, COMPACT_SLIDE_MS);
    return () => {
      track?.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
    };
  }, [leaving]);

  useLayoutEffect(() => {
    const target = focusSlug.current;
    if (!target) return;
    if (compact && selected) {
      focusSlug.current = null;
      return;
    }
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-channel-slug="${target}"]`,
    );
    if (!el) return;
    focusSlug.current = null;
    el.focus({ preventScroll: Boolean(selected) });
    if (!selected) el.scrollIntoView({ block: "nearest" });
  }, [compact, selected]);

  const resetChat = sideChat.reset;
  useEffect(() => {
    setPin(null);
    resetChat();
  }, [slug, resetChat]);

  const open = (next: string) => {
    if (closing) return;
    setAnimated(true);
    setLeaving(null);
    focusSlug.current = next;
    setSlug(next);
  };

  const close = () => {
    if (!selected || closing) return;
    setAnimated(true);
    focusSlug.current = selected.channel.slug;
    if (prefersReducedMotion()) setSlug(null);
    else setClosing(true);
  };

  const closeCompact = () => {
    if (selected && !prefersReducedMotion()) setLeaving(selected);
    setSlug(null);
  };
  const shown = selected ?? leaving;

  const backToList = (
    <button
      type="button"
      onClick={closeCompact}
      aria-label="Back to channels"
      title="Back to channels"
      className={cx(
        "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-cta text-inkLight hover:bg-bone hover:text-ink",
        FOCUS_RING,
      )}
    >
      <MobileBackIcon className="h-[22px] w-[22px]" />
    </button>
  );

  const runnable = entries.filter(canReadChannel);
  const runnableSections = OPEN_SECTIONS.map((sec) => ({
    ...sec,
    items: runnable
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => sectionOf(entry.channel) === sec.key),
  })).filter((sec) => sec.items.length > 0);
  const planGroups = PLAN_ORDER.map((tier) => ({
    tier,
    items: entries.filter((e) => e.lock?.kind === "plan" && e.lock.tier === tier && !canReadChannel(e)),
  })).filter((g) => g.items.length > 0);
  const soon = entries.filter((e) => e.lock?.kind === "soon");
  const prices = usePlanPrices(planGroups.length > 0);
  const workingOn = entries.filter((e) => e.lock?.kind === "plan" && e.running).length;

  const canPreview = (entry: ChannelEntry) =>
    entry.lock?.kind === "plan" &&
    !canReadChannel(entry) &&
    (!directUpgrade || linkedPreview === entry.channel.slug);
  const row = (entry: ChannelEntry, index: number) => (
    <ChannelRow
      key={entry.channel.slug}
      entry={entry}
      loading={loading}
      index={index}
      expanded={canPreview(entry) ? previewSlug === entry.channel.slug : undefined}
      onOpen={() => open(entry.channel.slug)}
      onUpgrade={onUpgrade}
      onPreview={
        canPreview(entry)
          ? () => {
              if (linkedPreview === entry.channel.slug && previewSlug === entry.channel.slug) {
                setLinkedPreview(null);
              }
              setPreviewSlug((s) => (s === entry.channel.slug ? null : entry.channel.slug));
            }
          : undefined
      }
      className={cx(
        animated && "animate-channel-row-in motion-reduce:animate-none",
      )}
      style={
        animated
          ? {
              animationDelay: `${Math.min(index, ROW_STAGGER_CAP) * ROW_STAGGER_MS}ms`,
            }
          : undefined
      }
    >
      {canPreview(entry) && entry.waiting > 0 && previewSlug === entry.channel.slug && (
        <LockedChannelPreview
          entry={entry}
          onUpgrade={() => onUpgrade(entry)}
        />
      )}
      {entry.lock && <div className="px-4">{safetyFor(entry)}</div>}
    </ChannelRow>
  );

  const safetyFor = (entry: ChannelEntry) => {
    if (!entry.lock) return null;
    const platform = platformFor(entry.channel.slug);
    const spec = platform.campaignWorkspace;
    if (spec?.safetyPath) return <CampaignSafetyControls key={entry.channel.slug} spec={spec} />;
    return platform.adsAccountPlatform === "linkedin" && !canReadChannel(entry)
      ? <BoundCampaignSafetyControls key={entry.channel.slug} platform="linkedin" name={platform.name} />
      : null;
  };
  const workingBanner = (
    workingOn > 0 && (
      <div
        role="status"
        className="mb-3 flex items-start gap-2 rounded-xl border border-rule bg-creamDeep px-4 py-3 text-[13px] leading-5 text-ink"
      >
        <Spinner className="mt-1" />
        <span>
          <span className="font-semibold">
            {`Zavi is working on ${workingOn} ${workingOn === 1 ? "channel" : "channels"} for ${companyName || "you"}.`}
          </span>{" "}
          This takes a few minutes. You can leave this page.
        </span>
      </div>
    )
  );

  const wheelEntries = entries.filter((e) => e.lock?.kind !== "soon");
  const tally = needYouTally(view === "wheel" ? wheelEntries : entries);
  const needYou = loading ? 0 : tally.items;
  const upgradeToStart = !loading && tally.lockedOnly;
  const viewButton = (value: ChannelsView, label: string, Icon: typeof CircleDot) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => chooseView(value)}
      className={cx(
        "inline-flex h-8 items-center gap-2 rounded-full px-3 text-[13px] font-semibold transition-colors duration-150 motion-reduce:transition-none",
        view === value ? "bg-ink text-cream" : "text-inkMuted hover:text-ink",
        FOCUS_RING,
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
  const header = (
    <div className="mb-5 compact:mb-3">
      <div className="flex items-center gap-3">
        {}
        <h1 className="text-[24px] font-semibold leading-8 tracking-tight text-ink compact:hidden">Channels</h1>
        {needYou > 0 && (
          <span
            data-need-you
            className="rounded-full bg-bone px-2.5 py-0.5 text-[13px] font-semibold text-inkMuted [font-variant-numeric:tabular-nums] compact:hidden"
          >
            {`${needYou} ${needYou === 1 ? "item needs" : "items need"} you`}
          </span>
        )}
        {upgradeToStart && (
          <span
            data-need-you
            className="rounded-full bg-bone px-2.5 py-0.5 text-[13px] font-semibold text-inkMuted compact:hidden"
          >
            {UPGRADE_TO_START}
          </span>
        )}
        {!compact && (
          <div
            role="group"
            aria-label="View"
            className="ml-auto inline-flex rounded-full border border-rule bg-cream p-0.5"
          >
            {viewButton("wheel", "Wheel", CircleDot)}
            {viewButton("list", "List", ListIcon)}
          </div>
        )}
      </div>
      {currentPlan && isTierSlug(currentPlan) && (
        <p data-current-plan className="mt-0.5 text-[13px] leading-[18px] text-inkMuted">
          You&rsquo;re on the {tierDisplayName(currentPlan)} plan
          {canComparePlans && (
            <>
              {" \u00b7 "}
              <a href="/workspace?tab=settings#billing-plans" className="underline underline-offset-2 hover:text-ink">
                Compare plans
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );

  const listBody = (
    <div className="mx-auto w-full max-w-[880px]">
          {header}
          {notices}
          {workingBanner}
          {runnableSections.map((section) => (
            <div key={section.key} data-open-section={section.key}>
              {(runnableSections.length > 1 || planGroups.length > 0) && (
                <div className="border-b border-rule px-4 pb-2 pt-5 text-[13px] font-semibold leading-5 text-ink">
                  {section.label}
                </div>
              )}
              {section.items.map(({ entry, index }) => row(entry, index))}
            </div>
          ))}
          {planGroups.map((group) => {
            const name = tierDisplayName(group.tier);
            const price = prices[group.tier];
            const waitingTotal = group.items.reduce((sum, e) => sum + e.waiting, 0);
            return (
              <section
                key={group.tier}
                aria-label={`On ${name}`}
                data-plan-group={group.tier}
                data-has-channel={group.items.map((e) => e.channel.slug).join(" ")}
              >
                <div className="flex items-end justify-between gap-3 border-b border-rule px-4 pb-2 pt-[26px]">
                  <span className="min-w-0 truncate">
                    <span className="text-[13px] font-semibold text-ink">On {name}</span>
                    {price !== null && (
                      <span className="text-[13px] text-inkMuted"> · ${price}/mo</span>
                    )}
                    {waitingTotal > 0 && (
                      <span className="block truncate text-[14px] font-semibold leading-6 text-ink">
                        {`${actionsNoun(waitingTotal)} waiting for you`}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      onUpgradePlan ? onUpgradePlan(group.tier) : onUpgrade(group.items[0])
                    }
                    className={cx(
                      "shrink-0 whitespace-nowrap rounded-full border px-3 py-[5px] text-[13px] font-semibold transition-colors duration-150 motion-reduce:transition-none",
                      "border-rule bg-cream text-ink hover:bg-creamDeep",
                      FOCUS_RING,
                    )}
                  >
                    {waitingTotal > 0 ? "See them · Upgrade" : `Upgrade to ${name}`}
                  </button>
                </div>
                {group.items.map((entry, i) => row(entry, runnable.length + i))}
              </section>
            );
          })}
          {soon.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-3.5">
              <span className="mr-1 text-[13px] text-inkMuted">Coming soon</span>
              {soon.map((entry) => (
                <span
                  key={entry.channel.slug}
                  data-channel-slug={entry.channel.slug}
                  className="inline-flex items-center rounded-full bg-bone px-2 py-[1px] text-[11px] font-medium text-inkMuted"
                >
                  {`${entry.channel.name}${waitingClause(entry.waiting)}`}
                </span>
              ))}
            </div>
          )}
          {soon.map(safetyFor)}
    </div>
  );

  if (!compact && !selected) {
    if (view === "wheel") {
      return (
        <div ref={rootRef} className="ws-scroll flex h-full min-h-0 flex-col px-6 py-6">
          <div className="mx-auto w-full max-w-[880px]">
            {header}
            {notices}
            {workingBanner}
            {entries.map(safetyFor)}
          </div>
          <ChannelsWheel entries={wheelEntries} loading={loading} onOpen={open} onUpgrade={onUpgrade} onPeek={onPeek} />
        </div>
      );
    }
    return (
      <div ref={rootRef} className="ws-scroll h-full min-h-0 px-6 py-6">
        {listBody}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={cx("relative flex h-full min-h-0", compact && "overflow-clip")}
    >
      <div
        ref={trackRef}
        className={
          compact
            ? "flex h-full w-[200%] min-h-0 shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
            : "contents"
        }
        style={
          compact
            ? {
                transform: selected
                  ? "translate3d(-50%, 0, 0)"
                  : "translate3d(0, 0, 0)",
              }
            : undefined
        }
      >
        {compact ? (
          <div
            aria-hidden={selected ? true : undefined}
            inert={selected ? true : undefined}
            className={cx(
              "ws-scroll h-full w-1/2 min-h-0 shrink-0 px-4 py-4",
              selected && "pointer-events-none",
            )}
          >
            {listBody}
          </div>
        ) : (
          <nav
            aria-label="Growth Channels"
            className={cx(
              "flex shrink-0 flex-col border-r border-rule compact:hidden",
              collapsed ? "w-[76px]" : "w-[280px]",
              animated &&
                (closing ? "animate-channel-rail-out" : "animate-channel-rail-in"),
              "motion-reduce:animate-none",
            )}
          >
            <div
              className={cx(
                "flex h-14 shrink-0 items-center border-b border-rule",
                collapsed ? "justify-center px-2" : "gap-2 px-3",
              )}
            >
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-expanded={!collapsed}
                aria-label={collapsed ? "Show channel names" : "Collapse channel list"}
                title={collapsed ? "Show channel names" : "Collapse channel list"}
                className={cx(
                  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-inkLight hover:bg-bone hover:text-ink",
                  FOCUS_RING,
                )}
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden />
                ) : (
                  <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden />
                )}
              </button>
              {!collapsed && (
                <span className="truncate text-[13px] font-semibold text-ink">
                  Channels
                </span>
              )}
            </div>
            <div
              className={cx(
                "ws-scroll flex min-h-0 flex-1 flex-col pb-4",
                collapsed ? "items-center gap-2 pt-3" : "gap-0.5 px-2 pt-2",
              )}
            >
              {entries.map((entry) =>
                collapsed ? (
                  <RailItem
                    key={entry.channel.slug}
                    entry={entry}
                    active={entry.channel.slug === selected?.channel.slug}
                    onOpen={() => open(entry.channel.slug)}
                    onUpgrade={onUpgrade}
                  />
                ) : (
                  <ListItem
                    key={entry.channel.slug}
                    entry={entry}
                    active={entry.channel.slug === selected?.channel.slug}
                    onOpen={() => open(entry.channel.slug)}
                    onUpgrade={onUpgrade}
                  />
                ),
              )}
            </div>
          </nav>
        )}
        <div
          key={shown?.channel.slug}
          className={
            compact
              ? "flex h-full w-1/2 min-h-0 min-w-0 shrink-0"
              : cx(
                  "flex min-h-0 min-w-0 flex-1",
                  animated &&
                    (closing ? "animate-channel-panel-out" : "animate-channel-panel-in"),
                  "motion-reduce:animate-none",
                )
          }
        >
          {shown && (
            <ChannelChatProvider open={openChat}>
              {renderDetail(
                shown.channel.slug,
                compact ? closeCompact : close,
                compact ? (
                  <>
                    {backToList}
                    <SourceIcon channel={shown.channel} />
                  </>
                ) : (
                  <SourceIcon channel={shown.channel} />
                ),
              )}
            </ChannelChatProvider>
          )}
        </div>
      </div>
      {compact ? (
        <>
          {selected && (!compactChatOpen || chatLocked) && (
            <SideChatFab onOpen={askChat} label="Chat with Zavi about this channel" />
          )}
          {selected && !chatLocked && sideChat.mountOverlay && (
            <SideChatOverlay open={compactChatOpen}>
              <ChannelActionChat
                key={
                  pin?.target === "action"
                    ? pin.action.id
                    : `channel:${selected.channel.slug}`
                }
                pin={pin ?? CHANNEL_PIN}
                linkedActionId={linkedActionId}
                onAct={dropLink}
                channelSlug={selected.channel.slug}
                channelName={selected.channel.name}
                open={compactChatOpen}
                onClose={hideChat}
                fullBleed
              />
            </SideChatOverlay>
          )}
        </>
      ) : (
        <>
          {selected && sideChat.mountColumn && !chatLocked && chatOverlaysLane && (
            <div className={cx("absolute inset-0 z-40 bg-cream", chatOpen ? "flex" : "hidden")} data-testid="channel-chat-overlay">
              <ChannelActionChat
                key={pin?.target === "action" ? pin.action.id : `channel:${selected.channel.slug}`}
                pin={pin ?? CHANNEL_PIN}
                linkedActionId={linkedActionId}
                onAct={dropLink}
                channelSlug={selected.channel.slug}
                channelName={selected.channel.name}
                open={chatOpen}
                onClose={hideChat}
                fullBleed
              />
            </div>
          )}
          {selected && sideChat.mountColumn && !chatLocked && !chatOverlaysLane && (
            <ChannelActionChat
              key={pin?.target === "action" ? pin.action.id : `channel:${selected.channel.slug}`}
              pin={pin ?? CHANNEL_PIN}
              linkedActionId={linkedActionId}
              onAct={dropLink}
              channelSlug={selected.channel.slug}
              channelName={selected.channel.name}
              open={chatOpen}
              onClose={hideChat}
              containerRef={rootRef}
              maxWidthPx={laneWidth > 0 ? chatMaxPx : undefined}
            />
          )}
          {(!chatOpen || chatLocked) && <SideChatRail onOpen={askChat} label="Chat" />}
        </>
      )}
    </div>
  );
}
