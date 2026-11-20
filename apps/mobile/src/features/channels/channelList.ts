
export type WorkState = "idle" | "running" | "needs_review" | "delivered";
export type PlanTier = "starter" | "growth" | "pro";

export type ChannelInput = {
  channel_slug: string;
  work_state: WorkState;
  locked?: boolean;
  locked_tier?: string | null;
};

export type ListRow = {
  slug: string;
  name: string;
  description: string;
  waiting: number;
  unseen: number;
  workState: WorkState;
  comingSoon: boolean;
  planTier: PlanTier | null;
  status: { tone: "working" | "new" | "muted"; text: string } | null;
  group: ListGroup;
};

export type ListGroup = "organic" | "creators" | "paid" | "owned" | "plan" | "soon";

export const OPEN_SECTIONS: ReadonlyArray<{ key: Exclude<ListGroup, "plan" | "soon">; label: string }> = [
  { key: "organic", label: "Organic" },
  { key: "creators", label: "Creators" },
  { key: "paid", label: "Paid ads" },
  { key: "owned", label: "Email and SMS" },
];

export const PLAN_ORDER: readonly PlanTier[] = ["starter", "growth", "pro"];

export function sectionOf(c: { category?: string; section?: string }): Exclude<ListGroup, "plan" | "soon"> {
  if (c.section === "creators") return "creators";
  if (c.category === "paid") return "paid";
  if (c.category === "owned") return "owned";
  return "organic";
}

export const CHANNEL_ORDER = [
  "meta_ads",
  "google_ads",
  "tiktok_ads",
  "linkedin_ads",
  "youtube_ads",
  "reddit_ads",
  "chatgpt_ads",
  "seo",
  "geo",
  "linkedin_organic",
  "reddit_organic",
  "x_organic",
  "instagram_organic",
  "tiktok_organic",
  "pinterest_organic",
  "youtube_organic",
  "ugc",
  "generated_video",
  "email_marketing",
  "sms",
] as const;

const PLAN_NAMES: Record<string, string> = { free: "Free", starter: "Starter", growth: "Growth", pro: "Pro" };

export function planName(tier: string | null | undefined): string | null {
  return tier ? PLAN_NAMES[tier] ?? null : null;
}

function planTierOf(v: string | null | undefined): PlanTier | null {
  return v === "starter" || v === "growth" || v === "pro" ? v : null;
}

export function waitingLabel(n: number): string {
  return n > 5 ? "5+" : String(n);
}

export function waitingText(n: number): string {
  return `${waitingLabel(n)} ${n === 1 ? "action" : "actions"} waiting`;
}

const STATE_LABEL: Record<WorkState, string | null> = {
  idle: null,
  running: "Working on it",
  needs_review: "Ready for you",
  delivered: "Done",
};

function statusOf(r: Omit<ListRow, "status" | "group">): ListRow["status"] {
  if (r.workState === "running") return { tone: "working", text: "Working on it" };
  if (r.planTier) return r.waiting > 0 ? { tone: "muted", text: waitingText(r.waiting) } : null;
  if (r.unseen > 0) return { tone: "new", text: waitingText(r.unseen) };
  if (r.waiting > 0) return { tone: "muted", text: waitingText(r.waiting) };
  const label = STATE_LABEL[r.workState];
  return label ? { tone: "muted", text: label } : null;
}

function tierOf(r: Pick<ListRow, "waiting" | "workState">): number {
  if (r.waiting > 0) return 0;
  if (r.workState === "needs_review") return 1;
  if (r.workState === "running") return 2;
  return 3;
}

export function buildChannelRows(input: {
  registry: (slug: string) => { name: string; description: string; category?: string; section?: string } | null;
  channels: readonly ChannelInput[] | undefined;
  pending: Readonly<Record<string, number>>;
  seen: Readonly<Record<string, number>>;
  order?: readonly string[];
}): ListRow[] {
  const views = new Map((input.channels ?? []).map((c) => [c.channel_slug, c]));
  const rows = CHANNEL_ORDER.flatMap((slug, index) => {
    const meta = input.registry(slug);
    if (!meta) return [];
    const view = views.get(slug);
    const waiting = input.pending[slug] ?? 0;
    const base = {
      slug,
      name: meta.name,
      description: meta.description,
      waiting,
      unseen: Math.max(0, waiting - (input.seen[slug] ?? 0)),
      workState: view?.work_state ?? "idle",
      comingSoon: view?.locked === true,
      planTier: planTierOf(view?.locked_tier),
    } as const;
    const status = statusOf(base);
    const group: ListGroup = base.comingSoon ? "soon" : base.planTier ? "plan" : sectionOf(meta);
    return [{ row: { ...base, status, group } as ListRow, index }];
  });
  const frozen = input.order ? new Map(input.order.map((s, i) => [s, i])) : null;
  const rank = (r: ListRow, index: number) => frozen?.get(r.slug) ?? (frozen ? frozen.size + index : 0);
  return rows
    .sort((a, b) =>
      frozen
        ? rank(a.row, a.index) - rank(b.row, b.index)
        : Number(a.row.comingSoon) - Number(b.row.comingSoon) || tierOf(a.row) - tierOf(b.row) || a.index - b.index,
    )
    .map((r) => r.row);
}

export function listSummary(rows: readonly ListRow[]): { actions: number; channels: number; working: number } {
  const open = rows.filter((r) => !r.comingSoon);
  return {
    actions: open.reduce((n, r) => n + r.unseen, 0),
    channels: open.filter((r) => r.unseen > 0).length,
    working: open.filter((r) => r.workState === "running").length,
  };
}

export function groupRows(rows: readonly ListRow[]): {
  sections: Array<{ key: string; label: string; rows: ListRow[] }>;
  plans: Array<{ tier: PlanTier; rows: ListRow[]; waiting: number }>;
  soon: ListRow[];
} {
  const sections = OPEN_SECTIONS.map((s) => ({ ...s, rows: rows.filter((r) => r.group === s.key) })).filter((s) => s.rows.length > 0);
  const plans = PLAN_ORDER.map((tier) => {
    const list = rows.filter((r) => r.group === "plan" && r.planTier === tier);
    return { tier, rows: list, waiting: list.reduce((n, r) => n + r.waiting, 0) };
  }).filter((g) => g.rows.length > 0);
  return { sections, plans, soon: rows.filter((r) => r.group === "soon") };
}
