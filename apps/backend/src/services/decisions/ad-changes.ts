
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { AUTHORIZED_EFFECTIVE_CAP } from "@/services/tools/meta-ads/write/_user-initiated";
import type { AccountRead, LedgerCampaign, Platform } from "./ad-budget-reconcile";
import { LEDGER_ONLY_READERS, isLedgerOnlyPlatform, type LedgerOnlyPlatform } from "./ad-ledger-platforms";

export const OUTSIDE_WINDOW_MS = 2 * 3_600_000;

export type ChangeKind = "status" | "budget";
export type ChangeLevel = "ad_set" | "campaign" | "ad_group" | "ad";

export type AdChangeInput = {
  platform: Platform;
  object_id: string;
  level: ChangeLevel | null;
  campaign_id: string | null;
  object_name: string | null;
  source: "zavi" | "outside";
  action_table: "channel_actions" | "decisions" | "budget_stop" | null;
  action_id: string | null;
  change_kind: ChangeKind;
  before_status: string | null;
  after_status: string | null;
  before_daily_usd: number | null;
  after_daily_usd: number | null;
};

export type AdChangeRow = Omit<AdChangeInput, "before_daily_usd" | "after_daily_usd"> & {
  id: string;
  occurred_at: string;
  before_daily_usd: number | string | null;
  after_daily_usd: number | string | null;
};

export const AD_CHANGE_COLUMNS =
  "id, platform, object_id, level, campaign_id, object_name, source, action_table, action_id, change_kind, " +
  "before_status, after_status, before_daily_usd, after_daily_usd, occurred_at";

const numOrNull = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export const changeDaily = (v: number | string | null | undefined) => numOrNull(v);

export function onOff(platform: Platform, status: string | null | undefined): "on" | "off" | null {
  const s = String(status ?? "").toUpperCase();
  if (platform === "meta" || platform === "chatgpt" || platform === "reddit" || platform === "x" || isLedgerOnlyPlatform(platform)) {
    if (s === "ACTIVE") return "on";
    if (s === "PAUSED" || s === "CAMPAIGN_PAUSED" || s === "ADSET_PAUSED" || s === "AD_GROUP_PAUSED") return "off";
    return null;
  }
  if (s === "ENABLED") return "on";
  if (s === "PAUSED") return "off";
  return null;
}

export async function recordAdObjectChanges(tenant_id: string, changes: AdChangeInput[]): Promise<number> {
  if (changes.length === 0) return 0;
  const r = await tenantRpc(asTenantId(tenant_id), "record_ad_object_changes", { p_changes: changes });
  if (r.error) throw new Error(`record_ad_object_changes failed: ${r.error.message}`);
  return Number((r.data as { inserted?: number } | null)?.inserted ?? 0);
}

export async function recordZaviAdChange(
  tenant_id: string,
  from: { table: "channel_actions" | "decisions"; id: string },
  change: Omit<AdChangeInput, "source" | "action_table" | "action_id">,
): Promise<void> {
  try {
    await recordAdObjectChanges(tenant_id, [{ ...change, source: "zavi", action_table: from.table, action_id: from.id }]);
  } catch (e) {
    console.warn(
      `[ad-changes] prior state of ${change.platform} ${change.object_id} not recorded (tenant ${tenant_id}); it cannot be undone from the ledger: ${(e as Error).message}`,
    );
  }
}

export type StoredCampaign = Pick<LedgerCampaign, "object_id" | "campaign_id" | "name" | "budget_kind" | "status"> & {
  level: string;
  budget_usd: number | string | null;
};

const PAYLOAD_ID_KEYS = ["object_id", "ad_set_id", "campaign_id", "ad_group_id", "ad_id"] as const;

export function diffOutsideChanges(
  platform: Platform,
  stored: ReadonlyArray<StoredCampaign>,
  read: ReadonlyArray<LedgerCampaign>,
  touched: ReadonlySet<string>,
): AdChangeInput[] {
  const before = new Map(stored.map((s) => [s.object_id, s]));
  const out: AdChangeInput[] = [];
  for (const c of read) {
    const s = before.get(c.object_id);
    if (!s) continue;
    if (touched.has(c.object_id) || (c.campaign_id && touched.has(c.campaign_id))) continue;
    const base = {
      platform,
      object_id: c.object_id,
      level: (c.level === "campaign" ? "campaign" : "ad_set") as ChangeLevel,
      campaign_id: c.campaign_id,
      object_name: c.name ?? s.name ?? null,
      source: "outside" as const,
      action_table: null,
      action_id: null,
    };
    const priorDaily = s.budget_kind === "daily" ? numOrNull(s.budget_usd) : null;
    const was = onOff(platform, s.status);
    const now = onOff(platform, c.status);
    if (was && now && was !== now) {
      out.push({
        ...base,
        change_kind: "status",
        before_status: s.status,
        after_status: c.status,
        before_daily_usd: priorDaily,
        after_daily_usd: c.budget_kind === "daily" ? c.budget_usd : null,
      });
    }
    const nowDaily = c.budget_kind === "daily" ? c.budget_usd : null;
    if (priorDaily !== null && nowDaily !== null && Math.round(priorDaily * 100) !== Math.round(nowDaily * 100)) {
      out.push({
        ...base,
        change_kind: "budget",
        before_status: s.status,
        after_status: c.status,
        before_daily_usd: priorDaily,
        after_daily_usd: nowDaily,
      });
    }
  }
  return out;
}

export async function recentZaviTouches(tenant_id: string, platform: Platform, since: string): Promise<Set<string>> {
  const db = tenantClient(asTenantId(tenant_id));
  const prefix = `${platform}_ads.%`;
  const touched = new Set<string>();
  const addIds = (p: unknown) => {
    const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    for (const k of PAYLOAD_ID_KEYS) {
      const v = o[k];
      if (typeof v === "string" && v) touched.add(v);
      else if (typeof v === "number") touched.add(String(v));
    }
  };
  const [mine, acts, decs] = await Promise.all([
    db
      .from("ad_object_changes")
      .select("object_id, campaign_id")
      .eq("tenant_id", tenant_id)
      .eq("platform", platform)
      .eq("source", "zavi")
      .gte("occurred_at", since)
      .limit(1000),
    db
      .from("channel_actions")
      .select("exec_payload")
      .eq("tenant_id", tenant_id)
      .like("exec_class", prefix)
      .or(`executed_at.gte.${since},exec_status.in.(queued,dispatching)`)
      .limit(1000),
    db
      .from("decisions")
      .select("body")
      .eq("tenant_id", tenant_id)
      .like("decision_class", prefix)
      .or(`and(status.eq.acted,dispatched_at.gte.${since}),status.eq.dispatching`)
      .limit(1000),
  ]);
  if (mine.error) throw new Error(`ad_object_changes read failed: ${mine.error.message}`);
  if (acts.error) throw new Error(`channel_actions read failed: ${acts.error.message}`);
  if (decs.error) throw new Error(`decisions read failed: ${decs.error.message}`);
  for (const r of (mine.data ?? []) as Array<{ object_id: string; campaign_id: string | null }>) {
    touched.add(r.object_id);
    if (r.campaign_id) touched.add(r.campaign_id);
  }
  for (const r of (acts.data ?? []) as Array<{ exec_payload: unknown }>) addIds(r.exec_payload);
  for (const r of (decs.data ?? []) as Array<{ body: unknown }>) addIds(r.body);
  return touched;
}

export async function logOutsideChanges(tenant_id: string, read: AccountRead, now: Date = new Date()): Promise<number> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("ad_campaigns")
      .select("object_id, level, campaign_id, name, budget_kind, budget_usd, status")
      .eq("tenant_id", tenant_id)
      .eq("platform", read.platform)
      .eq("account_id", read.account_id)
      .limit(5000);
    if (error) throw new Error(`ad_campaigns read failed: ${error.message}`);
    const stored = (data ?? []) as StoredCampaign[];
    if (stored.length === 0) return 0;
    const touched = await recentZaviTouches(tenant_id, read.platform, new Date(now.getTime() - OUTSIDE_WINDOW_MS).toISOString());
    const changes = diffOutsideChanges(read.platform, stored, read.campaigns, touched);
    return await recordAdObjectChanges(tenant_id, changes);
  } catch (e) {
    console.warn(`[ad-changes] outside-Zavi check skipped for ${read.platform} (tenant ${tenant_id}): ${(e as Error).message}`);
    return 0;
  }
}

export async function readOutsideChanges(tenant_id: string, since: string, limit = 20): Promise<AdChangeRow[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("ad_object_changes")
    .select(AD_CHANGE_COLUMNS)
    .eq("tenant_id", tenant_id)
    .eq("source", "outside")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`ad_object_changes read failed: ${error.message}`);
  return (data ?? []) as AdChangeRow[];
}

const PLATFORM_NAME: Record<Platform, string> = {
  meta: "Meta", google: "Google", chatgpt: "ChatGPT", reddit: "Reddit Ads", x: "X Ads",
  ...(Object.fromEntries(LEDGER_ONLY_READERS.map((r) => [r.platform, r.name])) as Record<LedgerOnlyPlatform, string>),
};
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function changeObjectLabel(r: Pick<AdChangeInput, "platform" | "level" | "object_id" | "object_name">): string {
  const kind = `${PLATFORM_NAME[r.platform] ?? r.platform} ${r.level === "ad" ? "ad" : r.level === "campaign" || r.platform === "google" ? "campaign" : r.platform === "reddit" ? "ad group" : "ad set"}`;
  const n = typeof r.object_name === "string" ? r.object_name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (n) return `${kind} "${n}"`;
  return r.object_id.length > 4 ? `${kind} …${r.object_id.slice(-4)}` : `${kind} ${r.object_id}`;
}

export function describeChange(r: AdChangeRow | AdChangeInput): string {
  const obj = changeObjectLabel(r);
  if (r.change_kind === "status") {
    const to = onOff(r.platform, r.after_status);
    const from = onOff(r.platform, r.before_status);
    const verb = to === "off" ? "Paused" : to === "on" ? "Turned on" : "Changed the status of";
    const was = from ? ` (was ${from})` : "";
    return `${verb} ${obj}${was}`;
  }
  const b = numOrNull(r.before_daily_usd);
  const a = numOrNull(r.after_daily_usd);
  if (b !== null && a !== null) return `Changed the daily budget of ${obj}: ${usd(b)} → ${usd(a)}`;
  return `Changed the daily budget of ${obj}`;
}

export function outsideChangeLine(r: AdChangeRow): string {
  return `${r.occurred_at.slice(0, 10)}: ${describeChange(r)} outside Zavi. The founder's decision: do not reverse it without asking.`;
}

export function freedPerDay(r: Pick<AdChangeInput, "platform" | "change_kind" | "before_status" | "after_status" | "before_daily_usd">): number | null {
  if (r.change_kind !== "status") return null;
  if (onOff(r.platform, r.after_status) !== "off" || onOff(r.platform, r.before_status) !== "on") return null;
  const d = numOrNull(r.before_daily_usd);
  return d !== null && d > 0 ? d : null;
}

export type Inverse = {
  decision_class: string;
  body: Record<string, unknown>;
  change: string;
  raises_spend: boolean;
};

export function inverseOf(r: AdChangeRow): Inverse | null {
  if (r.platform === "chatgpt") return null;
  if (r.platform === "reddit" || r.platform === "x" || isLedgerOnlyPlatform(r.platform)) return null;
  if (r.source !== "zavi" || (r.action_table !== "channel_actions" && r.action_table !== "decisions")) return null;
  const obj = changeObjectLabel(r);
  const name = typeof r.object_name === "string" && r.object_name.trim() ? { name: r.object_name.trim().slice(0, 200) } : {};
  const rationale = "Undo requested by the founder from the ad budget ledger.";
  if (r.change_kind === "status") {
    const was = onOff(r.platform, r.before_status);
    const is = onOff(r.platform, r.after_status);
    if (!was || !is || was === is) return null;
    const turnOn = was === "on";
    if (r.platform === "meta") {
      return {
        decision_class: "meta_ads.set_status_review",
        body: {
          object_id: r.object_id,
          level: r.level === "campaign" ? "campaign" : "adset",
          status: turnOn ? "ACTIVE" : "PAUSED",
          expected_current_status: is === "on" ? "ACTIVE" : "PAUSED",
          rationale,
          over_cap: true,
          origin: "user_initiated_ledger",
          ...name,
          about: "Founder undo of an earlier change.",
        },
        change: `${turnOn ? "Turn on" : "Pause"} ${obj} again`,
        raises_spend: turnOn,
      };
    }
    if (r.level !== "campaign") return null;
    return {
      decision_class: "google_ads.set_status_review",
      body: { campaign_id: r.object_id, level: "campaign", status: turnOn ? "ENABLED" : "PAUSED", expected_current_status: is === "on" ? "ENABLED" : "PAUSED", rationale, over_cap: true, origin: "user_initiated_ledger", ...name, about: "Founder undo of an earlier change." },
      change: `${turnOn ? "Turn on" : "Pause"} ${obj} again`,
      raises_spend: turnOn,
    };
  }
  const before = numOrNull(r.before_daily_usd);
  const after = numOrNull(r.after_daily_usd);
  if (before === null || after === null || !(before > 0) || Math.round(before * 100) === Math.round(after * 100)) return null;
  const change = `Set the daily budget of ${obj} back to ${usd(before)} (from ${usd(after)})`;
  if (r.platform === "meta") {
    const campaign = r.level === "campaign";
    return {
      decision_class: campaign ? "meta_ads.update_campaign_budget_review" : "meta_ads.update_ad_set_budget_review",
      body: {
        [campaign ? "campaign_id" : "ad_set_id"]: r.object_id,
        daily_budget_usd: before,
        expected_current_daily_budget_usd: after,
        rationale,
        over_cap: true,
        origin: "user_initiated_ledger",
        authorized_effective_cap: AUTHORIZED_EFFECTIVE_CAP,
        ...name,
        about: "Founder undo of an earlier budget change.",
      },
      change,
      raises_spend: before > after,
    };
  }
  return {
    decision_class: "google_ads.update_campaign_budget_review",
    body: { campaign_id: r.object_id, daily_budget_usd: before, expected_current_daily_budget_usd: after, rationale, over_cap: true, origin: "user_initiated_ledger", ...name, about: "Founder undo of an earlier budget change." },
    change,
    raises_spend: before > after,
  };
}

export type UndoStage =
  | { status: "staged"; decision_id: string; change: string; raises_spend: boolean }
  | { status: "not_found" | "not_undoable" | "changed_since" | "plan_upgrade_required" | "write_disabled" };

export async function stageUndo(
  tenant_id: string,
  change_id: string,
  deps: {
    isPro: () => Promise<boolean>;
    writeEnabled?: (platform: Platform) => Promise<boolean>;
    metaCurrency?: (tenant_id: string) => Promise<string>;
  },
): Promise<UndoStage> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data, error } = await db
    .from("ad_object_changes")
    .select(AD_CHANGE_COLUMNS)
    .eq("tenant_id", tenant_id)
    .eq("id", change_id)
    .maybeSingle();
  if (error) throw new Error(`ad_object_changes read failed: ${error.message}`);
  const row = data as AdChangeRow | null;
  if (!row) return { status: "not_found" };
  const inv = inverseOf(row);
  if (!inv) return { status: "not_undoable" };
  const { data: newer, error: nErr } = await db
    .from("ad_object_changes")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("platform", row.platform)
    .eq("object_id", row.object_id)
    .gt("occurred_at", row.occurred_at)
    .limit(1);
  if (nErr) throw new Error(`ad_object_changes read failed: ${nErr.message}`);
  if ((newer ?? []).length > 0) return { status: "changed_since" };
  if (inv.raises_spend && !(await deps.isPro())) return { status: "plan_upgrade_required" };
  const writeEnabled =
    deps.writeEnabled ??
    (async (p: Platform) => {
      if (p === "meta") return (await import("@/services/tools/meta-ads/write/_flag-check")).isMetaAdsWriteEnabled();
      return (await import("@/services/tools/google-ads/write/_flag-check")).isGoogleAdsWriteEnabled();
    });
  if (!(await writeEnabled(row.platform))) return { status: "write_disabled" };
  if (inv.decision_class === "meta_ads.update_ad_set_budget_review" || inv.decision_class === "meta_ads.update_campaign_budget_review") {
    const metaCurrency =
      deps.metaCurrency ??
      (async (t: string) => (await import("@/services/tools/meta-ads/_client")).getAdAccountCurrency(t));
    inv.body = { ...inv.body, currency: (await metaCurrency(tenant_id)).toUpperCase() };
  }
  const r = await tenantRpc(asTenantId(tenant_id), "emit_decision", {
    p_agent_run_id: null,
    p_decision_class: inv.decision_class,
    p_body: inv.body,
  });
  if (r.error || typeof r.data !== "string") throw new Error(`emit_decision failed: ${r.error?.message ?? "no id"}`);
  return { status: "staged", decision_id: r.data, change: inv.change, raises_spend: inv.raises_spend };
}
