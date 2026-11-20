
export type AdPlatform = "meta" | "google" | "reddit";

export const ZONE_TTL_MS = 24 * 3_600_000;

const zones = new Map<string, { at: number; zone: string }>();
const keyOf = (tenant_id: string, platform: AdPlatform, account: string) => `${tenant_id}:${platform}:${account}`;

export function _resetAccountZones(): void {
  zones.clear();
}

export function dateInZone(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const v = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function wholeDaysWindow(today: string, days: number): { since: string; until: string } {
  const until = shiftDate(today, -1);
  return { since: shiftDate(until, 1 - days), until };
}

export function rememberAccountZone(tenant_id: string, platform: AdPlatform, account: string, zone: string, now: Date = new Date()): void {
  dateInZone(now, zone);
  zones.set(keyOf(tenant_id, platform, account), { at: now.getTime(), zone });
}

export function knownAccountZone(tenant_id: string, platform: AdPlatform, account: string, now: Date = new Date()): string | null {
  const hit = zones.get(keyOf(tenant_id, platform, account));
  return hit && now.getTime() - hit.at < ZONE_TTL_MS ? hit.zone : null;
}

export async function metaAccountZone(tenant_id: string, account: string, now: Date = new Date()): Promise<string> {
  const known = knownAccountZone(tenant_id, "meta", account, now);
  if (known) return known;
  const { fbGet } = await import("@/services/tools/meta-ads/_client");
  const facts = (await fbGet(tenant_id, account, { fields: "timezone_name" })) as { timezone_name?: string } | null;
  const zone = facts?.timezone_name;
  if (!zone) throw new Error(`Meta did not report ad account ${account}'s time zone`);
  rememberAccountZone(tenant_id, "meta", account, zone, now);
  return zone;
}

export async function googleAccountZone(tenant_id: string, customer: string, now: Date = new Date()): Promise<string> {
  const known = knownAccountZone(tenant_id, "google", customer, now);
  if (known) return known;
  const { gadsSearch } = await import("@/services/tools/google-ads/_client");
  const { accountClock } = await import("@/services/tools/google-ads/_read-window");
  const clock = await accountClock(tenant_id, (q) => gadsSearch(tenant_id, q));
  rememberAccountZone(tenant_id, "google", customer, clock.time_zone, now);
  return clock.time_zone;
}

async function googleAccountId(tenant_id: string, fetch: boolean): Promise<string> {
  const google = await import("@/services/tools/google-ads/_client");
  return fetch ? google.gadsCustomerId(tenant_id) : google.gadsStoredCustomerId(tenant_id);
}

export async function accountTodays(
  tenant_id: string,
  platforms: readonly Exclude<AdPlatform, "reddit">[],
  now: Date,
  opts: { fetch: boolean },
): Promise<Partial<Record<AdPlatform, string>>> {
  const out: Partial<Record<AdPlatform, string>> = {};
  for (const platform of platforms) {
    try {
      const account =
        platform === "meta"
          ? (await (await import("@/services/tools/meta-ads/_client")).metaAdsCreds(tenant_id)).ad_account_id
          : await googleAccountId(tenant_id, opts.fetch);
      const zone = opts.fetch
        ? platform === "meta"
          ? await metaAccountZone(tenant_id, account, now)
          : await googleAccountZone(tenant_id, account, now)
        : knownAccountZone(tenant_id, platform, account, now);
      if (zone) out[platform] = dateInZone(now, zone);
    } catch (e) {
      console.warn(`[account-zone] ${platform} clock unread for tenant ${tenant_id}, counting UTC days: ${(e as Error).message}`);
    }
  }
  return out;
}
