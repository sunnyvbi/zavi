
export type BudgetPlatform = "meta" | "google" | "chatgpt" | "tiktok" | "linkedin";
export type FounderBudgetSource = "outside" | "ordered" | "edited" | "approved";
export type FounderBudgetEvent = {
  source: FounderBudgetSource;
  at: string;
  direction?: "up" | "down" | null;
  via?: "chat" | "zavi" | null;
};

export const FOUNDER_SET_BUDGET = "founder_set_budget";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export function blockingFounderEvent(events: readonly FounderBudgetEvent[], direction: "up" | "down" | "same" | null | undefined): FounderBudgetEvent | null {
  const dated = events.filter((e) => Number.isFinite(Date.parse(e.at)));
  if (dated.length === 0) return null;
  const latest = dated.reduce((a, b) => (Date.parse(b.at) > Date.parse(a.at) ? b : a));
  if (latest.source !== "approved") return latest;
  if (latest.direction !== "up" && latest.direction !== "down") return latest;
  if (direction !== "up" && direction !== "down") return latest;
  return direction === latest.direction ? null : latest;
}

export function founderSetBudgetReason(e: FounderBudgetEvent | null | undefined, platform: BudgetPlatform): string {
  if (!e) return FOUNDER_SET_BUDGET;
  const d = day(e.at);
  if (!d) return FOUNDER_SET_BUDGET;
  const tail = e.source === "ordered" ? (e.via ?? "") : (e.direction ?? "");
  return `${FOUNDER_SET_BUDGET}|${e.source}|${d}|${platform}|${tail}`;
}

const WHERE: Record<BudgetPlatform, string> = { meta: "Ads Manager", google: "Google Ads", tiktok: "TikTok Ads Manager", chatgpt: "ChatGPT Ads", linkedin: "LinkedIn Campaign Manager" };

export function founderSetBudgetWords(reason: string): string | null {
  if (reason === FOUNDER_SET_BUDGET) return "you set its budget yourself in the last 30 days";
  if (!reason.startsWith(`${FOUNDER_SET_BUDGET}|`)) return null;
  const [, source, d, platform, tail] = reason.split("|");
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return "you set its budget yourself in the last 30 days";
  const on = `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
  switch (source) {
    case "outside":
      return `you changed its budget in ${WHERE[platform as BudgetPlatform] ?? "the ad account"} on ${on}`;
    case "ordered":
      return tail === "chat" ? `you set its budget in chat on ${on}` : `you set its budget yourself on ${on}`;
    case "edited":
      return `you edited its budget on the card on ${on}`;
    case "approved":
      return tail === "up"
        ? `you approved raising its budget on ${on}, so I don't cut it on my own`
        : tail === "down"
          ? `you approved cutting its budget on ${on}, so I don't raise it on my own`
          : `you approved its budget on ${on}`;
    default:
      return "you set its budget yourself in the last 30 days";
  }
}

const amountOf = (m: unknown): unknown => (m && typeof m === "object" ? (m as { amount?: unknown }).amount : undefined);

export function bodyDirection(body: unknown): "up" | "down" | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const to = Number("daily_budget_usd" in b ? b.daily_budget_usd : amountOf(b.proposed));
  const from = Number("expected_current_daily_budget_usd" in b ? b.expected_current_daily_budget_usd : amountOf(b.expected_current));
  if (!Number.isFinite(to) || !Number.isFinite(from)) return null;
  const t = Math.round(to * 100);
  const f = Math.round(from * 100);
  return t > f ? "up" : t < f ? "down" : null;
}

export function founderOriginated(...bodies: unknown[]): { yes: boolean; via: "chat" | "zavi" | null } {
  for (const body of bodies) {
    if (!body || typeof body !== "object") continue;
    const b = body as Record<string, unknown>;
    if (b.founder_chat_order === true || b.origin === "user_initiated_chat") return { yes: true, via: "chat" };
    if (b.origin === "user_initiated_ledger") return { yes: true, via: "zavi" };
  }
  return { yes: false, via: null };
}

export function founderEditedAmount(exec_payload: unknown, edited_body: unknown): boolean {
  if (!edited_body || typeof edited_body !== "object") return false;
  const p = exec_payload as Record<string, unknown> | null;
  const e = edited_body as Record<string, unknown>;
  const was = Number(p && !("daily_budget_usd" in p) ? amountOf(p.proposed) : p?.daily_budget_usd);
  const now = Number("daily_budget_usd" in e ? e.daily_budget_usd : amountOf(e.proposed));
  if (!Number.isFinite(now)) return false;
  return !Number.isFinite(was) || Math.round(was * 100) !== Math.round(now * 100);
}
