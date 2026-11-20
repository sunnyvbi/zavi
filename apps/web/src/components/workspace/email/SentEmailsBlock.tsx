"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, ChevronDown, FileText, Filter, type LucideIcon } from "lucide-react";
import { getGaConnected, getSentEmailsPage, type ResultCell, type SentEmail } from "@/lib/workspace/emailResultsApi";
import { getPlan, type PlannedEmail } from "@/lib/workspace/emailPlanApi";
import { onEmailCardChanged, onEmailPlanChanged } from "@/lib/workspace/emailCardEvents";
import { announceChannelHistoryChanged } from "../actions/useChannelHistory";
import { EMAIL_TOOLS } from "./EmailConnectTiles";
import { useRereadWhileFailed } from "./useRereadWhileFailed";
import { useTabHidden } from "../layout/tabHidden";
import { DELIVERY_UNKNOWN } from "@/components/email/sendOutcomeCopy";
import { EmailPager, pageRange, useSteadyHeight } from "./EmailPager";
import { SlidingIndicator, useActiveBox } from "./SlidingIndicator";
import { CHANNEL_SETTINGS_CHANGED_EVENT, onTabReturn } from "@/lib/workspace/onTabReturn";
import { setEmailRunSlot } from "./emailRunSlot";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";
const DASH = "–";

const n = (v: number) => v.toLocaleString("en-US");
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const day = (iso: string | null, timeZone?: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone }) : null);

async function connectGoogleAnalytics(): Promise<void> {
  const { startGoogleAnalyticsConnect } = await import("@/app/connectors/GoogleAnalyticsConnectButton");
  await startGoogleAnalyticsConnect();
}

export type Range = "all" | "7" | "30";
export type Tab = "all" | "sent" | "scheduled" | "drafts";

const RANGES: { value: Range; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
];

const SCHEDULED: readonly PlannedEmail["status"][] = ["scheduled"];
const DRAFT: readonly PlannedEmail["status"][] = ["planned", "drafting", "ready"];
const DRAFT_PILL: Partial<Record<PlannedEmail["status"], string>> = { planned: "Planned", drafting: "Drafting" };

export const sentKey = (e: SentEmail) => `${e.card.rail}:${e.card.id}`;
const sentHref = (e: SentEmail) => `/workspace/email-cards/${e.card.rail}/${e.card.id}`;
const planHref = (p: PlannedEmail) => (p.card ? `/workspace/email-cards/${p.card.rail}/${p.card.id}` : null);
const sentAt = (e: SentEmail) => e.finished_at ?? e.started_at;

export function inRange(e: SentEmail, range: Range, nowMs: number): boolean {
  if (range === "all") return true;
  const at = sentAt(e);
  if (!at) return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && nowMs - t <= Number(range) * 86_400_000;
}

export function planInRange(p: PlannedEmail, range: Range, nowMs: number): boolean {
  if (range === "all") return true;
  const age = nowMs - Date.parse(p.planned_at);
  return age >= 0 && age <= Number(range) * 86_400_000;
}

export function snapshotLine(rows: SentEmail[]): string | null {
  if (rows.some((e) => e.numbers_note)) return "Some numbers stopped at 1 hour: see the note on that email.";
  const h1 = rows.some((e) => e.as_of === "h1");
  const d7 = rows.some((e) => e.as_of === "d7");
  if (h1 && d7) return "Numbers are from 1 hour or 7 days after each send. The 1-hour ones update at day 7.";
  if (h1) return "Numbers are from 1 hour after each send. Next update at day 7.";
  if (d7) return "Numbers are from 7 days after each send.";
  return null;
}

const known = (c: ResultCell) => c.value !== null;

const firstNumbers = (e: SentEmail): string | null => (e.stage === "h1_due" ? e.delivered.why : null);

export const uniqueOpens = (e: SentEmail): boolean => e.opens_unique ?? e.route !== "zavi_list";

export type Totals = {
  campaigns: number;
  counted: number;
  people: number | null;
  opens: number | null;
  clicks: number | null;
  visits: number | null;
  openRate: number | null;
  clickRate: number | null;
  clickToOpen: number | null;
  visitShare: number | null;
};

function ratio(rows: SentEmail[], top: (e: SentEmail) => number | null, bottom: (e: SentEmail) => number | null): number | null {
  let a = 0;
  let b = 0;
  for (const e of rows) {
    const t = top(e);
    const d = bottom(e);
    if (t === null || d === null) continue;
    a += t;
    b += d;
  }
  return b > 0 ? a / b : null;
}

const capped = (v: number | null): number | null => (v === null ? null : Math.min(1, v));

function sum(rows: SentEmail[], pick: (e: SentEmail) => number | null): number | null {
  let s: number | null = null;
  for (const e of rows) {
    const v = pick(e);
    if (v !== null) s = (s ?? 0) + v;
  }
  return s;
}

export function totals(rows: SentEmail[]): Totals {
  const people = (e: SentEmail) => e.people.sent;
  const opens = (e: SentEmail) => (uniqueOpens(e) ? e.opens.value : null);
  const clicks = (e: SentEmail) => e.clicks.value;
  const delivered = (e: SentEmail) => e.delivered.value;
  const visits = (e: SentEmail) => e.visitors.value;
  return {
    campaigns: rows.length,
    counted: rows.filter(people).length,
    people: sum(rows, people),
    opens: sum(rows, opens),
    clicks: sum(rows, clicks),
    visits: sum(rows, visits),
    openRate: capped(ratio(rows, opens, delivered)),
    clickRate: ratio(rows, clicks, delivered),
    clickToOpen: ratio(rows, clicks, opens),
    visitShare: ratio(rows, visits, people),
  };
}

export const rowRate = (top: ResultCell, bottom: ResultCell): number | null =>
  known(top) && known(bottom) && (bottom.value as number) > 0 ? (top.value as number) / (bottom.value as number) : null;

export const openRate = (e: SentEmail): number | null => (uniqueOpens(e) ? capped(rowRate(e.opens, e.delivered)) : null);

const ALL_OPENS_WHY = "Zavi's sender counts every open, not people who opened, so it has no open rate";

const num = (v: number | null) => (v === null ? DASH : n(v));
const rate = (v: number | null) => (v === null ? DASH : pct(v));

const NOT_REPORTED = "Not reported";

function Missing({ why }: { why: string | null }) {
  return (
    <span data-testid="missing" title={why ?? NOT_REPORTED} className="text-inkLight">
      <span aria-hidden="true">{DASH}</span>
      <span className="sr-only">{why ?? NOT_REPORTED}</span>
    </span>
  );
}

const peopleWhy = (e: SentEmail): string => firstNumbers(e) ?? "Not reported by the sender";

function Visits({ cell }: { cell: ResultCell }) {
  if (cell.action === "connect_ga") return <span data-testid="no-visits" className="text-inkLight">No visits</span>;
  if (cell.value !== null) {
    return (
      <span title={cell.why ?? undefined}>
        {n(cell.value)}
        {cell.why && <span className="sr-only">{` (${cell.why})`}</span>}
      </span>
    );
  }
  return <Missing why={cell.why} />;
}

function AllOpens({ e }: { e: SentEmail }) {
  if (e.opens.value === null) return <Missing why={e.opens.why} />;
  return (
    <span data-testid="opens-all" title={ALL_OPENS_WHY}>
      {n(e.opens.value)} <span className="text-inkMuted">{e.opens_label}</span>
      <span className="sr-only">{` (${ALL_OPENS_WHY})`}</span>
    </span>
  );
}

function RateCell({ value, why, bar }: { value: number | null; why: string | null; bar?: boolean }) {
  if (value === null) return <Missing why={why} />;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      {bar && (
        <span aria-hidden="true" className="inline-block h-1 w-[42px] shrink-0 overflow-hidden rounded-[2px] bg-rule">
          <span data-testid="open-bar" className="block h-full bg-brand" style={{ width: `${Math.min(100, Math.round(value * 100))}%` }} />
        </span>
      )}
      {pct(value)}
    </span>
  );
}

type Tone = "sent" | "scheduled" | "draft" | "sending" | "paused" | "stopped";
const PILL: Record<Tone, string> = {
  sent: "bg-success/10 text-success",
  stopped: "bg-danger/10 text-danger",
  sending: "bg-success/10 text-success",
  paused: "bg-marigoldDeep/10 text-marigoldDeep",
  scheduled: "bg-brand/10 text-brand",
  draft: "bg-rule text-inkMuted",
};

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span data-testid="status-pill" data-tone={tone} className={`inline-flex items-center gap-[5px] whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] leading-[18px] ${PILL[tone]}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

export function sentPill(e: SentEmail): { tone: Tone; text: string } {
  if (e.stage === "sending") return { tone: "sending", text: "Sending" };
  if (e.stage === "paused") return { tone: "paused", text: "Paused" };
  if (e.outcome?.may_have_sent) return { tone: "stopped", text: DELIVERY_UNKNOWN };
  if (e.stop_note) return { tone: "stopped", text: "Stopped" };
  if (e.delivery === "nobody") return { tone: "stopped", text: "Nobody reached" };
  if (e.delivery === "unconfirmed") return { tone: "sending", text: "Sent" };
  if ((e.delivery_skipped ?? 0) > 0) return { tone: "stopped", text: "Some skipped" };
  return { tone: "sent", text: "Sent" };
}

const stopNote = (e: SentEmail): string | null => (e.outcome?.may_have_sent && e.outcome.reason) || e.stop_note || null;

function emailed(e: SentEmail): string {
  if (e.people.stopped && e.people.total !== null && e.people.sent !== null) return `${n(e.people.sent)} of ${n(e.people.total)}`;
  return num(e.people.sent);
}

const STAT_BOX = "flex min-w-0 flex-col rounded-2xl border border-rule bg-white px-4 py-3.5";
const STAT_GRID = "grid grid-cols-2 gap-3 [@container(min-width:480px)]:grid-cols-3 [@container(min-width:840px)]:grid-cols-5";
const STAT_GRID_NO_GA = "grid grid-cols-2 gap-3 [@container(min-width:600px)]:grid-cols-4";
const PAGE = 10;

function ConnectGoogleAnalytics() {
  return (
    <button type="button" onClick={() => void connectGoogleAnalytics()} className={`inline-flex h-9 cursor-pointer items-center whitespace-nowrap rounded-cta border border-rule bg-white px-3 text-[13px] font-medium text-ink transition-colors hover:border-inkLight hover:bg-creamDeep ${FOCUS}`}>
      Connect Google Analytics
    </button>
  );
}

function Stat({ label, value, sub, waiting, testId }: { label: string; value: string; sub: string; waiting?: string | null; testId: string }) {
  const missing = value === DASH;
  return (
    <div data-testid={testId} className={STAT_BOX}>
      <p data-testid={`${testId}-label`} className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold leading-5 text-inkSoft">
        <span className="truncate">{label}</span>
      </p>
      <p data-testid={`${testId}-value`} className={`mt-1.5 whitespace-nowrap text-metric-value font-bold tabular-nums ${missing ? "text-inkLight" : "text-ink"}`}>
        {missing ? <span aria-hidden="true">{DASH}</span> : value}
      </p>
      <p data-testid={`${testId}-sub`} title={missing && waiting ? waiting : undefined} className="mt-0.5 min-h-4 truncate text-[12px] leading-4 text-inkMuted tabular-nums">
        {missing ? (waiting ?? "") : sub}
      </p>
    </div>
  );
}

const TH = "whitespace-nowrap border-b border-rule px-2.5 py-[9px] text-[12px] font-medium text-inkMuted";
const CAMPAIGN_COL = "min-w-[220px]";
const TD = "border-t border-rule px-2.5 py-2.5 align-middle";
const NUM = "text-right tabular-nums whitespace-nowrap";
const SUB = "text-[13px] font-normal leading-[18px] text-inkMuted";

const SENDER_TILE: Record<SentEmail["route"], string> = {
  mailchimp: "bg-[#ffe01b]",
  klaviyo: "bg-[#232426]",
  sendgrid: "bg-creamDeep",
  zavi_list: "",
};

function SenderLogo({ route, name }: { route: SentEmail["route"]; name: string }) {
  const logo = route === "zavi_list" ? "/zavi-icon.svg" : EMAIL_TOOLS.find((t) => t.id === route)?.logo;
  return (
    <span
      data-testid="sender-logo"
      data-route={route}
      title={`Sent with ${name}`}
      className={`grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-[8px] ${SENDER_TILE[route]}`}
    >
      {logo ? (
        <img src={logo} alt="" className={route === "zavi_list" ? "h-full w-full" : "h-4 w-4"} />
      ) : (
        <span aria-hidden="true" className="text-[11px] font-semibold text-ink">{name.slice(0, 1)}</span>
      )}
      <span className="sr-only">{`Sent with ${name}`}</span>
    </span>
  );
}

function PlanTile({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span data-testid="plan-tile" title={label} className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-creamDeep text-inkMuted">
      <Icon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.8} />
    </span>
  );
}

function Meta({ list, date }: { list: string | null; date: string | null }) {
  const parts = [list, date].filter((v): v is string => !!v);
  if (parts.length === 0) return null;
  return (
    <p data-testid="campaign-meta" className={`${SUB} mt-0.5`}>
      {parts.join(" · ")}
    </p>
  );
}

function Unsubscribed({ cell }: { cell: ResultCell }) {
  if (cell.value === null || cell.value <= 0) return null;
  return (
    <p data-testid="campaign-unsubscribed" title={cell.why ?? undefined} className={`${SUB} mt-0.5`}>
      {n(cell.value)} unsubscribed
      {cell.why && <span className="sr-only">{` (${cell.why})`}</span>}
    </p>
  );
}

function CampaignName({ title, href, sender, children }: { title: string; href: string | null; sender: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {sender}
      <div className="min-w-0 leading-[1.3] [overflow-wrap:break-word]">
        {href ? (
          <Link href={href} className={`font-medium [overflow-wrap:anywhere] underline decoration-rule underline-offset-2 ${FOCUS}`}>
            {title}
          </Link>
        ) : (
          <span className="font-medium [overflow-wrap:anywhere]">{title}</span>
        )}
        {children}
      </div>
    </div>
  );
}

function SentEmailsLoading() {
  const bar = "animate-pulse rounded-md bg-creamDeep [animation-duration:1.6s] motion-reduce:animate-none";
  return (
    <div data-testid="sent-emails-loading" role="status" aria-busy="true" className="min-w-0">
      <span className="sr-only">Loading your email results</span>
      <div className="mt-3 h-9 w-[132px] rounded-cta border border-rule" />
      <div className={`mt-3 ${STAT_GRID}`}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} data-testid="sent-emails-loading-stat" className="rounded-2xl border border-rule px-4 py-3.5">
            <div className={`h-5 w-20 ${bar}`} />
            <div className={`mt-1.5 h-8 w-12 ${bar}`} />
            <div className={`mt-0.5 h-4 w-16 ${bar}`} />
          </div>
        ))}
      </div>
      <div className="mt-7 overflow-hidden rounded-2xl border border-rule">
        <div className="h-9 border-b border-rule" />
        {["w-[46%]", "w-[34%]", "w-[40%]"].map((w, i) => (
          <div key={i} data-testid="sent-emails-loading-row" className="flex h-14 items-center gap-3 border-b border-rule px-3 last:border-b-0">
            <div className={`h-7 w-7 shrink-0 ${bar}`} />
            <div className={`h-3 ${w} ${bar}`} />
            <div className={`ml-auto h-3 w-8 ${bar}`} />
            <div className={`hidden h-3 w-10 sm:block ${bar}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

export const sentFollowUps = { ms: [3_000, 10_000, 25_000] };
export const sendingPoll = { ms: 20_000 };

function useGaConnected(): boolean | null {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [readTry, setReadTry] = useState(0);
  useEffect(() => onTabReturn(() => setReadTry((v) => v + 1)), []);
  useEffect(() => {
    let live = true;
    void getGaConnected().then((v) => {
      if (live && v !== null) setConnected(v);
    });
    return () => {
      live = false;
    };
  }, [readTry]);
  return connected;
}

function gaFromRows(rows: SentEmail[]): boolean | null {
  if (rows.some((e) => e.visitors.action === "connect_ga")) return false;
  return rows.some((e) => e.visitors.value !== null) ? true : null;
}

export function SentEmailsBlock() {
  const [rows, setRows] = useState<SentEmail[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlannedEmail[]>([]);
  const [planError, setPlanError] = useState(false);
  const [planRead, setPlanRead] = useState(false);
  const [loadTry, setLoadTry] = useState(0);
  const [planTry, setPlanTry] = useState(0);
  const [sentTry, setSentTry] = useState(0);
  const [range, setRange] = useState<Range>("all");
  const [tab, setTab] = useState<Tab>("all");
  const [page, setPage] = useState(0);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const filterRef = useRef<HTMLDetailsElement>(null);
  const gaRead = useGaConnected();

  useEffect(() => {
    const close = (ev: Event) => {
      const el = filterRef.current;
      if (!el?.open) return;
      if (ev instanceof KeyboardEvent) {
        if (ev.key !== "Escape") return;
        el.open = false;
        el.querySelector("summary")?.focus();
        return;
      }
      if (!el.contains(ev.target as Node)) el.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  const quietSent = useRef(false);
  useRereadWhileFailed(error !== null, () => {
    quietSent.current = true;
    setSentTry((n) => n + 1);
  });

  useEffect(() => {
    let live = true;
    if (!quietSent.current) setError(null);
    quietSent.current = false;
    getSentEmailsPage()
      .then((r) => {
        if (!live) return;
        setError(null);
        setRows(r.emails);
        setMore(r.more);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [loadTry, sentTry]);

  const tabHidden = useTabHidden();
  const sendingNow = (rows ?? []).some((r) => r.stage === "sending");
  useEffect(() => {
    if (!sendingNow || tabHidden) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      quietSent.current = true;
      setSentTry((v) => v + 1);
    }, sendingPoll.ms);
    return () => clearInterval(timer);
  }, [sendingNow, tabHidden]);

  useEffect(() => {
    let live = true;
    getPlan()
      .then((v) => {
        if (!live) return;
        setPlan(v.items);
        setPlanError(false);
        setPlanRead(true);
      })
      .catch(() => {
        if (!live) return;
        setPlanError(true);
        setPlanRead(true);
      });
    return () => {
      live = false;
    };
  }, [loadTry, planTry]);

  useEffect(() => {
    const offPlan = onEmailPlanChanged(() => setPlanTry((v) => v + 1));
    const onSettings = () => setSentTry((v) => v + 1);
    window.addEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, onSettings);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const offCard = onEmailCardChanged(() => {
      setSentTry((v) => v + 1);
      for (const ms of sentFollowUps.ms) {
        const t = setTimeout(() => {
          timers.delete(t);
          setSentTry((v) => v + 1);
          announceChannelHistoryChanged("email_marketing");
        }, ms);
        timers.add(t);
      }
    });
    return () => {
      window.removeEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, onSettings);
      offPlan();
      offCard();
      timers.forEach(clearTimeout);
    };
  }, []);

  const nowMs = Date.now();
  const sent = (rows ?? []).filter((e) => inRange(e, range, nowMs));
  const chosen = sent.filter((e) => !excluded.has(sentKey(e)));
  const t = totals(chosen);
  const ga = gaRead ?? gaFromRows(rows ?? []);
  const showVisits = ga === true;
  const waiting = chosen.map(firstNumbers).find((w) => w !== null) ?? null;
  const allOn = sent.length > 0 && chosen.length === sent.length;
  const toggle = (key: string) => {
    setPage(0);
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleAll = () => {
    setPage(0);
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const e of sent) {
        if (allOn) next.add(sentKey(e));
        else next.delete(sentKey(e));
      }
      return next;
    });
  };
  const filterLabel = allOn ? `All sent campaigns · ${sent.length}` : `${chosen.length} of ${sent.length} sent campaigns`;
  const dated = plan.filter((p) => planInRange(p, range, nowMs));
  const scheduled = dated.filter((p) => !p.vetoed && SCHEDULED.includes(p.status)).sort((a, b) => a.planned_at.localeCompare(b.planned_at));
  const drafts = dated.filter((p) => DRAFT.includes(p.status));

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "all", label: "All", count: sent.length + scheduled.length + drafts.length },
    { id: "sent", label: "Sent", count: sent.length },
    ...(scheduled.length > 0 ? [{ id: "scheduled" as const, label: "Scheduled", count: scheduled.length }] : []),
    ...(drafts.length > 0 ? [{ id: "drafts" as const, label: "Drafts", count: drafts.length }] : []),
  ];
  const shownTab: Tab = tabs.some((x) => x.id === tab) ? tab : "all";
  const [tabBox, tabsRef] = useActiveBox<HTMLDivElement>('[aria-pressed="true"]', `${shownTab}:${tabs.length}`);
  const showSent = shownTab === "all" || shownTab === "sent";
  const showScheduled = shownTab === "all" || shownTab === "scheduled";
  const showDrafts = shownTab === "all" || shownTab === "drafts";
  const waitingOnPlan = rows !== null && rows.length === 0 && !planRead;
  const nothing = rows !== null && rows.length === 0 && planRead && scheduled.length === 0 && drafts.length === 0;
  const entries = [
    ...(showSent ? chosen.map((e) => ({ kind: "sent" as const, e })) : []),
    ...(showScheduled ? scheduled.map((p) => ({ kind: "scheduled" as const, p })) : []),
    ...(showDrafts ? drafts.map((p) => ({ kind: "draft" as const, p })) : []),
  ];
  const pages = Math.max(1, Math.ceil(entries.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = entries.slice(at * PAGE, at * PAGE + PAGE);
  useEffect(() => {
    if (page !== at) setPage(at);
  }, [page, at]);
  const steady = useSteadyHeight(`${range}:${shownTab}`, pages > 1);

  return (
    <section aria-labelledby="email-performance-title" data-testid="email-performance" className="mb-10 mt-10 min-w-0">
      <h4 id="email-performance-title" className="text-[18px] font-semibold leading-6 tracking-tight text-ink">
        How your emails are doing
      </h4>

      {((!rows && !error) || waitingOnPlan) && <SentEmailsLoading />}
      {error && (
        <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rule bg-white px-4 py-3 text-[13px] text-inkMuted">
          <span className="flex min-w-0 items-center gap-2">
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-danger" />
            <span className="min-w-0">{error}</span>
          </span>
          <button
            type="button"
            onClick={() => setLoadTry((v) => v + 1)}
            className={`inline-flex h-9 cursor-pointer items-center rounded-cta border border-rule bg-white px-3 text-[13px] font-medium text-ink transition-colors hover:border-inkLight hover:bg-creamDeep ${FOCUS}`}
          >
            Retry
          </button>
        </div>
      )}
      {nothing && (
        <p data-testid="sent-emails-empty" className="mt-3 text-[13px] text-inkMuted">
          Nothing sent yet. Emails you approve show up here with their results.
        </p>
      )}
      {nothing && planError && (
        <p className="mt-2 text-[12px] text-inkMuted">
          Scheduled emails could not be loaded.{" "}
          <button type="button" onClick={() => setPlanTry((v) => v + 1)} className={`cursor-pointer rounded-sm font-medium text-ink underline underline-offset-2 hover:text-inkMuted ${FOCUS}`}>
            Try again
          </button>
        </p>
      )}

      {rows && !nothing && !waitingOnPlan && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(sent.length > 1 || chosen.length < sent.length) && (
              <details ref={filterRef} data-testid="campaign-filter" className="group relative">
                <summary className={`inline-flex h-9 cursor-pointer list-none items-center gap-1.5 whitespace-nowrap rounded-cta border border-rule bg-white px-3 text-[13px] font-medium text-ink [&::-webkit-details-marker]:hidden ${FOCUS}`}>
                  <Filter aria-hidden="true" className="h-4 w-4 shrink-0 text-inkMuted" strokeWidth={1.8} />
                  <span>{filterLabel}</span>
                  <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-inkMuted transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" strokeWidth={1.8} />
                </summary>
                <div className="absolute left-0 top-[calc(100%+6px)] z-10 w-[min(360px,80vw)] origin-top-left rounded-xl border border-rule bg-white p-1.5 shadow-menu animate-pop-in motion-reduce:animate-none">
                  <label className="flex cursor-pointer items-center gap-2.5 border-b border-rule px-2 pb-2.5 pt-2 text-[13px] font-medium text-ink">
                    <input type="checkbox" aria-label="Count every sent campaign" className="h-[15px] w-[15px] cursor-pointer accent-ink" checked={allOn} onChange={toggleAll} />
                    <span className="min-w-0 flex-1">Select all</span>
                  </label>
                  <div className="max-h-[280px] overflow-y-auto pt-1">
                    {sent.map((e) => (
                      <label key={sentKey(e)} className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-2 text-[13px] text-ink">
                        <input type="checkbox" className="h-[15px] w-[15px] cursor-pointer accent-ink" checked={!excluded.has(sentKey(e))} onChange={() => toggle(sentKey(e))} />
                        <span className="min-w-0 flex-1 truncate leading-[1.3]">{e.subject || "(no subject)"}</span>
                        <span className="text-[12px] text-inkMuted tabular-nums">{uniqueOpens(e) ? rate(openRate(e)) : e.opens.value === null ? DASH : `${n(e.opens.value)} ${e.opens_label}`}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </details>
            )}
            <div data-testid="range-select" className="relative inline-flex">
              <select
                aria-label="Date range"
                value={range}
                onChange={(ev) => {
                  setRange(ev.target.value as Range);
                  setPage(0);
                }}
                className={`h-9 cursor-pointer appearance-none rounded-cta border border-rule bg-white pl-3 pr-8 text-[13px] text-ink ${FOCUS}`}
              >
                {RANGES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <ChevronDown
                data-testid="range-chevron"
                aria-hidden="true"
                className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-inkMuted"
                strokeWidth={1.8}
              />
            </div>
            <div data-testid="sent-emails-actions" className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
              {ga === false && <ConnectGoogleAnalytics />}
              <div ref={setEmailRunSlot} data-testid="email-run-slot" className="contents" />
            </div>
          </div>

          <div data-testid="stat-strip" className={`mt-3 ${showVisits ? STAT_GRID : STAT_GRID_NO_GA}`}>
            <Stat testId="stat-people" label="People emailed" value={num(t.people)} waiting={waiting} sub={t.counted < t.campaigns ? `${n(t.counted)} of ${n(t.campaigns)} campaigns` : `${n(t.campaigns)} ${t.campaigns === 1 ? "campaign" : "campaigns"}`} />
            <Stat testId="stat-open" label="Open rate" value={rate(t.openRate)} waiting={waiting} sub={t.opens === null ? "" : `${n(t.opens)} ${t.opens === 1 ? "open" : "opens"}`} />
            <Stat testId="stat-click" label="Click rate" value={rate(t.clickRate)} waiting={waiting} sub={t.clicks === null ? "" : `${n(t.clicks)} ${t.clicks === 1 ? "click" : "clicks"}`} />
            {showVisits && <Stat testId="stat-visits" label="Site visits" value={num(t.visits)} sub={t.visitShare === null ? "" : `${pct(t.visitShare)} of people emailed`} />}
            <Stat testId="stat-cto" label="Click-to-open" value={rate(t.clickToOpen)} waiting={waiting} sub="" />
          </div>
          {snapshotLine(chosen) && (
            <p data-testid="snapshot-line" className="mt-2 truncate text-[12px] leading-4 text-inkMuted">{snapshotLine(chosen)}</p>
          )}
          {more && (
            <p data-testid="sent-emails-capped" className="mt-2 text-[12px] text-inkMuted">
              Only your most recent sent emails are shown here, and these totals count only them. Older emails are not included.
            </p>
          )}

          {tabs.length > 2 && (
          <div className="mt-7 max-w-full overflow-x-auto">
            <div ref={tabsRef} role="group" aria-label="Show" data-testid="campaign-tabs" className="relative inline-flex items-center gap-0.5 rounded-[11px] bg-creamDeep p-[3px]">
              <SlidingIndicator box={tabBox} kind="pill" className="rounded-[8px] bg-white shadow-[0_1px_2px_rgb(0_0_0/0.10),0_0_0_1px_rgb(var(--c-rule))]" />
              {tabs.map((x) => {
                const on = shownTab === x.id;
                return (
                  <button
                    key={x.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      setTab(x.id);
                      setPage(0);
                    }}
                    className={`relative inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-3.5 text-[13px] font-medium transition-colors duration-200 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${on ? (tabBox ? "text-ink" : "bg-white text-ink shadow-[0_1px_2px_rgb(0_0_0/0.10),0_0_0_1px_rgb(var(--c-rule))]") : "text-inkMuted"}`}
                  >
                    {x.label}
                    <span data-testid={`tab-count-${x.id}`} className={`text-[12px] tabular-nums ${on ? "text-inkMuted" : "text-inkLight"}`}>
                      {x.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          )}
          {planError && (
            <p className="mt-2 text-[12px] text-inkMuted">
              Scheduled emails could not be loaded.{" "}
              <button type="button" onClick={() => setPlanTry((v) => v + 1)} className={`cursor-pointer rounded-sm font-medium text-ink underline underline-offset-2 hover:text-inkMuted ${FOCUS}`}>
                Try again
              </button>
            </p>
          )}

          {entries.length === 0 ? (
            <p data-testid={sent.length > 0 && chosen.length === 0 ? "sent-emails-none-selected" : "sent-emails-range-empty"} className="mt-7 text-[13px] text-inkMuted">
              {sent.length > 0 && chosen.length === 0 ? "No campaigns selected." : "Nothing sent in this date range."}
            </p>
          ) : (
          <div
            ref={steady.ref}
            data-testid="campaign-table-box"
            style={steady.minHeight ? { minHeight: steady.minHeight } : undefined}
            className={`${tabs.length > 2 ? "mt-4" : "mt-7"} max-w-full overflow-x-auto rounded-2xl border border-rule bg-white`}
          >
            <table data-testid="campaign-table" className={`w-full ${showVisits ? "min-w-[760px]" : "min-w-[652px]"} border-collapse text-left text-[13px] leading-[18px]`}>
              <colgroup>
                <col />
                <col className="w-px" />
                <col className="w-[76px]" />
                <col className="w-[124px]" />
                <col className="w-[108px]" />
                {showVisits && <col className="w-[108px]" />}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className={`${TH} ${CAMPAIGN_COL}`}>Campaign</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={`${TH} text-right`}>Emailed</th>
                  <th scope="col" className={`${TH} text-right`}>Open rate</th>
                  <th scope="col" className={`${TH} text-right`}>Click rate</th>
                  {showVisits && <th scope="col" className={`${TH} text-right`}>Site visits</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  if (row.kind === "sent") {
                    const e = row.e;
                    const pill = sentPill(e);
                    return (
                      <tr key={sentKey(e)} data-testid="row-sent" data-on={!excluded.has(sentKey(e))} className={excluded.has(sentKey(e)) ? "text-inkLight" : "text-ink"}>
                        <td className={`${TD} ${CAMPAIGN_COL}`}>
                          <CampaignName title={e.subject || "(no subject)"} href={sentHref(e)} sender={<SenderLogo route={e.route} name={e.sent_with} />}>
                            <Meta list={e.list_name} date={day(sentAt(e))} />
                            <Unsubscribed cell={e.unsubscribes} />
                            {firstNumbers(e) && (
                              <p data-testid="first-numbers" className={`${SUB} mt-0.5`}>
                                {firstNumbers(e)}
                              </p>
                            )}
                            {e.delivery_reason && (
                              <p data-testid="delivery-reason" className="mt-0.5 text-[13px] font-normal leading-[18px] text-danger">
                                {e.delivery_reason}
                              </p>
                            )}
                            {e.numbers_note && (
                              <p data-testid="numbers-note" className={`${SUB} mt-0.5`}>
                                {e.numbers_note}
                              </p>
                            )}
                            {stopNote(e) && (
                              <p data-testid="stop-note" className="mt-0.5 text-[13px] font-normal leading-[18px] text-danger">
                                {stopNote(e)}
                              </p>
                            )}
                          </CampaignName>
                        </td>
                        <td className={TD}>
                          <Pill tone={pill.tone}>{pill.text}</Pill>
                        </td>
                        <td className={`${TD} ${NUM}`}>{e.people.sent === null ? <Missing why={peopleWhy(e)} /> : emailed(e)}</td>
                        <td className={`${TD} ${NUM}`}>
                          {uniqueOpens(e) ? <RateCell value={openRate(e)} why={e.opens.why ?? e.delivered.why} bar /> : <AllOpens e={e} />}
                        </td>
                        <td className={`${TD} ${NUM}`}>
                          <RateCell value={rowRate(e.clicks, e.delivered)} why={e.clicks.why ?? e.delivered.why} />
                        </td>
                        {showVisits && (
                          <td className={`${TD} ${NUM}`}>
                            <Visits cell={e.visitors} />
                          </td>
                        )}
                      </tr>
                    );
                  }
                  const p = row.p;
                  const planned = row.kind === "scheduled";
                  return (
                    <tr key={`${row.kind}:${p.id}`} data-testid={planned ? "row-scheduled" : "row-draft"} className="text-ink">
                      <td className={`${TD} ${CAMPAIGN_COL}`}>
                        <CampaignName
                          title={p.angle}
                          href={planHref(p)}
                          sender={<PlanTile icon={planned ? CalendarClock : FileText} label={planned ? "Scheduled" : "Draft"} />}
                        >
                          <Meta list={p.list_name || null} date={planned || p.status !== "ready" ? day(p.planned_at, p.timezone) : null} />
                        </CampaignName>
                      </td>
                      <td className={TD}>
                        <Pill tone={planned ? "scheduled" : "draft"}>{planned ? "Scheduled" : (DRAFT_PILL[p.status] ?? "Draft")}</Pill>
                      </td>
                      <td data-testid="plan-results" colSpan={showVisits ? 4 : 3} className={`${TD} ${NUM} text-inkLight`}>
                        <span aria-hidden="true">{DASH}</span>
                        <span className="sr-only">{planned ? "Results show after it sends" : "Results show after you approve and send it"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
          {pages > 1 && (
            <div className="mt-3">
              <EmailPager
                label="Campaign pages"
                testId="campaign-pager"
                rangeTestId="campaign-pager-range"
                range={pageRange(at * PAGE + 1, Math.min(entries.length, at * PAGE + PAGE), entries.length)}
                canPrev={at > 0}
                canNext={at < pages - 1}
                onPrev={() => setPage(at - 1)}
                onNext={() => setPage(at + 1)}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
