
import { cleanAdName } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { FOUNDER_SET_BUDGET } from "./founder-set-budget";
import { BUDGET_TEST_RUNNING } from "./budget-test-shape";

const isFounderSet = (r: string) => r === FOUNDER_SET_BUDGET || r.startsWith(`${FOUNDER_SET_BUDGET}|`);
const isTestRunning = (r: string) => r === BUDGET_TEST_RUNNING || r.startsWith(`${BUDGET_TEST_RUNNING}|`);
export const RAISED_IN_LAST_DAY = "raised_in_last_day";

export function isQuietHold(reasons: readonly string[]): boolean {
  return reasons.length > 0 && reasons.every((r) => isFounderSet(r) || isTestRunning(r) || r === RAISED_IN_LAST_DAY);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const shortDate = (iso: string): string | null => {
  const m = DAY_RE.exec(iso);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : null;
};

export function quietHoldWords(reasons: readonly string[]): { words: string; until_on: string | null } {
  const test = reasons.find(isTestRunning);
  if (test) {
    const ends = test.split("|")[1] ?? "";
    const d = shortDate(ends);
    return { words: d ? `test until ${d}` : "a budget test is running", until_on: d ? ends : null };
  }
  const set = reasons.find(isFounderSet);
  if (set === undefined && reasons.includes(RAISED_IN_LAST_DAY)) return { words: "Zavi started a raise on it in the last 24 hours", until_on: null };
  const day = (set ?? "").split("|")[2] ?? "";
  const d = shortDate(day);
  return { words: d ? `you set it ${d}` : "you set it yourself", until_on: null };
}

export type QuietHold = {
  platform: string;
  object_id: string;
  name: string | null;
  from_usd: number | null;
  to_usd: number | null;
  reasons: readonly string[];
};

export async function recordQuietHold(tenant_id: string, h: QuietHold, now: Date = new Date()): Promise<boolean> {
  try {
    const { words, until_on } = quietHoldWords(h.reasons);
    const { error } = await tenantClient(asTenantId(tenant_id))
      .from("cgo_ad_holds")
      .upsert(
        {
          tenant_id,
          object_key: `${h.platform}:${h.object_id}`.slice(0, 200),
          platform: h.platform.slice(0, 40),
          object_id: h.object_id.slice(0, 120),
          name: h.name ? h.name.slice(0, 200) : null,
          from_usd: h.from_usd,
          to_usd: h.to_usd,
          reason: words.slice(0, 200),
          until_on,
          updated_at: now.toISOString(),
        },
        { onConflict: "tenant_id,object_key" },
      );
    if (error) {
      console.warn(`[ad-holds] writing the hold for ${h.platform}:${h.object_id} failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[ad-holds] writing the hold for ${h.platform}:${h.object_id} failed: ${(e as Error).message}`);
    return false;
  }
}

export async function clearStaleHolds(tenant_id: string, before: Date): Promise<void> {
  try {
    const { error } = await tenantClient(asTenantId(tenant_id)).from("cgo_ad_holds").delete().eq("tenant_id", tenant_id).lt("updated_at", before.toISOString());
    if (error) console.warn(`[ad-holds] clearing old holds for ${tenant_id} failed: ${error.message}`);
  } catch (e) {
    console.warn(`[ad-holds] clearing old holds for ${tenant_id} failed: ${(e as Error).message}`);
  }
}

export type HoldLine = { name: string | null; from_usd: number | null; to_usd: number | null; words: string };

export const HOLD_FRESH_MS = 3 * 3_600_000;

export async function readHoldLines(tenant_id: string, now: Date = new Date()): Promise<HoldLine[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("cgo_ad_holds")
    .select("name, from_usd, to_usd, reason")
    .eq("tenant_id", tenant_id)
    .gte("updated_at", new Date(now.getTime() - HOLD_FRESH_MS).toISOString())
    .order("object_key", { ascending: true })
    .limit(100);
  if (error) throw new Error(`ad-holds: read failed: ${error.message}`);
  const num = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  return ((data ?? []) as Array<{ name: string | null; from_usd: unknown; to_usd: unknown; reason: string }>).map((r) => ({
    name: r.name,
    from_usd: num(r.from_usd),
    to_usd: num(r.to_usd),
    words: r.reason,
  }));
}

export async function tellQuietHold(
  tenant_id: string,
  exec_class: string,
  body: Record<string, unknown>,
  reasons: readonly string[],
  now: Date = new Date(),
): Promise<boolean> {
  if (!isQuietHold(reasons)) return false;
  const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const from_usd = amount(body.expected_current_daily_budget_usd);
  const to_usd = amount(body.daily_budget_usd);
  if (from_usd === null || to_usd === null || to_usd <= from_usd) return false;
  try {
    const oa = await import("./open-advice");
    const refs = oa.refsFromPayload(body);
    const object_id = refs.ids[0];
    if (!object_id) return false;
    const channel = oa.channelsForAdClass(exec_class)[0] ?? exec_class.split(".")[0];
    const platform = channel.replace(/_ads$/, "");
    const typed = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    const raw = typed ?? (await oa.adObjectFor(tenant_id, exec_class, body).catch(() => null))?.name ?? null;
    const name = raw ? cleanAdName(raw) : null;
    const written = await recordQuietHold(tenant_id, { platform, object_id, name, from_usd, to_usd, reasons }, now);
    if (!written) return false;
    const { normalizeTopic } = await import("./cgo-questions");
    const { withdrawHeldObjectQuestion } = await import("./settled-questions");
    await withdrawHeldObjectQuestion(tenant_id, normalizeTopic(`held:${channel}:${object_id}`), now);
    return true;
  } catch (e) {
    console.warn(`[ad-holds] quiet hold for ${tenant_id} failed: ${(e as Error).message}`);
    return false;
  }
}
