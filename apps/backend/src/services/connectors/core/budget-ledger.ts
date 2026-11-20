
import { asTenantId, tenantClient } from "@/services/tenant-client";

export class ConnectionUnknownError extends Error {}

export async function ledgerConnected(tenantId: string, slug: string, label: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("connector_metadata")
    .select("slug")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new ConnectionUnknownError(`${label} connection could not be checked.`);
  return !!data;
}

export function zoneDate(at: Date, timeZone?: string | null): string {
  if (!timeZone) return at.toISOString().slice(0, 10);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  } catch {
    throw new Error(`Unknown ad account time zone ${timeZone}; spend is unknown.`);
  }
  const v = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}

export function zoneOffset(ymd: string, timeZone?: string | null): string {
  if (!timeZone) return "+00:00";
  const probe = new Date(`${ymd}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dayChunks(since: string, until: string, maxDays: number): Array<{ since: string; until: string }> {
  const out: Array<{ since: string; until: string }> = [];
  for (let s = since; s <= until; s = addDays(s, maxDays)) {
    const e = addDays(s, maxDays - 1);
    out.push({ since: s, until: e < until ? e : until });
  }
  return out;
}

export function requireUsd(label: string, currencies: ReadonlyArray<string | null | undefined>): void {
  if (currencies.some((c) => String(c ?? "").toUpperCase() !== "USD"))
    throw new Error(`Shared ad budgets require USD ${label} accounts.`);
}

export function spendAmount(label: string, raw: unknown, divisor = 1): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} returned an unreadable spend value; spend is unknown.`);
  return n / divisor;
}

export class DailySpend {
  private readonly rows = new Map<string, number>();
  add(object_id: string, spend_date: string, amount_usd: number): void {
    const k = `${object_id}\u0000${spend_date}`;
    this.rows.set(k, (this.rows.get(k) ?? 0) + amount_usd);
  }
  toRows(until: string, provisionalDays: number) {
    const firstProvisional = addDays(until, -(provisionalDays - 1));
    return [...this.rows].map(([k, amount]) => {
      const [object_id, spend_date] = k.split("\u0000");
      return { object_id, spend_date, amount_usd: Math.round(amount * 1e6) / 1e6, provisional: spend_date >= firstProvisional };
    });
  }
}

export function onOffStatus(on: boolean | null, raw: string | null | undefined): string | null {
  if (on === true) return "ACTIVE";
  if (on === false) return "PAUSED";
  return raw == null ? null : String(raw).toUpperCase();
}

export function campaignIdleSince(status: string | null | undefined, lastModified: string | null | undefined, since: string, stopped: readonly string[]): boolean {
  if (status === "DRAFT") return true;
  if (!status || !stopped.includes(status) || !lastModified) return false;
  const t = Date.parse(lastModified);
  return Number.isFinite(t) && t < Date.parse(since);
}
