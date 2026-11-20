
export type ChannelMetric = {
  key: string;
  value: number;
  unit: string | null;
  grounded: boolean;
  prev_value: number | null;
  day: string;
  tone?: "good" | "warn" | "bad";
  note?: string;
  outOf?: { max: number; of?: boolean; tail?: string };
  unmeasured?: string;
};

export type ChannelPlan = { id: string; title: string; content: string; proposed_at: string; status: string };

export type HistoryRun = {
  run_id: string;
  trigger: string;
  status: string;
  enqueued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  redo_of_action_id: string | null;
  executor?: string | null;
};

export type HistoryClosed = {
  id: string;
  title: string;
  status: "acted" | "rejected" | "redone" | "stale" | "displaced";
  status_at: string | null;
  note: string | null;
  proposed_at: string;
};

export type HistoryPreSwitch = {
  run_id: string | null;
  title: string | null;
  position: number | null;
  of: number | null;
  archived_at: string | null;
  emitted_at: string | null;
};

export type ChannelHistory = { runs: HistoryRun[]; closed: HistoryClosed[]; pre_switch?: HistoryPreSwitch[] };

const PCT_UNITS = new Set(["pct", "percent", "%"]);
const USD_UNITS = new Set(["usd", "$", "dollars"]);
const RATIO_UNITS = new Set(["ratio", "x", "×"]);
const LOWER_IS_BETTER = /(^|_)(cpa|cpc|cpm|cost|cost_per|bounce)/i;

function unitOf(unit: string | null): "pct" | "usd" | "ratio" | "count" {
  const u = (unit ?? "").toLowerCase();
  if (PCT_UNITS.has(u)) return "pct";
  if (USD_UNITS.has(u)) return "usd";
  if (RATIO_UNITS.has(u)) return "ratio";
  return "count";
}

function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(abs >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 });
}

export function roasVerdict(
  value: number | null | undefined,
  opts: { floor?: boolean; currency?: string } = {},
): Pick<ChannelMetric, "tone" | "note"> {
  if (value === null || value === undefined || !Number.isFinite(value)) return {};
  const back = opts.currency
    ? `${formatCurrency(value, opts.currency, true)} back per ${formatCurrency(1, opts.currency, false)} spent`
    : `$${value.toFixed(2)} back per $1 spent`;
  if (opts.floor) return { tone: value < 1 ? "warn" : "good", note: `at least ${back}` };
  return { tone: value < 1 ? "bad" : "good", note: back };
}

export function paceTone(pct: number | null | undefined): ChannelMetric["tone"] | undefined {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return undefined;
  return pct > 125 ? "bad" : pct > 105 ? "warn" : "good";
}

export function formatCurrency(value: number, currency: string, cents: boolean): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: cents ? 2 : 0,
    }).format(value);
  } catch {
    return `${value.toLocaleString("en-US", { maximumFractionDigits: cents ? 2 : 0 })} ${currency}`;
  }
}

export function formatMetricValue(m: Pick<ChannelMetric, "value" | "unit">): string {
  if (m.value === null || m.value === undefined || !Number.isFinite(m.value)) return "-";
  if (m.unit?.startsWith("currency:")) return formatCurrency(m.value, m.unit.slice(9), Math.abs(m.value) < 1000 && !Number.isInteger(m.value));
  switch (unitOf(m.unit)) {
    case "pct":
      return `${m.value.toLocaleString("en-US", { maximumFractionDigits: Math.abs(m.value) < 1 ? 2 : 1 })}%`;
    case "usd": {
      const cents = Math.abs(m.value) < 1000 && !Number.isInteger(m.value);
      return `$${m.value.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
    }
    case "ratio":
      return `${m.value.toFixed(2)}×`;
    default:
      return compact(m.value);
  }
}

export type MetricDelta = { text: string; direction: "up" | "down"; good: boolean };

export function metricDelta(m: ChannelMetric): MetricDelta | null {
  if (m.prev_value === null || m.prev_value === undefined || !Number.isFinite(m.prev_value)) return null;
  if (!Number.isFinite(m.value)) return null;
  const diff = m.value - m.prev_value;
  if (diff === 0) return null;
  const lower = LOWER_IS_BETTER.test(m.key);
  const sign = diff > 0 ? "+" : "-";
  const unit = unitOf(m.unit);
  let text: string;
  if (unit === "pct") text = `${sign}${Math.abs(diff).toLocaleString("en-US", { maximumFractionDigits: 1 })}pp`;
  else if (unit === "usd" && lower) text = `${sign}$${Math.abs(diff).toFixed(2)}`;
  else if (m.prev_value === 0) text = `${sign}${formatMetricValue({ value: Math.abs(diff), unit: m.unit })}`;
  else text = `${sign}${((Math.abs(diff) / Math.abs(m.prev_value)) * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  return { text, direction: diff > 0 ? "up" : "down", good: lower ? diff < 0 : diff > 0 };
}

export function humanizeMetricKey(key: string): string {
  return key
    .replace(/_(7d|14d|28d|30d)$/i, "")
    .replace(/_/g, " ")
    .replace(/\bcpa\b/i, "CPA")
    .replace(/\bctr\b/i, "CTR")
    .replace(/\broas\b/i, "ROAS")
    .replace(/^\w/, (c) => c.toUpperCase());
}

const PAID = { spend: "Spend", cpa: "Cost per conversion", conversions: "Conversions", conv_value: "Conversion value", roas: "ROAS", ctr: "Click-through rate" };

const METRIC_LABELS: Record<string, Record<string, string>> = {
  meta_ads: PAID,
  tiktok_ads: PAID,
  google_ads: { spend: "Spend", conversions: "Conversions", cpa: "Cost per conversion", conv_value: "Conversion value", roas: "ROAS", pacing: "Plan pace" },
  reddit_ads: { spend: "Spend", cpa: "Cost per conversion", conversions: "Conversions", clicks: "Clicks", ctr: "Click-through rate", cpc: "Cost per click" },
  linkedin_ads: { spend: "Spend", cpa: "Cost per conversion", conversions: "Conversions", clicks: "Clicks", ctr: "Click-through rate", cpc: "Cost per click" },
  x_ads: { spend: "Spend", cpa: "Cost per conversion", conversions: "Conversions", clicks: "Clicks", ctr: "Click-through rate", cpc: "Cost per click" },
  x_organic: { impressions: "Impressions", engagement_rate: "Engagement rate", profile_visits: "Profile visits", link_clicks: "Link clicks", new_follows: "New follows", replies: "Replies", likes: "Likes", reposts: "Reposts" },
  linkedin_organic: { followers: "Followers", total_posts: "Posts", engagement_rate: "Engagement rate", days_since_last_post: "Days since last post" },
  instagram_organic: { followers: "Followers", total_posts: "Posts", views: "Views", reach: "Reach", engagement_rate: "Engagement rate", likes: "Likes", comments: "Comments", saves: "Saves" },
  tiktok_organic: PAID,
  reddit_organic: { brand_mentions: "Brand mentions", reply_opportunities: "Reply opportunities", relevant_posts: "Relevant posts", relevant_comments: "Relevant comments", subreddits: "Subreddits saved" },
  seo: { seo_issues: "Issues", seo_speed: "Speed (lab)", seo_vitals_passing: "Real visitors", seo_google: "Google SEO check", seo_ai: "AI readiness", seo_schema: "Structured data" },
  ugc: { briefs_out: "Briefs out", creators_hired: "Creators hired", videos_delivered: "Videos delivered", spent: "Spent" },
  geo: { geo_score: "Readiness", geo_checks: "Checks passed", geo_mention_rate: "Mentioned", geo_citation_rate: "Cited", geo_crawlers: "Crawlers allowed", geo_hits: "AI crawler hits", geo_prompts: "Questions tracked" },
};

const LEAD: Record<string, string[]> = {
  meta_ads: ["spend", "cpa", "conversions"],
  tiktok_ads: ["spend", "cpa", "conversions"],
  reddit_ads: ["spend", "cpa", "conversions"],
  linkedin_ads: ["spend", "cpa", "conversions"],
  x_ads: ["spend", "cpa", "conversions"],
  google_ads: ["spend", "cpa", "pacing"],
};

export type MetricTile = {
  key: string;
  label: string;
  value: string;
  delta: MetricDelta | null;
  unverified: boolean;
  unmeasured?: string;
  suffix?: string;
  tone?: "good" | "warn" | "bad";
  note?: string;
};

export function emptyTiles(slug: string, connected: boolean): MetricTile[] {
  const labels = METRIC_LABELS[slug] ?? {};
  const keys = [...new Set([...(LEAD[slug] ?? []), ...Object.keys(labels)])];
  return keys.map((key) => ({
    key,
    label: labels[key] ?? humanizeMetricKey(key),
    value: "",
    delta: null,
    unverified: false,
    unmeasured: connected ? "Not measured yet" : "Fills in once connected",
  }));
}

export function metricTiles(slug: string, metrics: readonly ChannelMetric[]): MetricTile[] {
  const labels = METRIC_LABELS[slug] ?? {};
  const order = [...(LEAD[slug] ?? []), ...Object.keys(labels)];
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return [...metrics]
    .sort((a, b) => rank(a.key) - rank(b.key))
    .map((m) => ({
      key: m.key,
      label: labels[m.key] ?? humanizeMetricKey(m.key),
      value: m.unmeasured ? "-" : formatMetricValue(m),
      delta: m.unmeasured ? null : metricDelta(m),
      unverified: m.grounded === false && !m.unmeasured,
      ...(m.unmeasured ? { unmeasured: m.unmeasured } : {}),
      ...(m.outOf && !m.unmeasured ? { suffix: m.outOf.of ? ` of ${m.outOf.max}${m.outOf.tail ? ` ${m.outOf.tail}` : ""}` : `/${m.outOf.max}` } : {}),
      ...(m.tone ? { tone: m.tone } : {}),
      ...(m.note ? { note: m.note } : {}),
    }));
}

const RUN_STATUS: Record<string, string> = {
  success: "Finished",
  queued: "Waiting to start",
  running: "Running",
  blocked: "Waiting on you",
  failed: "Failed",
  cancelled: "Cancelled",
  parse_failed: "Failed",
  dispatch_error: "Failed to start",
};
const RUN_TRIGGER: Record<string, string> = {
  channel_recipe: "channel run",
  manual: "you ran it",
  chat: "from chat",
  cron: "on schedule",
  scheduled: "on schedule",
  schedule: "on schedule",
  handoff: "handed over by another agent",
  slack: "from Slack",
  email: "from email",
  webhook: "from a webhook",
  playbook: "from a playbook",
};
const CLOSED_LABEL: Record<HistoryClosed["status"], string> = {
  acted: "Done",
  rejected: "Rejected",
  redone: "Redone",
  stale: "Went stale",
  displaced: "Outranked",
};
const words = (map: Record<string, string>, v: string) => map[v] ?? v.replace(/_/g, " ");

export type DrawerRow = { id: string; title: string; line: string; note: string | null; failed?: boolean };

export type RunDrawer = {
  total: number;
  runs: DrawerRow[];
  closed: DrawerRow[];
  preSwitch: DrawerRow[];
  preSwitchNote: string | null;
};

const stamp = (now: number, ...isos: Array<string | null | undefined>) => {
  const first = isos.find((x) => x);
  return first ? relativeTime(first, now) : null;
};

export function runDrawer(
  h: ChannelHistory | null | undefined,
  nameOf: (executor: string) => string,
  now: number = Date.now(),
): RunDrawer {
  const runs = (h?.runs ?? []).map((r) => {
    const failed = !["success", "queued", "running", "blocked"].includes(r.status);
    const at = stamp(now, r.finished_at, r.started_at, r.enqueued_at);
    return {
      id: `run:${r.run_id}`,
      title: `${r.executor ? nameOf(r.executor) : "Run"}${r.redo_of_action_id ? " · redo" : ""}`,
      line: [words(RUN_STATUS, r.status), words(RUN_TRIGGER, r.trigger), at].filter(Boolean).join(" · "),
      note: null,
      failed,
    };
  });
  const closed = (h?.closed ?? []).map((c) => ({
    id: `closed:${c.id}`,
    title: c.title,
    line: [CLOSED_LABEL[c.status] ?? c.status, stamp(now, c.status_at, c.proposed_at)].filter(Boolean).join(" · "),
    note: c.note,
  }));
  const pre = h?.pre_switch ?? [];
  const preSwitch = pre.map((r, i) => ({
    id: `pre:${r.run_id ?? "no-run"}-${i}`,
    title: r.title ?? "Untitled item",
    line: [r.position && r.of ? `Step ${r.position} of ${r.of}` : null, stamp(now, r.archived_at, r.emitted_at)].filter(Boolean).join(" · "),
    note: null,
  }));
  return {
    total: runs.length + closed.length + preSwitch.length,
    runs,
    closed,
    preSwitch,
    preSwitchNote: pre.length
      ? `${pre.length} older ${pre.length === 1 ? "item" : "items"} from before this channel moved store, kept read-only. They were priced against an account that has moved on, so they cannot be approved from here.`
      : null,
  };
}

export function relativeTime(iso: string | null, now: number = Date.now()): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} ${d === 1 ? "day" : "days"} ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export type RunState = { working: boolean; waiting: number };

export function statusLine(s: RunState): { tone: "working" | "waiting" | "idle"; text: string } {
  if (s.working) return { tone: "working", text: "Zavi is working on it" };
  if (s.waiting > 0) return { tone: "waiting", text: `${s.waiting} ${s.waiting === 1 ? "action needs" : "actions need"} you` };
  return { tone: "idle", text: "Nothing waiting for you" };
}

export function runLabel(o: { name: string; runnable: boolean; starting: boolean; working: boolean; ranBefore: boolean }): string {
  if (!o.runnable) return "Coming soon";
  if (o.starting) return "Starting…";
  if (o.working) return "Running…";
  return o.ranBefore ? "Run it again" : `Run ${o.name} now`;
}

export function runCost(credits: number | null | undefined): string {
  return typeof credits === "number" && credits > 0 ? `About ${credits.toLocaleString("en-US")} credits` : "Uses credits from your plan";
}

export function emptyLine(o: { workState: string | null; lastRunFailed: boolean }): string {
  if (o.lastRunFailed) return "The last run didn't finish, so there are no steps yet.";
  if (o.workState === "delivered") return "Zavi worked this channel and found nothing that needs doing right now.";
  return "Nothing yet. Ask Zavi to work this channel and it will put its next steps here.";
}

export function planWritten(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `Written ${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";
}

export function planEditable(p: Pick<ChannelPlan, "status">): boolean {
  return p.status === "pending" || p.status === "snoozed";
}

export function dismissOptions(now: Date = new Date()): { label: string; action: "rejected" | "snoozed"; note?: string; until?: string }[] {
  const back = new Date(now.getTime() + 7 * 86_400_000);
  const until = back.toISOString();
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(back);
  return [
    { label: `Remind me next week (back ${day})`, action: "snoozed", until },
    { label: "Not relevant for us", action: "rejected", note: "Not relevant for us" },
    { label: "The idea or numbers are wrong", action: "rejected", note: "The idea or numbers are wrong" },
  ];
}

const KIND_LABEL: Record<string, string> = {
  text_post: "Post",
  image_post: "Post",
  video_post: "Post",
  reply: "Reply",
  send_message: "Message",
  create_ad: "Ad",
  update_ad: "Ad change",
  pause_ad: "Pause",
  fix: "Fix",
  check: "Check",
  setup: "Setup",
  page: "Page",
  other: "To do",
};

const KIND_PLURAL: Record<string, string> = {
  Post: "Posts",
  Reply: "Replies",
  Message: "Messages",
  Ad: "New ads",
  "Ad change": "Ad changes",
  Pause: "Pauses",
  Fix: "Fixes",
  Check: "Checks",
  Setup: "Setup steps",
  "Setup fix": "Setup fixes",
  Page: "Pages",
  "To do": "Other to-dos",
};

export function cardKindLabel(actionType: string | null | undefined): string {
  return KIND_LABEL[actionType ?? "other"] ?? "To do";
}

const INTENT_TAG: Record<string, string> = {
  fix_setup: "Fix setup",
  improve: "Improve results",
  create: "Create",
  reach_out: "Reach out",
  review: "Review",
};

export function cardTag(actionType: string | null | undefined, intent: string | null | undefined): string {
  return (intent && INTENT_TAG[intent]) || cardKindLabel(actionType);
}

export function cardKind(actionType: string | null | undefined, intent: string | null | undefined): string {
  return intent === "fix_setup" ? "Setup fix" : cardKindLabel(actionType);
}

const DELIVERABLE_CAPTION: Record<string, string> = {
  fix: "Use this",
  check: "What to look for",
  setup: "Details to enter",
  page: "Page copy",
  send_message: "Message",
  text_post: "Your post",
  image_post: "Your post",
  video_post: "Your post",
  reply: "Your comment",
};

export function deliverableCaption(actionType: string | null | undefined, label: string | null | undefined): string {
  return label || DELIVERABLE_CAPTION[actionType ?? ""] || "What to use";
}

export function cardMainButton(
  a: {
    cardKind: string | null;
    primaryLabel: string | null;
    executable: boolean;
    approveOnPhone: boolean;
    approveNeedsAdmin?: boolean | null;
    emailCard: boolean;
    execStatus: string | null;
  },
  role: PhoneRole | null = null,
): { label: string; does: "open" | "email" | "web_only" } | null {
  if (!a.cardKind || !a.primaryLabel) return null;
  const zaviChange = a.executable || a.cardKind === "executes";
  if (zaviChange && a.execStatus && a.execStatus !== "failed") return null;
  if (zaviChange && role === null) return null;
  if (zaviChange && role === "viewer") return { label: VIEWER_NOTE, does: "web_only" };
  if (a.emailCard) return { label: "Review and send", does: "email" };
  if (zaviChange && !a.approveOnPhone) return { label: "Approve on the web", does: "web_only" };
  if (zaviChange && !mayApproveOnPhone(a, role)) {
    if (role === null) return null;
    return { label: role === "viewer" ? VIEWER_NOTE : ADMIN_ONLY_NOTE, does: "web_only" };
  }
  return { label: a.primaryLabel, does: "open" };
}

export type PhoneRole = "owner" | "admin" | "member" | "viewer";

export const ADMIN_ONLY_NOTE = "Only an owner or admin can approve this";

export const VIEWER_NOTE = "Viewers can't approve changes";

export function phoneApproveNote(a: { approveOnPhone: boolean; approveNeedsAdmin?: boolean | null }, role: PhoneRole | null): string | null {
  if (role === "viewer") return VIEWER_NOTE;
  if (!a.approveOnPhone || role === null || mayApproveOnPhone(a, role)) return null;
  return a.approveNeedsAdmin !== false ? ADMIN_ONLY_NOTE : null;
}

export function detailExecNote(a: { status: string; approveOnPhone: boolean; approveNeedsAdmin?: boolean | null }, role: PhoneRole | null): string {
  if (a.status !== "pending") return "Review this action’s current status on the web.";
  if (role === null) return "Checking your role…";
  const note = phoneApproveNote(a, role);
  if (note) return `${note}.`;
  return "Approve this change on the web: Zavi makes it on your ad account.";
}

export function mayApproveOnPhone(a: { approveOnPhone: boolean; approveNeedsAdmin?: boolean | null }, role: PhoneRole | null): boolean {
  if (!a.approveOnPhone || (role !== "owner" && role !== "admin" && role !== "member")) return false;
  if (a.approveNeedsAdmin !== false) return role === "owner" || role === "admin";
  return true;
}

export type ApproveMoneyView = { daily_usd: number; monthly_usd: number } | { total_usd: number };

const usd = (n: number) => !Number.isFinite(n) ? "an unknown amount" : `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

export function adApproveConfirm(a: {
  title: string;
  channelName: string;
  primaryLabel: string | null;
  approveNeedsAdmin?: boolean | null;
  approveMoney: ApproveMoneyView | null;
  changeRows: ReadonlyArray<{ item: string; before: string; after: string }>;
}): { title: string; platform: string; rows: Array<{ item: string; before: string; after: string }>; money: string | null; hold: boolean; confirmLabel: string; note: string } {
  const m = a.approveMoney;
  const money = !m ? null : "total_usd" in m ? `${usd(m.total_usd)} in total` : `${usd(m.daily_usd)} a day, about ${usd(m.monthly_usd)} a month`;
  const hold = a.approveNeedsAdmin !== false;
  const label = a.primaryLabel ?? "Approve";
  return {
    title: a.title,
    platform: a.channelName,
    rows: a.changeRows.map((r) => ({ item: r.item, before: r.before, after: r.after })),
    money,
    hold,
    confirmLabel: hold ? `Hold to ${label.toLowerCase()}` : label,
    note: `Zavi makes this change in ${a.channelName} as soon as you confirm.`,
  };
}

export const HOLD_TO_CONFIRM_MS = 1000;

export function execLine(
  status: string | null | undefined,
  platform: string,
  fixText?: string | null,
): { text: string; tone: "working" | "done" | "failed"; fix: string | null } | null {
  if (status === "queued") return { text: "Zavi is working · waiting to start", tone: "working", fix: null };
  if (status === "dispatching") return { text: "Zavi is working · making the change", tone: "working", fix: null };
  if (status === "executed") return { text: `Zavi made this change in ${platform}`, tone: "done", fix: null };
  if (status === "failed") return { text: `${platform} did not take the change.`, tone: "failed", fix: fixText ? `This needs you: ${fixText}.` : null };
  return null;
}

export function nextStepsTitle(slug: string): string {
  return slug === "meta_ads" || slug === "google_ads" ? "What Zavi wants to do" : "Next steps";
}

export function zaviSetupNotice(n: number): string | null {
  if (n <= 0) return null;
  return `Zavi needs to complete ${n} setup ${n === 1 ? "check" : "checks"}. Your next steps are listed below; no confirmation is needed for Zavi’s setup work.`;
}

export function kindPlural(kind: string): string {
  return KIND_PLURAL[kind] ?? kind;
}

export function kindBuckets<E>(entries: readonly E[], kindOf: (e: E) => string): { kind: string; entries: E[] }[] {
  const out: { kind: string; entries: E[] }[] = [];
  const at = new Map<string, number>();
  for (const e of entries) {
    const k = kindOf(e);
    const i = at.get(k);
    if (i === undefined) {
      at.set(k, out.length);
      out.push({ kind: k, entries: [e] });
    } else out[i].entries.push(e);
  }
  return out;
}

export function onePerKind<T extends { kind: string }>(cards: T[]): { shown: T[]; rest: T[] } {
  const seen = new Set<string>();
  const shown: T[] = [];
  const rest: T[] = [];
  for (const c of cards) {
    if (seen.has(c.kind)) rest.push(c);
    else {
      seen.add(c.kind);
      shown.push(c);
    }
  }
  return { shown, rest };
}
