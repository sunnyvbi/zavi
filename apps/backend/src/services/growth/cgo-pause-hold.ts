
import { asTenantId, globalClient, tenantClient } from "@/services/tenant-client";

export const CGO_PAUSE_HOLD_DAYS = 30;
const STATUS_READ_CAP = 1000;

type Platform = "meta" | "google" | "chatgpt" | "tiktok";

export type StatusActor = "cgo" | "controller" | "person";

export type StatusEvent = { platform: Platform; object_id: string; at: string; paused: boolean; by: StatusActor };

const PLATFORM_OF_PREFIX: Record<string, Platform> = { meta_ads: "meta", google_ads: "google", chatgpt_ads: "chatgpt", tiktok_ads: "tiktok" };
const ID_KEYS: Record<Platform, readonly string[]> = {
  meta: ["object_id"],
  google: ["ad_id", "ad_group_id", "campaign_id"],
  chatgpt: ["ad_id", "ad_group_id", "campaign_id"],
  tiktok: ["ad_id", "ad_group_id", "adgroup_id", "campaign_id"],
};

export const holdKey = (platform: Platform, id: string) => `${platform}:${id}`;

export function cgoPauseHolds(events: readonly StatusEvent[], now: Date, days: number = CGO_PAUSE_HOLD_DAYS): Set<string> {
  const since = now.getTime() - days * 86_400_000;
  const last = new Map<string, StatusEvent>();
  for (const e of events) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || t < since || t > now.getTime()) continue;
    if (!e.paused && e.by === "controller") continue;
    const k = holdKey(e.platform, e.object_id);
    const prev = last.get(k);
    if (!prev || t > Date.parse(prev.at)) last.set(k, e);
  }
  const out = new Set<string>();
  for (const [k, e] of last) if (e.paused && e.by !== "person") out.add(k);
  return out;
}

export function statusEventOf(row: {
  cls: string;
  body: Record<string, unknown> | null;
  at: string | null;
  approved_by_source: string | null;
  origin?: string | null;
}): StatusEvent | null {
  const platform = PLATFORM_OF_PREFIX[row.cls.split(".")[0] ?? ""];
  if (!platform || !row.body || !row.at) return null;
  const byLevel: Record<string, string> = { campaign: "campaign_id", ad_group: "ad_group_id", adgroup: "adgroup_id", ad: "ad_id" };
  const levelKey = platform === "meta" ? undefined : byLevel[String(row.body.level ?? "")];
  const keys = levelKey ? [levelKey] : ID_KEYS[platform];
  const id = keys.map((k) => row.body![k]).find((v) => typeof v === "string" && v) as string | undefined;
  if (!id) return null;
  const status = String(row.body.status ?? "");
  const by: StatusActor = row.approved_by_source !== "cgo" ? "person" : row.origin === "ad_spend_controller" ? "controller" : "cgo";
  return { platform, object_id: id, at: row.at, paused: /PAUSED/.test(status), by };
}

async function holdSwitchedOff(): Promise<boolean> {
  try {
    const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle<{ blob: Record<string, unknown> | null }>();
    if (error) return false;
    return data?.blob?.cgo_pause_hold_off === true;
  } catch {
    return false;
  }
}

export async function loadCgoPauseHolds(tenant_id: string, now: Date): Promise<Set<string>> {
  if (await holdSwitchedOff()) return new Set();
  const db = tenantClient(asTenantId(tenant_id));
  const since = new Date(now.getTime() - CGO_PAUSE_HOLD_DAYS * 86_400_000).toISOString();
  const classes = Object.keys(PLATFORM_OF_PREFIX).flatMap((p) => [`${p}.set_status`, `${p}.set_status_review`]);
  const [ca, ds] = await Promise.all([
    db
      .from("channel_actions")
      .select("exec_class, exec_payload, executed_at, approved_by_source, origin:body->>cgo_order_origin")
      .eq("tenant_id", tenant_id)
      .in("exec_class", classes)
      .eq("exec_status", "executed")
      .gte("executed_at", since)
      .order("executed_at", { ascending: false })
      .limit(STATUS_READ_CAP),
    db
      .from("decisions")
      .select("decision_class, body, dispatched_at, approved_by_source")
      .eq("tenant_id", tenant_id)
      .in("decision_class", classes)
      .eq("status", "acted")
      .gte("dispatched_at", since)
      .order("dispatched_at", { ascending: false })
      .limit(STATUS_READ_CAP),
  ]);
  if (ca.error) throw new Error(`cgo-pause-hold: status cards read failed: ${ca.error.message}`);
  if (ds.error) throw new Error(`cgo-pause-hold: status decisions read failed: ${ds.error.message}`);
  if ((ca.data ?? []).length >= STATUS_READ_CAP || (ds.data ?? []).length >= STATUS_READ_CAP) throw new Error("cgo-pause-hold: status history over the read cap");
  const events: StatusEvent[] = [];
  type CaRow = { exec_class: string; exec_payload: Record<string, unknown> | null; executed_at: string | null; approved_by_source: string | null; origin: string | null };
  for (const r of (ca.data ?? []) as CaRow[]) {
    const e = statusEventOf({ cls: r.exec_class, body: r.exec_payload, at: r.executed_at, approved_by_source: r.approved_by_source, origin: r.origin });
    if (e) events.push(e);
  }
  type DRow = { decision_class: string; body: Record<string, unknown> | null; dispatched_at: string | null; approved_by_source: string | null };
  for (const r of (ds.data ?? []) as DRow[]) {
    const e = statusEventOf({ cls: r.decision_class, body: r.body, at: r.dispatched_at, approved_by_source: r.approved_by_source });
    if (e) events.push(e);
  }
  return cgoPauseHolds(events, now);
}
