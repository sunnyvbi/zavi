
import { redactDeep, redactDocDeep, redactStringLeaves } from "./discovery/redact";
import type { OperatorDbDriver } from "./types";

const AGGREGATE_METHODS: ReadonlySet<string> = new Set<keyof OperatorDbDriver>([
  "query_bookings_by_geo_category",
  "query_active_supply_by_geo_category",
  "query_funnel_by_geo_category",
  "query_verified_bookings_by_campaign",
  "query_new_users_in_window",
  "query_new_bookings_in_window",
  "query_new_users_in_range",
  "query_new_bookings_in_range",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function redactRecord(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  return isPlainObject(v) ? redactDocDeep(v) : redactDeep(v);
}

const PAGE_MAX_CHARS = 4 * 1024 * 1024;
const CAP_MARKER = "‹redacted:capped›";

function redactPage(rows: unknown[]): unknown[] {
  let total = 0;
  return rows.map((row) => {
    if (total > PAGE_MAX_CHARS) return CAP_MARKER;
    const r = redactRecord(row);
    total += JSON.stringify(r)?.length ?? 0;
    return total > PAGE_MAX_CHARS ? CAP_MARKER : r;
  });
}

export function redactRecords(data: unknown): unknown {
  if (Array.isArray(data)) return redactPage(data);
  if (isPlainObject(data) && Array.isArray(data.rows)) {
    const { rows, ...rest } = data;
    return { ...redactDocDeep(rest), rows: redactPage(rows as unknown[]) };
  }
  return redactRecord(data);
}

export function redactingDriver(driver: OperatorDbDriver): OperatorDbDriver {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(driver)) {
    if (typeof fn !== "function") {
      out[name] = fn;
      continue;
    }
    const redact = AGGREGATE_METHODS.has(name) ? redactStringLeaves : redactRecords;
    out[name] = async (...args: unknown[]) => {
      const res = await (fn as (...a: unknown[]) => Promise<unknown>).apply(driver, args);
      if (!isPlainObject(res) || !("data" in res)) return res;
      return { ...res, data: redact(res.data) };
    };
  }
  return out as OperatorDbDriver;
}
