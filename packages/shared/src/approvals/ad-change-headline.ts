
const BUDGET_CLASSES: Readonly<Record<string, "ad_set" | "campaign">> = {
  "meta_ads.update_ad_set_budget": "ad_set",
  "meta_ads.update_ad_set_budget_review": "ad_set",
  "meta_ads.update_campaign_budget": "campaign",
  "meta_ads.update_campaign_budget_review": "campaign",
  "google_ads.update_campaign_budget": "campaign",
  "google_ads.update_campaign_budget_review": "campaign",
};

const STATUS_CLASSES: ReadonlySet<string> = new Set([
  "meta_ads.set_status",
  "meta_ads.set_status_review",
  "google_ads.set_status",
  "google_ads.set_status_review",
]);

const NAME_MAX = 80;

export const AD_CHANGE_HEADLINE_FIELDS = [
  "name", "verified_name", "daily_budget_usd", "expected_current_daily_budget_usd", "currency", "object_daily_budget", "object_status",
  "status", "level", "campaign_id", "ad_set_id", "ad_group_id", "ad_id", "object_id", "total_budget_cents", "end_time",
] as const;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
};
const amount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export function isAdChangeHeadlineClass(decision_class: string | null | undefined): boolean {
  return typeof decision_class === "string" && (Object.hasOwn(BUDGET_CLASSES, decision_class) || STATUS_CLASSES.has(decision_class));
}

export function adMoney(n: number, currency?: unknown): string {
  const code = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "USD";
  const digits = { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 };
  if (code === "USD") return `$${n.toLocaleString("en-US", digits)}`;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code, ...digits }).format(n);
  } catch {
    return `${n.toLocaleString("en-US", digits)} ${code}`;
  }
}

function quote(name: string): string {
  const chars = Array.from(name);
  return `“${chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join("").trimEnd()}…` : name}”`;
}

function label(b: Record<string, unknown>, noun: string, id: string | null): string | null {
  if (!id) return null;
  const verified = str(b.verified_name);
  if (verified) return quote(verified);
  const typed = str(b.name);
  return typed ? `${quote(typed)} (${noun} ${id})` : `${noun} ${id}`;
}

const META_STATUS_LEVEL: Readonly<Record<string, string>> = { campaign: "campaign", adset: "ad set" };
const GOOGLE_STATUS_LEVEL: Readonly<Record<string, { noun: string; key: string }>> = {
  campaign: { noun: "campaign", key: "campaign_id" },
  ad_group: { noun: "ad group", key: "ad_group_id" },
  ad: { noun: "ad", key: "ad_id" },
};

function statusHeadline(decision_class: string, b: Record<string, unknown>): string | null {
  if (decision_class.startsWith("meta_ads.")) {
    const noun = typeof b.level === "string" ? META_STATUS_LEVEL[b.level] : undefined;
    const who = noun ? label(b, noun, str(b.object_id)) : null;
    if (!who) return null;
    return b.status === "PAUSED" ? `Pause ${who}` : b.status === "ACTIVE" ? `Turn on ${who}` : null;
  }
  const lv = GOOGLE_STATUS_LEVEL[typeof b.level === "string" ? b.level : "campaign"];
  const who = lv ? label(b, lv.noun, str(b[lv.key])) : null;
  if (!who) return null;
  return b.status === "PAUSED" ? `Pause ${who}` : b.status === "ENABLED" ? `Turn on ${who}` : null;
}

export function adChangeHeadline(decision_class: string | null | undefined, body: unknown): string | null {
  if (typeof decision_class !== "string") return null;
  const b = obj(body);
  const level = BUDGET_CLASSES[decision_class];
  if (level) {
    const to = amount(b.daily_budget_usd);
    const from = amount(b.expected_current_daily_budget_usd);
    if (to === null || from === null) return null;
    const who = label(b, level === "ad_set" ? "ad set" : "campaign", level === "ad_set" ? str(b.ad_set_id) : str(b.campaign_id));
    if (!who) return null;
    if (to === from) return `Keep ${who} at ${adMoney(to, b.currency)} a day`;
    return `${to > from ? "Raise" : "Cut"} ${who} from ${adMoney(from, b.currency)} to ${adMoney(to, b.currency)} a day`;
  }
  if (STATUS_CLASSES.has(decision_class)) return statusHeadline(decision_class, b);
  return linkedinLaunchHeadline(decision_class, b);
}

export function adCardTitle(r: { title?: string | null; exec_class?: string | null; exec_payload?: unknown }): string {
  return adChangeHeadline(r.exec_class, r.exec_payload) ?? r.title ?? "";
}

export function adChangeObjectLabel(decision_class: string | null | undefined, body: unknown): string | null {
  if (typeof decision_class !== "string") return null;
  const b = obj(body);
  const level = BUDGET_CLASSES[decision_class];
  if (level) return label(b, level === "ad_set" ? "ad set" : "campaign", level === "ad_set" ? str(b.ad_set_id) : str(b.campaign_id));
  if (!STATUS_CLASSES.has(decision_class)) return null;
  if (decision_class.startsWith("meta_ads.")) {
    const noun = typeof b.level === "string" ? META_STATUS_LEVEL[b.level] : undefined;
    return noun ? label(b, noun, str(b.object_id)) : null;
  }
  const lv = GOOGLE_STATUS_LEVEL[typeof b.level === "string" ? b.level : "campaign"];
  return lv ? label(b, lv.noun, str(b[lv.key])) : null;
}

const ZAVI_NAME_PREFIX = /^\s*Zavi\s*·\s*/;
const ZAVI_NAME_TAG = /(\s*·\s*(campaign|ad set|adset|ad group|ad))?\s*·\s*zv[0-9a-f]{6,}\s*$/i;

export function cleanAdName(name: string): string {
  const s = name.replace(/\s+/g, " ").trim();
  const out = s.replace(ZAVI_NAME_PREFIX, "").replace(ZAVI_NAME_TAG, "").trim();
  return out.length > 0 ? out : s;
}

export const LINKEDIN_LAUNCH_HEADLINE_CLASS = "linkedin_ads.launch_campaign";

export function linkedinLaunchHeadline(decision_class: string | null | undefined, body: unknown): string | null {
  if (decision_class !== LINKEDIN_LAUNCH_HEADLINE_CLASS) return null;
  const b = obj(body);
  const name = str(b.name);
  const cents = amount(b.total_budget_cents);
  const currency = typeof b.currency === "string" && /^[A-Z]{3}$/.test(b.currency) ? b.currency : null;
  const end = typeof b.end_time === "number" && b.end_time > 0 ? new Date(b.end_time) : null;
  if (!name || !cents || !currency || !end || Number.isNaN(end.getTime())) return null;
  const stamp = end.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `Launch ${quote(cleanAdName(name))}: ${adMoney(cents / 100, currency)} total, ends ${stamp} UTC`;
}

export function linkedinLaunchTotalText(body: unknown): string | null {
  const b = obj(body);
  const cents = amount(b.total_budget_cents);
  const usd = amount(b.total_budget_usd);
  const currency = typeof b.currency === "string" && /^[A-Z]{3}$/.test(b.currency) ? b.currency : null;
  if (cents && currency) {
    const own = adMoney(cents / 100, currency);
    return currency !== "USD" && usd ? `${own} (about ${adMoney(usd)})` : own;
  }
  return usd ? adMoney(usd) : null;
}

export function adChangeCleanObjectLabel(decision_class: string | null | undefined, body: unknown): string | null {
  const b = obj(body);
  const clean = (v: unknown) => (typeof v === "string" ? cleanAdName(v) : v);
  return adChangeObjectLabel(decision_class, { ...b, verified_name: clean(b.verified_name), name: clean(b.name) });
}

export type AdChangeMoney = {
  verb: "Turn on" | "Pause" | "Raise" | "Cut" | "Keep";
  name: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  currency: unknown;
};

export function adChangeMoney(decision_class: string | null | undefined, body: unknown): AdChangeMoney | null {
  if (typeof decision_class !== "string") return null;
  const b = obj(body);
  const verified = str(b.verified_name);
  const name = verified ? cleanAdName(verified) : adChangeObjectLabel(decision_class, body);
  if (!name) return null;
  const out = (verb: AdChangeMoney["verb"], before: number | null, after: number | null): AdChangeMoney => ({
    verb,
    name,
    before,
    after,
    delta: before !== null && after !== null ? after - before : null,
    currency: b.currency,
  });
  if (Object.hasOwn(BUDGET_CLASSES, decision_class)) {
    const to = amount(b.daily_budget_usd);
    const from = amount(b.expected_current_daily_budget_usd);
    if (to === null || from === null) return null;
    return out(to > from ? "Raise" : to < from ? "Cut" : "Keep", from, to);
  }
  if (!STATUS_CLASSES.has(decision_class)) return null;
  const own = amount(b.object_daily_budget);
  const isOn = b.object_status === "ACTIVE" || b.object_status === "ENABLED";
  const isOff = b.object_status === "PAUSED";
  const known = own !== null && (isOn || isOff);
  if (b.status === "PAUSED") return out("Pause", known ? own : null, known ? (isOff ? own : 0) : null);
  if (b.status === "ACTIVE" || b.status === "ENABLED") return out("Turn on", known ? (isOn ? own : 0) : null, known ? own : null);
  return null;
}
