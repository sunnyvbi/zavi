
import {
  FOR_YOU_CAP,
  categoryOf,
  categoryRank,
  connectedDetail,
  purposeFor,
  webOrder,
} from "./webCatalog";

export type Health = "connected" | "stale" | "expiring" | "reconnect" | "off";

export type ConnectorRow = {
  slug: string;
  account_login?: string | null;
  team_name?: string | null;
  team_id?: string | null;
  managed_by?: string | null;
  repo_full_names?: string[] | null;
  repo_ids?: number[] | null;
  repo_private?: boolean[] | null;
  selected_repo_ids?: number[] | null;
  default_repo_full_name?: string | null;
  repo_default_branches?: Record<string, string> | null;
  account_type?: string | null;
  connected_at?: string | null;
  token_expires_at?: string | null;
};

export type Connection = {
  slug: string;
  label: string;
  health: Health;
  reason?: string;
  expiresInDays?: number;
  account?: string;
  detail?: string;
  purpose: string;
  category: string;
  connectedAt?: string;
  lastSyncAt?: string;
  usedBy: readonly string[];
  feedsGoal: boolean;
  logoUrl?: string;
  comingSoon?: boolean;
  requested?: boolean;
  managed?: boolean;
};

export const GOAL_CONNECTORS: ReadonlySet<string> = new Set(["meta_ads", "google_ads", "stripe", "operator_db"]);

const DAY_MS = 86_400_000;
const SYNC_STALE_MS = DAY_MS + 12 * 3_600_000;

const FIRST: readonly string[] = ["slack", "github"];
const META_ADS_TOKEN_TTL_DAYS = 60;
const EXPIRY_WARN_DAYS = 14;

export function tokenHealth(
  row: ConnectorRow,
  now: number,
): { health: Health; days?: number } {
  let expires: number | null = null;
  if (row.token_expires_at) expires = Date.parse(row.token_expires_at);
  else if (row.slug === "meta_ads" && row.connected_at) {
    expires = Date.parse(row.connected_at) + META_ADS_TOKEN_TTL_DAYS * DAY_MS;
  }
  if (expires === null || Number.isNaN(expires)) return { health: "connected" };
  const days = Math.ceil((expires - now) / DAY_MS);
  if (days <= 0) return { health: "reconnect" };
  if (days <= EXPIRY_WARN_DAYS) return { health: "expiring", days };
  return { health: "connected" };
}

export function isBroken(c: Pick<Connection, "health">): boolean {
  return c.health === "reconnect";
}

export function buildConnections(input: {
  rows: readonly ConnectorRow[];
  suggested: readonly string[];
  labelFor: (slug: string) => string;
  usedByFor: (slug: string) => readonly string[];
  slackMissing?: readonly string[];
  lastSync?: Readonly<Record<string, string>>;
  now: number;
}): Connection[] {
  const { rows, labelFor, usedByFor, now } = input;
  const out: Connection[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.slug)) continue;
    seen.add(row.slug);
    const label = labelFor(row.slug);
    const base = {
      slug: row.slug,
      label,
      account: row.account_login || row.team_name || undefined,
      detail: connectedDetail(row) || undefined,
      purpose: purposeFor(row.slug, label),
      category: categoryOf(row.slug),
      connectedAt: row.connected_at ?? undefined,
      lastSyncAt: input.lastSync?.[row.slug],
      usedBy: usedByFor(row.slug),
      feedsGoal: GOAL_CONNECTORS.has(row.slug),
    };
    if (row.slug === "slack" && input.slackMissing && input.slackMissing.length > 0) {
      const m = input.slackMissing;
      const missing = m.length === 1 ? `Missing scope: ${m[0]}.` : `Missing ${m.length} scopes: ${m.join(", ")}.`;
      out.push({ ...base, health: "reconnect", reason: `${missing} Reconnect to grant them.` });
      continue;
    }
    const t = row.slug === "meta_ads" || row.slug === "google_ads" ? tokenHealth(row, now) : { health: "connected" as const };
    if (t.health === "reconnect") {
      out.push({
        ...base,
        health: "reconnect",
        reason: "Access token expired — agents can't read this account until you reconnect.",
      });
    } else if (t.health === "expiring") {
      out.push({
        ...base,
        health: "expiring",
        expiresInDays: t.days,
        reason: `Access token expires in ${t.days} day${t.days === 1 ? "" : "s"} — reconnect to refresh it.`,
      });
    } else {
      const synced = base.lastSyncAt ? Date.parse(base.lastSyncAt) : NaN;
      const stale = Number.isFinite(synced) && now - synced > SYNC_STALE_MS;
      out.push({ ...base, health: stale ? "stale" : "connected" });
    }
  }

  for (const slug of input.suggested) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const label = labelFor(slug);
    out.push({
      slug,
      label,
      health: "off",
      purpose: purposeFor(slug, label),
      category: categoryOf(slug),
      usedBy: usedByFor(slug),
      feedsGoal: GOAL_CONNECTORS.has(slug),
    });
  }
  return out;
}

function firstRank(slug: string): number {
  const i = FIRST.indexOf(slug);
  return i === -1 ? FIRST.length : i;
}

export function groupConnections(list: readonly Connection[]): {
  attention: Connection[];
  connected: Connection[];
  off: Connection[];
} {
  const lead = (a: Connection, b: Connection) =>
    firstRank(a.slug) - firstRank(b.slug) || webOrder(a.slug) - webOrder(b.slug);
  return {
    attention: list.filter(isBroken).sort(lead),
    connected: list.filter((c) => c.health !== "reconnect" && c.health !== "off").sort(lead),
    off: list.filter((c) => c.health === "off").sort(lead),
  };
}

export function sectionConnections(
  list: readonly Connection[],
  forYouOrder: readonly string[],
): {
  attention: Connection[];
  connected: Connection[];
  forYou: Connection[];
  categories: { title: string; items: Connection[] }[];
} {
  const { attention, connected, off } = groupConnections(list);
  const forYou: Connection[] = [];
  for (const slug of forYouOrder) {
    if (forYou.length >= FOR_YOU_CAP) break;
    const c = off.find((x) => x.slug === slug);
    if (c && !forYou.includes(c)) forYou.push(c);
  }
  const byCategory = new Map<string, Connection[]>();
  for (const c of off) {
    if (forYou.includes(c)) continue;
    byCategory.set(c.category, [...(byCategory.get(c.category) ?? []), c]);
  }
  const categories = [...byCategory.entries()]
    .sort(([a], [b]) => categoryRank(a) - categoryRank(b) || a.localeCompare(b))
    .map(([title, items]) => ({ title, items }));
  return { attention, connected, forYou, categories };
}

export function blockers(list: readonly Connection[]): Connection[] {
  return list.filter((c) => isBroken(c) && c.feedsGoal);
}

export function statusText(c: Pick<Connection, "health" | "expiresInDays" | "comingSoon" | "managed">): string {
  if (c.managed) return "Managed by Zavi";
  if (c.comingSoon && c.health === "off") return "Coming soon";
  switch (c.health) {
    case "connected":
      return "Connected";
    case "stale":
      return "Not syncing";
    case "expiring":
      return `Expiring in ${c.expiresInDays ?? 0}d`;
    case "reconnect":
      return "Needs reconnect";
    case "off":
      return "Not connected";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function agoText(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t) || now - t < -60_000) return undefined;
  const min = Math.floor(Math.max(0, now - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export function shortDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function rowSubtitle(c: Connection, now: number): string {
  if (c.health === "off") return c.purpose;
  if (c.reason) return c.reason;
  const sync = agoText(c.lastSyncAt, now);
  if (sync) return [`Last synced ${sync}`, c.detail].filter(Boolean).join(" · ");
  return c.detail ?? c.purpose;
}
