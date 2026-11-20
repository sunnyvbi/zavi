
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { nudgeOpsAlertDrain } from "@/services/logging/ops-alert-outbox";
import type { AdHoldRef } from "@/services/decisions/ad-budget";

export const UNKNOWN_HOLD_MIN_AGE_MS = 2 * 3_600_000;
const MAX_HOLDS_PER_RUN = 20;

type UnknownHold = {
  id: string;
  idem_key: string;
  platform: string;
  provider_ref: unknown;
  updated_at: string;
  daily_delta_usd?: number | string | null;
  amount_usd?: number | string | null;
};

export type ResolveDeps = {
  find: (tenant_id: string, ref: AdHoldRef) => Promise<string[]>;
  alert?: (tenant_id: string, hold: UnknownHold) => Promise<void>;
};

export const NO_REF_HOLD_SOURCE = "ad_hold_no_ref";
export const noRefHoldAlertKey = (hold_id: string) => `${NO_REF_HOLD_SOURCE}:${hold_id}`;

export function noRefHoldAlertMessage(tenant_id: string, h: Pick<UnknownHold, "id" | "idem_key" | "platform" | "updated_at" | "daily_delta_usd" | "amount_usd">): string {
  const n = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const daily = n(h.daily_delta_usd);
  const total = n(h.amount_usd);
  const money = [daily !== null ? `$${daily.toFixed(2)}/day` : null, total !== null ? `$${total.toFixed(2)} held` : null].filter(Boolean).join(", ");
  return `Ad budget hold ${h.id} (${h.platform}, ${h.idem_key}) on tenant ${tenant_id} has no record of what it created${money ? ` (${money})` : ""}, held since ${h.updated_at}. Nothing will release it on its own: check whether the ${h.platform} object exists, then commit or release the hold.`;
}

export async function alertNoRefHold(tenant_id: string, h: UnknownHold): Promise<void> {
  try {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "enqueue_ops_alert", {
      p_dedupe_key: noRefHoldAlertKey(h.id),
      p_source: NO_REF_HOLD_SOURCE,
      p_code: "no_usable_ref",
      p_tenant_id: tenant_id,
      p_msg: noRefHoldAlertMessage(tenant_id, h),
    });
    if (error) throw new Error(error.message);
    if (data === true) nudgeOpsAlertDrain();
  } catch (e) {
    console.warn(`[ad-hold-resolve] alert enqueue failed for hold ${h.id}: ${(e as Error).message}`);
  }
}

export type ResolveOutcome = { found: number; released: number; kept: number; failed: number };

function asRef(v: unknown): AdHoldRef | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const str = (x: unknown) => typeof x === "string" && x.length > 0;
  if (r.kind === "meta_tag" && (r.level === "adset" || r.level === "campaign") && str(r.campaign_id) && str(r.tag))
    return r as AdHoldRef;
  if (r.kind === "meta_adset_name" && str(r.campaign_id) && str(r.name)) return r as AdHoldRef;
  if ((r.kind === "google_campaign_name" || r.kind === "chatgpt_campaign_name") && str(r.name)) return r as AdHoldRef;
  if (r.kind === "tiktok_tag" && typeof r.advertiser_id === "string" && /^\d{1,32}$/.test(r.advertiser_id) && typeof r.tag === "string" && /^zv[0-9a-f]{10}$/.test(r.tag)) return r as AdHoldRef;
  return null;
}

function refPlatform(ref: AdHoldRef): string {
  if (ref.kind === "google_campaign_name") return "google";
  if (ref.kind === "chatgpt_campaign_name") return "chatgpt";
  if (ref.kind === "tiktok_tag") return "tiktok";
  return "meta";
}

export async function findAdObjects(tenant_id: string, ref: AdHoldRef): Promise<string[]> {
  if (ref.kind === "tiktok_tag") {
    const { tiktokAdsAccount } = await import("@/services/connectors/tiktok-ads/composio-read");
    const { listTiktokAdGroups } = await import("@/services/connectors/tiktok-ads/objects");
    const groups = await listTiktokAdGroups(await tiktokAdsAccount(tenant_id), ref.advertiser_id);
    const tagged = groups.filter((g) => g.status !== "DELETED" && g.name.includes(ref.tag)).map((g) => g.id);
    if (tagged.length) return tagged;
    const { data, error } = await tenantClient(asTenantId(tenant_id)).from("tiktok_ad_launches").select("adgroup_id").eq("tag", ref.tag).limit(5);
    if (error) throw new Error(`tiktok_ad_launches read failed: ${error.message}`);
    const saved = ((data ?? []) as Array<{ adgroup_id: string | null }>).map((r) => r.adgroup_id).filter((id): id is string => !!id);
    return groups.filter((g) => saved.includes(g.id) && g.status !== "DELETED").map((g) => g.id);
  }
  if (ref.kind === "chatgpt_campaign_name") {
    const { listChatgptAdsCampaigns } = await import("@/services/connectors/chatgpt-ads/client");
    const { getChatgptAdsApiKey } = await import("@/services/connectors/chatgpt-ads/key-provider");
    const { ownsCampaignName, resolveTenantCampaignPrefix } = await import("@/services/connectors/chatgpt-ads/tenant-scope");
    const prefix = await resolveTenantCampaignPrefix(tenant_id);
    const {getAccountBinding,bindCampaign}=await import("@/services/ads-wallet/bindings");
    const {resolveChatgptAccount}=await import("@/services/connectors/chatgpt-ads/account-binding");
    const bound=ref.account_binding_id?await getAccountBinding(tenant_id,ref.account_binding_id):null;
    const key=bound?(await resolveChatgptAccount(tenant_id,bound)).key:await getChatgptAdsApiKey();
    const all = await listChatgptAdsCampaigns(key);
    if (all.pages_exhausted || all.unreadable_campaigns > 0) throw new Error("Incomplete ChatGPT inventory");
    const matches=all.campaigns.filter(c => ownsCampaignName(c.name, prefix) && c.name === ref.name);
    return Promise.all(matches.map(async c=>bound?.funding_source==="provider"?(await bindCampaign(tenant_id,bound,c.id)).id:c.id));
  }
  if (ref.kind === "google_campaign_name") {
    const { gadsSearch } = await import("@/services/tools/google-ads/_client");
    const rows = (await gadsSearch(
      tenant_id,
      "SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status != 'REMOVED'",
      { complete: true },
    )) as Array<{ campaign?: { id?: string | number; name?: string } }>;
    return rows.filter((r) => r.campaign?.name === ref.name && r.campaign?.id != null).map((r) => String(r.campaign!.id));
  }
  const { fbGetAllPages, metaAdsCreds } = await import("@/services/tools/meta-ads/_client");
  if (ref.kind === "meta_tag" && ref.level === "campaign") {
    const account = (await metaAdsCreds(tenant_id)).ad_account_id;
    const rows = await fbGetAllPages<{ id?: string; name?: string }>(tenant_id, `${account}/campaigns`, {
      fields: "id,name",
      filtering: JSON.stringify([{ field: "name", operator: "CONTAIN", value: ref.tag }]),
      limit: 50,
    });
    return rows.filter((r) => r.id && r.name?.includes(ref.tag)).map((r) => r.id as string);
  }
  const rows = await fbGetAllPages<{ id?: string; name?: string }>(tenant_id, `${ref.campaign_id}/adsets`, {
    fields: "id,name",
    limit: 200,
  });
  const match = ref.kind === "meta_tag" ? (n: string) => n.includes(ref.tag) : (n: string) => n === ref.name;
  return rows.filter((r) => r.id && typeof r.name === "string" && match(r.name)).map((r) => r.id as string);
}

async function claimedPendingTestKeys(tenant_id: string): Promise<Set<string>> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("ad_pending_tests").select("hold_idem_key").eq("status", "claimed").limit(10);
  if (error) throw new Error(error.message);
  return new Set(((data ?? []) as Array<{ hold_idem_key: string | null }>).map((r) => r.hold_idem_key).filter((k): k is string => !!k));
}

export async function resolveUnknownAdHolds(
  tenant_id: string,
  now: Date = new Date(),
  deps: ResolveDeps = { find: findAdObjects, alert: alertNoRefHold },
  opts: { allowRelease?: boolean; platforms?: readonly string[] } = {},
): Promise<ResolveOutcome> {
  const out: ResolveOutcome = { found: 0, released: 0, kept: 0, failed: 0 };
  let holds: UnknownHold[];
  try {
    const r = await tenantClient(asTenantId(tenant_id))
      .from("ad_budget_reservations")
      .select("id, idem_key, platform, provider_ref, updated_at, daily_delta_usd, amount_usd")
      .eq("tenant_id", tenant_id)
      .in("status", ["reserved", "committed"])
      .is("object_id", null)
      .lt("updated_at", new Date(now.getTime() - UNKNOWN_HOLD_MIN_AGE_MS).toISOString())
      .order("updated_at", { ascending: true })
      .limit(MAX_HOLDS_PER_RUN);
    if (r.error) throw new Error(r.error.message);
    holds = (r.data ?? []) as UnknownHold[];
  } catch (e) {
    console.error(`[ad-hold-resolve] holds read failed for tenant ${tenant_id}: ${(e as Error).message}`);
    out.failed += 1;
    return out;
  }

  let claims: Set<string>;
  try {
    claims = holds.length ? await claimedPendingTestKeys(tenant_id) : new Set();
  } catch (e) {
    console.error(`[ad-hold-resolve] pending test claims unread for tenant ${tenant_id}; holds kept: ${(e as Error).message}`);
    out.kept += holds.length;
    out.failed += 1;
    return out;
  }

  for (const h of holds) {
    if (claims.has(h.idem_key)) {
      out.kept += 1;
      continue;
    }
    const ref = asRef(h.provider_ref);
    if (!ref || refPlatform(ref) !== h.platform) {
      console.warn(`[ad-hold-resolve] hold ${h.id} (${h.idem_key}) has no usable ref; kept for a person to check`);
      if (deps.alert) await deps.alert(tenant_id, h);
      out.kept += 1;
      continue;
    }
    let ids: string[];
    try {
      ids = await deps.find(tenant_id, ref);
    } catch (e) {
      console.warn(`[ad-hold-resolve] lookup failed for hold ${h.id}; kept: ${(e as Error).message}`);
      out.kept += 1;
      continue;
    }
    if (ids.length > 1) {
      console.warn(`[ad-hold-resolve] hold ${h.id} matches ${ids.length} objects; kept for a person to check`);
      out.kept += 1;
      continue;
    }
    if (ids.length === 0 && (opts.allowRelease === false || (opts.platforms && !opts.platforms.includes(h.platform)))) {
      out.kept += 1;
      continue;
    }
    try {
      const r = await tenantRpc(asTenantId(tenant_id), "resolve_unknown_ad_hold", {
        p_hold_id: h.id,
        p_outcome: ids.length === 1 ? "found" : "absent",
        p_object_id: ids[0] ?? null,
        p_seen_updated_at: h.updated_at,
      });
      if (r.error) throw new Error(r.error.message);
      const status = (r.data as { status?: string } | null)?.status;
      if (status === "resolved") out.found += 1;
      else if (status === "released") out.released += 1;
      else out.kept += 1;
    } catch (e) {
      console.error(`[ad-hold-resolve] resolve failed for hold ${h.id}; kept: ${(e as Error).message}`);
      out.failed += 1;
    }
  }
  return out;
}

const BUDGET_CARD = /^(meta_ads\.update_ad_set_budget|google_ads\.update_campaign_budget|chatgpt_ads\.update_campaign_budget)(_review)?$/;
const STATUS_CARD = /^(meta_ads|google_ads)\.set_status(_review)?$/;

export type InflightHold = {
  id: string;
  op: string;
  platform: string;
  object_id: string;
  updated_at: string;
};

export type LedgerRow = {
  object_id: string;
  campaign_id: string | null;
  level: string;
  budget_kind: string;
  budget_usd: number | null;
  campaign_budget_usd: number | null;
  status: string | null;
  as_of: string;
};

export function inflightOutcome(
  h: InflightHold,
  card: { exec_class: string; body: Record<string, unknown> } | null,
  rows: readonly LedgerRow[],
  now: Date,
): "landed" | "not_landed" | null {
  if (!card) return null;
  if (h.platform === "x") {
    const own = rows.find(r => r.object_id === h.object_id && Date.parse(r.as_of) >= Math.max(Date.parse(h.updated_at), now.getTime() - 3 * 3600000));
    if (h.op === "resume" && card.exec_class === "x_ads.set_status" && own?.status === "ACTIVE") return "landed";
    const changes = card.body.changes as { daily_budget?: number } | undefined;
    if (h.op === "raise" && card.exec_class === "x_ads.update_campaign" && own?.budget_kind === "daily" && changes?.daily_budget != null && Number(own.budget_usd) >= changes.daily_budget) return "landed";
    if (h.op === "resume" && card.exec_class === "x_ads.set_status" && own?.status === "PAUSED") return "not_landed";
    const before = (card.body.before as { daily_budget?: number | null } | undefined)?.daily_budget;
    if (h.op === "raise" && card.exec_class === "x_ads.update_campaign" && own?.budget_kind === "daily" && own.budget_usd != null && before != null && Number.isFinite(Number(before)) && Number(own.budget_usd) <= Number(before) + 1e-6) return "not_landed";
    return null;
  }
  if (h.platform === "tiktok") {
    const own = rows.find((r) => r.object_id === h.object_id && Date.parse(r.as_of) >= Math.max(Date.parse(h.updated_at), now.getTime() - 3 * 3600000));
    if (!own) return null;
    if (h.op === "raise" && card.exec_class === "tiktok_ads.update_budget") {
      const target = Number(card.body.daily_budget_usd);
      const before = Number(card.body.expected_current_daily_budget_usd);
      if (own.budget_kind !== "daily" || own.budget_usd == null || !Number.isFinite(target)) return null;
      if (Number(own.budget_usd) >= target - 0.01) return "landed";
      if (Number.isFinite(before) && Number(own.budget_usd) <= before + 1e-6) return "not_landed";
      return null;
    }
    if (h.op === "resume" && card.exec_class === "tiktok_ads.set_status" && card.body.status === "ACTIVE") {
      const st = (own.status ?? "").toUpperCase();
      if (st === "ACTIVE" || (st === "CAMPAIGN_PAUSED" && own.level === "ad_group")) return "landed";
      if (st === "PAUSED") return "not_landed";
    }
    return null;
  }
  if (h.platform === "reddit") {
    const own = rows.find((r) => r.object_id === h.object_id && Date.parse(r.as_of) >= Math.max(Date.parse(h.updated_at), now.getTime() - 3 * 3600000));
    if (h.op === "raise" && card.exec_class === "reddit_ads.update_budget" && own?.budget_kind === "daily" && own.budget_usd != null && Number(own.budget_usd) >= Number(card.body.daily_budget_usd)) return "landed";
    if (h.op === "raise" && card.exec_class === "reddit_ads.update_budget" && own?.budget_kind === "daily" && own.budget_usd != null && Number.isFinite(Number(card.body.expected_current_daily_budget_usd)) && Number(own.budget_usd) <= Number(card.body.expected_current_daily_budget_usd) + 1e-6) return "not_landed";
    if (h.op === "resume" && card.exec_class === "reddit_ads.launch_campaign" && own?.status === "ACTIVE") return "landed";
    if (h.op === "resume" && card.exec_class === "reddit_ads.set_object_status" && card.body.level === "ad_group" && card.body.object_id === h.object_id && own?.status === "ACTIVE") return "landed";
    return null;
  }
  const since = Math.max(new Date(h.updated_at).getTime(), now.getTime() - 3 * 3_600_000);
  const fresh = rows.filter((r) => new Date(r.as_of).getTime() >= since);
  const own = fresh.find((r) => r.object_id === h.object_id) ?? null;
  const children = h.platform === "meta" ? fresh.filter((r) => r.level === "ad_set" && r.campaign_id === h.object_id && r.object_id !== h.object_id) : [];
  if (!own && children.length === 0) return null;
  const st = (r: LedgerRow) => (r.status ?? "").toUpperCase();

  if (h.op === "raise") {
    if (!BUDGET_CARD.test(card.exec_class)) return null;
    const target = Number(card.body.daily_budget_usd);
    if (!Number.isFinite(target) || target <= 0) return null;
    const live =
      own && own.budget_kind === "daily" && own.budget_usd !== null
        ? Number(own.budget_usd)
        : children.map((c) => c.campaign_budget_usd).find((v) => v !== null && v !== undefined) ?? null;
    if (live === null || !Number.isFinite(Number(live))) return null;
    return Number(live) >= target - 0.01 ? "landed" : "not_landed";
  }

  if (h.op === "resume") {
    if (!STATUS_CARD.test(card.exec_class)) return null;
    const wanted = String(card.body.status ?? "").toUpperCase();
    if (wanted !== "ACTIVE" && wanted !== "ENABLED") return null;
    if (own) {
      if (st(own) === "ACTIVE" || st(own) === "ENABLED") return "landed";
      if (st(own) === "PAUSED" || st(own) === "ADSET_PAUSED") return "not_landed";
      return null;
    }
    if (children.some((c) => st(c) === "ACTIVE" || st(c) === "ADSET_PAUSED")) return "landed";
    if (children.every((c) => st(c) === "CAMPAIGN_PAUSED")) return "not_landed";
    return null;
  }
  return null;
}

async function settleInflightHold(tenant_id: string, h: InflightHold, outcome: "landed" | "not_landed", out: ResolveOutcome): Promise<void> {
  const r = await tenantRpc(asTenantId(tenant_id), "resolve_inflight_ad_hold", {
    p_hold_id: h.id,
    p_outcome: outcome,
    p_seen_updated_at: h.updated_at,
  });
  if (r.error) throw new Error(r.error.message);
  const status = (r.data as { status?: string } | null)?.status;
  if (status === "committed") out.found += 1;
  else if (status === "released") out.released += 1;
  else out.kept += 1;
}

export async function resolveInflightAdHolds(
  tenant_id: string,
  now: Date = new Date(),
  opts: { allowRelease?: boolean; platforms?: readonly string[] } = {},
): Promise<ResolveOutcome> {
  const out: ResolveOutcome = { found: 0, released: 0, kept: 0, failed: 0 };
  if (opts.allowRelease === false) return out;
  const db = tenantClient(asTenantId(tenant_id));
  let holds: Array<InflightHold & { idem_key?: string; decision_id: string | null; channel_action_id: string | null; provider_ref?: unknown }>;
  try {
    const r = await db
      .from("ad_budget_reservations")
      .select("id, idem_key, op, platform, object_id, updated_at, decision_id, channel_action_id, provider_ref")
      .eq("tenant_id", tenant_id)
      .eq("status", "reserved")
      .in("op", ["raise", "resume"])
      .not("object_id", "is", null)
      .lt("updated_at", new Date(now.getTime() - UNKNOWN_HOLD_MIN_AGE_MS).toISOString())
      .order("updated_at", { ascending: true })
      .limit(MAX_HOLDS_PER_RUN);
    if (r.error) throw new Error(r.error.message);
    holds = (r.data ?? []) as typeof holds;
  } catch (e) {
    console.error(`[ad-hold-resolve] in-flight holds read failed for tenant ${tenant_id}: ${(e as Error).message}`);
    out.failed += 1;
    return out;
  }

  for (const h of holds) {
    const launch = h.platform === "linkedin" && h.op === "resume" && !h.decision_id && !h.channel_action_id ? /^([0-9a-f-]{36}):resume$/i.exec(String(h.idem_key ?? ""))?.[1] : undefined;
    if (launch) {
      try {
        const { linkedinLaunchHoldOutcome } = await import("@/services/ads-wallet/linkedin-launch");
        const outcome = await linkedinLaunchHoldOutcome(tenant_id, launch);
        if (!outcome) {
          out.kept += 1;
          continue;
        }
        await settleInflightHold(tenant_id, h, outcome, out);
      } catch (e) {
        console.error(`[ad-hold-resolve] LinkedIn launch hold ${h.id} left as is: ${(e as Error).message}`);
        out.failed += 1;
      }
      continue;
    }
    if (opts.platforms && !opts.platforms.includes(h.platform)) {
      out.kept += 1;
      continue;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(h.object_id)) {
      out.kept += 1;
      continue;
    }
    try {
      let card = await readHoldCard(tenant_id, h);
      const ref = h.provider_ref as Record<string, unknown> | null;
      if (!card && h.platform === "chatgpt" && ref?.kind === "chatgpt_workspace" && ref.campaign_id === h.object_id) {
        card = { exec_class: h.op === "raise" ? "chatgpt_ads.update_campaign_budget" : "chatgpt_ads.set_status", body: { ...ref, status: "ACTIVE" } };
      }
      if (!card && h.platform === "chatgpt" && h.op === "resume" && !h.decision_id && !h.channel_action_id) {
        card = { exec_class: "chatgpt_ads.set_status", body: { campaign_id: h.object_id, status: "ACTIVE" } };
      }
      const rows = await db
        .from("ad_campaigns")
        .select("object_id, campaign_id, level, budget_kind, budget_usd, campaign_budget_usd, status, as_of")
        .eq("tenant_id", tenant_id)
        .eq("platform", h.platform)
        .or(`object_id.eq.${h.object_id},campaign_id.eq.${h.object_id}`)
        .limit(200);
      if (rows.error) throw new Error(rows.error.message);
      let outcome = inflightOutcome(h, card, (rows.data ?? []) as LedgerRow[], now);
      if (h.platform === "tiktok" && h.op === "resume" && card?.exec_class === "tiktok_ads.set_status" && card.body.resume_plan) {
        const { resolveTiktokStatusHold } = await import("@/services/connectors/tiktok-ads/status-budget");
        outcome = await resolveTiktokStatusHold(tenant_id, h.object_id, card.body);
      }
      if (h.platform === "tiktok" && h.op === "raise" && card?.exec_class === "tiktok_ads.update_settings") {
        const { resolveSettingsHold } = await import("@/services/connectors/tiktok-ads/campaign-settings");
        outcome = await resolveSettingsHold(tenant_id, h.object_id, card.body);
      }
      if (h.platform === "chatgpt" && h.op === "resume" && card?.exec_class === "chatgpt_ads.set_status" && card.body.status === "ACTIVE" && card.body.campaign_id === h.object_id) {
        const { readCampaignTree } = await import("@/services/connectors/chatgpt-ads/workspace");
        const {withChatgptBudgetCampaign}=await import("@/services/ads-wallet/chatgpt-budget-identity");
        const tree = await withChatgptBudgetCampaign(tenant_id,h.object_id,id=>readCampaignTree(tenant_id,id));
        outcome = tree.campaign.status === "active" ? "landed" : ["paused", "archived"].includes(tree.campaign.status ?? "") ? "not_landed" : null;
      }
      if (!outcome) {
        out.kept += 1;
        continue;
      }
      await settleInflightHold(tenant_id, h, outcome, out);
    } catch (e) {
      console.error(`[ad-hold-resolve] in-flight hold ${h.id} left as is: ${(e as Error).message}`);
      out.failed += 1;
    }
  }
  return out;
}

async function readHoldCard(
  tenant_id: string,
  h: { decision_id: string | null; channel_action_id: string | null },
): Promise<{ exec_class: string; body: Record<string, unknown> } | null> {
  const db = tenantClient(asTenantId(tenant_id));
  if (h.channel_action_id) {
    const r = await db.from("channel_actions").select("exec_class, exec_payload").eq("tenant_id", tenant_id).eq("id", h.channel_action_id).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    const row = r.data as { exec_class?: string | null; exec_payload?: unknown } | null;
    return row?.exec_class && row.exec_payload && typeof row.exec_payload === "object" ? { exec_class: row.exec_class, body: row.exec_payload as Record<string, unknown> } : null;
  }
  if (h.decision_id) {
    const r = await db.from("decisions").select("decision_class, body").eq("tenant_id", tenant_id).eq("id", h.decision_id).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    const row = r.data as { decision_class?: string | null; body?: unknown } | null;
    return row?.decision_class && row.body && typeof row.body === "object" ? { exec_class: row.decision_class, body: row.body as Record<string, unknown> } : null;
  }
  return null;
}
