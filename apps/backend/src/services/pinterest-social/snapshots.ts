import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { pinterestExec, pinterestInsightsReadTool, type PinterestInsightsResult } from "@/services/tools/pinterest-insights/read";
import { PIN_WINDOWS, readPinterestDetail, type PinterestDetail } from "./detail";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { utcDay } from "@/services/x-social/read-cap";

export const PINTEREST_CHANNEL = "pinterest";
export const PINTEREST_METER_KEY = "pinterest_metrics";
export const PINTEREST_READS_PER_DAY = 3;

export type RefreshResult =
  | { ok: true; used: number; cap: number }
  | { ok: false; reason: "not_connected" | "cap_reached" | "unavailable" | "read_failed"; message: string };

type RefreshDeps = {
  resolveAccount?: typeof resolveOwnedComposioAccount;
  rpc?: typeof tenantRpc;
  client?: ReturnType<typeof tenantClient>;
  read?: (tenantId: string) => Promise<PinterestInsightsResult>;
  detail?: (tenantId: string, connectedAccountId: string, now: Date) => Promise<PinterestDetail>;
  now?: () => Date;
};

type StoredDetail = Pick<PinterestDetail, "daily" | "pins">;

export function keepStoredDetail(fresh: PinterestDetail, stored: StoredDetail | null): PinterestDetail {
  const daily = fresh.daily ?? stored?.daily ?? null;
  const pins = fresh.pins_error && stored?.pins ? { ...stored.pins, ...(fresh.pins ?? {}) } : fresh.pins;
  const allWindows = !!pins && PIN_WINDOWS.every((days) => pins[String(days)]);
  return {
    daily,
    daily_error: daily ? null : fresh.daily_error,
    pins,
    pins_error: allWindows ? null : fresh.pins_error,
  };
}

export async function refreshPinterest(tenantId: string, deps: RefreshDeps = {}): Promise<RefreshResult> {
  const resolveAccount = deps.resolveAccount ?? resolveOwnedComposioAccount;
  let account;
  try {
    account = await resolveAccount(tenantId, "pinterest");
  } catch {
    return { ok: false, reason: "unavailable", message: "Zavi could not check the Pinterest connection just now." };
  }
  if (!account) return { ok: false, reason: "not_connected", message: "Connect Pinterest in Settings first." };

  const now = (deps.now ?? (() => new Date()))();
  const rpc = deps.rpc ?? tenantRpc;
  let used: number;
  try {
    const { data, error } = await rpc(asTenantId(tenantId), "consume_metered_read_or_reject", {
      p_day: utcDay(now),
      p_key: PINTEREST_METER_KEY,
      p_cap: PINTEREST_READS_PER_DAY,
    });
    if (error) return { ok: false, reason: "unavailable", message: "Zavi could not check today's refresh allowance." };
    if (data === null || data === undefined) {
      return { ok: false, reason: "cap_reached", message: `All ${PINTEREST_READS_PER_DAY} of today's Pinterest refreshes are used. They reset at midnight UTC.` };
    }
    used = Number(data);
  } catch {
    return { ok: false, reason: "unavailable", message: "Zavi could not check today's refresh allowance." };
  }

  let result: PinterestInsightsResult;
  let detail: PinterestDetail;
  try {
    const read = deps.read ?? (async (id: string) => pinterestInsightsReadTool.execute(
      { tenant_id: id, agent_slug: "pinterest_organic", log: () => {} },
      { days: 30, top_pins: 10 },
    ) as Promise<PinterestInsightsResult>);
    const readDetail = deps.detail ?? ((id: string, accountId: string, at: Date) => readPinterestDetail(pinterestExec(id, accountId), at));
    [result, detail] = await Promise.all([
      read(tenantId),
      readDetail(tenantId, account.connected_account_id, now).catch((error: Error): PinterestDetail => ({
        daily: null,
        daily_error: error.message || "read failed",
        pins: null,
        pins_error: error.message || "read failed",
      })),
    ]);
  } catch (error) {
    return { ok: false, reason: "read_failed", message: (error as Error).message || "Pinterest did not answer." };
  }

  const client = deps.client ?? tenantClient(asTenantId(tenantId));
  if (detail.daily === null || detail.pins_error) {
    const today = await client
      .from("social_account_snapshots")
      .select("metrics")
      .eq("tenant_id", tenantId)
      .eq("channel", PINTEREST_CHANNEL)
      .eq("captured_on", utcDay(now))
      .maybeSingle();
    if (today.error) return { ok: false, reason: "unavailable", message: "Pinterest answered in part, and Zavi could not check today's stored numbers." };
    detail = keepStoredDetail(detail, (today.data as { metrics: StoredDetail | null } | null)?.metrics ?? null);
  }
  const stored = await client.from("social_account_snapshots").upsert(
    {
      tenant_id: tenantId,
      channel: PINTEREST_CHANNEL,
      captured_on: utcDay(now),
      username: result.username,
      followers_count: result.follower_count,
      post_count: result.pin_count,
      metrics: {
        account_totals: result.account_totals,
        account_error: result.account_error,
        window: result.window,
        daily: detail.daily,
        daily_error: detail.daily_error,
        pins: detail.pins,
        pins_error: detail.pins_error,
      },
    },
    { onConflict: "tenant_id,channel,captured_on" },
  );
  if (stored.error) {
    return { ok: false, reason: "unavailable", message: `Read Pinterest, but could not store it: ${stored.error.message}` };
  }
  return { ok: true, used, cap: PINTEREST_READS_PER_DAY };
}
