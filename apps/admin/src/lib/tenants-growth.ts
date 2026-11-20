export type GrowthPerson = {
  id: string;
  email: string | null;
  name: string | null;
  signup_at: string;
  last_active_at: string | null;
  is_test: boolean;
  test_reasons: string[];
  country: string | null;
  city: string | null;
  tenant_ids: string[];
};
export type GrowthTenant = {
  source?: {
    source: string;
    kind:
      | "affiliate"
      | "from"
      | "utm_source"
      | "referrer"
      | "ad_network"
      | "direct"
      | "unknown";
    creator_id?: string;
  };
  source_detail?: string | null;
  id: string;
  slug: string;
  display_name: string;
  created_at: string;
  owner_id: string | null;
  owner_count: number;
  is_test: boolean;
  test_reasons: string[];
  tier: string;
  is_comp: boolean;
  plan_start: string | null;
  plan_end: string | null;
  cancels: boolean;
  added_url: string | null;
  built_urls: string[];
  connections: string[];
  socials: string[];
  mcp_connections: string[];
  last_active_at: string | null;
};
export type GrowthUsage = {
  tenant_id: string;
  runs: number;
  cost_usd: number;
  ok_rate: number | null;
  user_messages: number;
};
export type GrowthData = {
  sources_available?: boolean;
  usage?: GrowthUsage[] | null;
  today: string;
  tracking_started_at: string;
  users: GrowthPerson[];
  tenants: GrowthTenant[];
  activity: { user_id: string; day: string }[];
};
export type GrowthCard = "active" | "today" | "range" | "paid" | null;
export const istDate = (iso: string | Date) =>
  new Date(new Date(iso).getTime() + 19800000).toISOString().slice(0, 10);
export const shiftDay = (day: string, amount: number) =>
  new Date(Date.parse(day + "T00:00:00Z") + amount * 86400000)
    .toISOString()
    .slice(0, 10);
export function presetRange(preset: string, today: string) {
  return {
    from:
      preset === "month"
        ? today.slice(0, 8) + "01"
        : shiftDay(today, 1 - Number(preset)),
    to: today,
  };
}
export function validDateRange(from: string, to: string, today: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(to) &&
    Number.isFinite(Date.parse(from)) &&
    Number.isFinite(Date.parse(to)) &&
    new Date(from).toISOString().slice(0, 10) === from &&
    new Date(to).toISOString().slice(0, 10) === to &&
    from <= to &&
    to <= today &&
    Date.parse(to) - Date.parse(from) <= 3659 * 86400000
  );
}
export function growthView(
  data: GrowthData,
  from: string,
  to: string,
  showTest: boolean,
) {
  const peopleById = new Map(data.users.map((u) => [u.id, u]));
  const tenants = data.tenants.filter((t) => showTest || !t.is_test);
  const tenantIds = new Set(tenants.map((t) => t.id));
  const people = data.users.filter(
    (u) =>
      showTest ||
      !u.tenant_ids.length ||
      u.tenant_ids.some((id) => tenantIds.has(id)),
  );
  const personIds = new Set(people.map((u) => u.id));
  const active = new Map<string, Set<string>>();
  for (const a of data.activity) {
    if (!personIds.has(a.user_id)) continue;
    const set = active.get(a.day) ?? new Set<string>();
    set.add(a.user_id);
    active.set(a.day, set);
  }
  const signups = new Map<string, number>();
  for (const u of people) {
    const day = istDate(u.signup_at);
    signups.set(day, (signups.get(day) ?? 0) + 1);
  }
  const count = (start: string, end: string) =>
    people.filter((u) => {
      const d = istDate(u.signup_at);
      return d >= start && d <= end;
    }).length;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const chart = [];
  for (let i = 0; i < days; i++) {
    const day = shiftDay(from, i);
    chart.push({
      day,
      signups: signups.get(day) ?? 0,
      active: active.get(day)?.size ?? 0,
    });
  }
  const paid = { starter: 0, growth: 0, pro: 0 };
  let comps = 0;
  for (const t of tenants) {
    if (t.tier in paid) {
      if (t.is_comp) comps++;
      else paid[t.tier as keyof typeof paid]++;
    }
  }
  return {
    tenants,
    people,
    peopleById,
    active,
    chart,
    paid,
    comps,
    cards: {
      active: active.get(data.today)?.size ?? 0,
      activePrevious: active.get(shiftDay(data.today, -1))?.size ?? 0,
      today: signups.get(data.today) ?? 0,
      todayPrevious: signups.get(shiftDay(data.today, -7)) ?? 0,
      range: count(from, to),
      rangePrevious: count(shiftDay(from, -days), shiftDay(from, -1)),
      paid: Object.values(paid).reduce((a, b) => a + b, 0),
    },
    hidden: data.tenants.length - tenants.length,
  };
}
export function personMatchesCard(
  u: GrowthPerson,
  card: GrowthCard,
  data: GrowthData,
  from: string,
  to: string,
  active: Map<string, Set<string>>,
) {
  const signup = istDate(u.signup_at);
  return card === "active"
    ? !!active.get(data.today)?.has(u.id)
    : card === "today"
      ? signup === data.today
      : card === "range"
        ? signup >= from && signup <= to
        : card !== "paid";
}
export function tenantMatchesCard(
  t: GrowthTenant,
  card: GrowthCard,
  data: GrowthData,
  from: string,
  to: string,
  active: Map<string, Set<string>>,
  people: GrowthPerson[],
) {
  if (!card) return true;
  if (card === "paid")
    return !t.is_comp && ["starter", "growth", "pro"].includes(t.tier);
  return people.some(
    (u) =>
      u.tenant_ids.includes(t.id) &&
      personMatchesCard(u, card, data, from, to, active),
  );
}
const SOCIAL: Record<string, string> = {
  linkedin: "LinkedIn",
  twitter: "X",
  x: "X",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  reddit: "Reddit",
  pinterest: "Pinterest",
  facebook: "Facebook",
};
const LABEL: Record<string, string> = {
  slack: "Slack",
  stripe: "Stripe",
  github: "GitHub",
  google_analytics: "Google Analytics",
  googleanalytics: "Google Analytics",
  ga4: "Google Analytics",
  meta_ads: "Meta Ads",
  linkedin_ads: "LinkedIn Ads",
  chatgpt_ads: "ChatGPT Ads",
  google_ads: "Google Ads",
  googleads: "Google Ads",
  reddit_ads: "Reddit Ads",
  x_ads: "X Ads",
  tiktok_ads: "TikTok Ads",
};
export function connectionTags(t: GrowthTenant) {
  const integrations = new Set<string>(),
    socials = new Set(t.socials.map((k) => SOCIAL[k] ?? k));
  for (const raw of [...t.connections, ...t.mcp_connections]) {
    const key = raw.toLowerCase().replace(/^composio[.:]/, "");
    if (SOCIAL[key]) socials.add(SOCIAL[key]);
    else integrations.add(LABEL[key] ?? key.replace(/_/g, " "));
  }
  return {
    integrations: [...integrations].sort(),
    socials: [...socials].sort(),
  };
}
export function safeWebsite(url: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}
export function relativeTime(iso: string | null, now = Date.now()) {
  if (!iso) return "—";
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
export function delta(value: number, previous: number) {
  const change = value - previous;
  return `${change > 0 ? "+" : ""}${change} (${previous === 0 ? (value ? "new" : "0%") : `${change > 0 ? "+" : ""}${Math.round((change / previous) * 100)}%`})`;
}
