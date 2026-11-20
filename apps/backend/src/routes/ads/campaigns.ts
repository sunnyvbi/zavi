import type { Request, Response } from "express";
import { z } from "zod";
import { walletAuth as adsAuth, walletError } from "./wallet-auth";
import { getCampaignBinding } from "@/services/ads-wallet/bindings";
import {
  linkedinLaunchSummary,
  linkedinLaunchObservedCents,
  linkedinLaunchOwnHoldUsd,
  launchLinkedinCampaign,
} from "@/services/ads-wallet/linkedin-launch";
import { linkedinCampaign, requestLinkedinPause } from "@/services/ads-wallet/adapters/linkedin";
import { linkedinCampaignChangeStamp } from "@/services/connectors/linkedin-ads/display-stamp";
import { withLinkedInDisplayReads } from "@/services/connectors/linkedin-ads/http";
import { linkedinPauseRefusedCopy } from "@/services/connectors/linkedin-ads/pause-refused";
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { isPartialRiskExecCode } from "@zavi/shared";
import { execVerdictOf } from "@/services/channels/exec-failure";
import { linkedinPausePending } from "@/services/ads-wallet/linkedin-pause-pending";
import { linkedinBindingsInUse } from "@/services/connectors/linkedin-ads/own-accounts";

type StateRow = Record<string, unknown>;
const stamp = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

const LINKEDIN_FINAL_STATUSES = new Set(["COMPLETED", "CANCELED", "ARCHIVED", "PENDING_DELETION", "REMOVED"]);
const LINKEDIN_OFF_STATUSES = new Set(["PAUSED", "DRAFT"]);
const LINKEDIN_READS_PER_LIST = 20;
type CampaignState = "PAUSED" | "ACTIVE" | "ENDED" | "OUT_OF_BUDGET";

const budgetHold = (serving: unknown) => Array.isArray(serving) && serving.some((s) => typeof s === "string" && /BUDGET/i.test(s));

async function linkedinReadings(tenantId: string, ids: string[], running: Set<string>): Promise<Map<string, CampaignState>> {
  const out = new Map<string, CampaignState>();
  const stamp = await linkedinCampaignChangeStamp(tenantId);
  if (!stamp) return out;
  await withLinkedInDisplayReads({ refresh: false, stamp }, () =>
    Promise.all(ids.slice(0, LINKEDIN_READS_PER_LIST).map(async (id) => {
      const found = await linkedinCampaign(tenantId, id).catch(() => null);
      if (!found) return;
      const { status, servingStatuses, runSchedule } = found.campaign as { status: string; servingStatuses?: unknown; runSchedule?: { end?: number | null } };
      const scheduleOver = runSchedule?.end != null && runSchedule.end <= Date.now();
      if (LINKEDIN_FINAL_STATUSES.has(status)) out.set(id, "ENDED");
      else if (running.has(id) && LINKEDIN_OFF_STATUSES.has(status)) out.set(id, "PAUSED");
      else if (running.has(id) && status === "ACTIVE" && budgetHold(servingStatuses)) out.set(id, "OUT_OF_BUDGET");
      else if (!running.has(id) && status === "ACTIVE" && !scheduleOver) out.set(id, budgetHold(servingStatuses) ? "OUT_OF_BUDGET" : "ACTIVE");
    })),
  );
  return out;
}

async function storedCampaignStates(db: ReturnType<typeof tenantClient>, tenantId: string, ids: string[], launching: Set<string>, pausing: Set<string>) {
  const out = new Map<string, CampaignState>();
  if (!ids.length) return out;
  const stopped = new Set<string>();
  const running = new Set<string>();
  const [life, ops] = await Promise.all([
    db
      .from("ads_campaign_lifecycle")
      .select("campaign_binding_id,created_paused,activation_attempted_at,stop_requested_at,stop_confirmed_at")
      .eq("tenant_id", tenantId)
      .in("campaign_binding_id", ids),
    db
      .from("ads_campaign_operations")
      .select("campaign_binding_id,kind,status,updated_at,end_time:payload->>end_time")
      .eq("tenant_id", tenantId)
      .in("kind", ["activate", "finalize"])
      .in("campaign_binding_id", ids),
  ]);
  if (life?.error || ops?.error || !Array.isArray(life?.data) || !Array.isArray(ops?.data)) return out;
  const byOps = new Map<string, StateRow[]>();
  const gone = new Set<string>();
  for (const o of ops.data as StateRow[]) {
    const k = String(o.campaign_binding_id);
    if (o.kind === "finalize") {
      if (o.status === "succeeded") gone.add(k);
      continue;
    }
    byOps.set(k, [...(byOps.get(k) ?? []), o]);
    if (o.status !== "succeeded" && o.status !== "refused" && ids.includes(k)) launching.add(k);
  }
  for (const l of life.data as StateRow[]) {
    const id = String(l.campaign_binding_id);
    if (!ids.includes(id)) continue;
    const mine = byOps.get(id) ?? [];
    if (mine.some((o) => o.status !== "succeeded" && o.status !== "refused")) continue;
    if (gone.has(id)) {
      out.set(id, "ENDED");
      continue;
    }
    const succeeded = mine.filter((o) => o.status === "succeeded");
    const done = succeeded.map((o) => stamp(o.updated_at));
    if (done.some((t) => t === null)) continue;
    const lastActivate = done.length ? Math.max(...(done as number[])) : null;
    const endTime = Number(succeeded[done.indexOf(lastActivate)]?.end_time ?? NaN);
    const requested = stamp(l.stop_requested_at);
    if (l.stop_requested_at != null) {
      const confirmed = stamp(l.stop_confirmed_at);
      if (linkedinPausePending(l.stop_requested_at, l.stop_confirmed_at, lastActivate)) pausing.add(id);
      if (requested === null || confirmed === null || confirmed < requested) continue;
      if (lastActivate !== null && lastActivate > requested) continue;
      const past = Number.isFinite(endTime) && endTime <= requested;
      out.set(id, past ? "ENDED" : "PAUSED");
      if (!past) stopped.add(id);
      continue;
    }
    if (lastActivate !== null) {
      const over = Number.isFinite(endTime) && endTime <= Date.now();
      out.set(id, over ? "ENDED" : "ACTIVE");
      if (!over) running.add(id);
    } else if (l.created_paused === true && l.activation_attempted_at == null) out.set(id, "PAUSED");
  }
  const toRead = ids.filter((id) => stopped.has(id) || running.has(id));
  if (toRead.length) for (const [id, state] of await linkedinReadings(tenantId, toRead, running)) out.set(id, state);
  return out;
}

async function newestFirst<T extends { id: string }>(db: ReturnType<typeof tenantClient>, platform: string, rows: T[]): Promise<Array<T & { created_at?: string }>> {
  if (platform !== "linkedin" || !rows.length) return rows;
  const made = await db.from("ads_campaign_bindings").select("id,created_at").in("id", rows.map((r) => r.id));
  if (made?.error || !Array.isArray(made?.data)) return rows;
  const at = new Map((made.data as Array<{ id: string; created_at: unknown }>).map((r) => [r.id, stamp(r.created_at) ?? 0]));
  const raw = new Map((made.data as Array<{ id: string; created_at: unknown }>).map((r) => [r.id, r.created_at]));
  return [...rows].sort((a, b) => (at.get(b.id) ?? 0) - (at.get(a.id) ?? 0)).map((r) => {
    const created = raw.get(r.id);
    return typeof created === "string" ? { ...r, created_at: created } : r;
  });
}

export async function adsBoundCampaigns(req: Request, res: Response) {
  const auth = await adsAuth(req, res, false, true);
  if (!auth) return;
  try {
    const platform = z
      .enum(["linkedin", "reddit", "chatgpt"])
      .parse(req.query.platform);
    const db = tenantClient(asTenantId(auth.tenant_id));
    const { data, error } = await db
      .from("ads_campaign_binding_details")
      .select(
        "id,platform,provider_campaign_id,account_binding_id,funding_source",
      )
      .eq("platform", platform)
      .order("id")
      .range(0, 499);
    if (error || !Array.isArray(data) || data.length === 500)
      throw new Error("Campaign inventory is incomplete");
    const inUse = platform === "linkedin" ? (await linkedinBindingsInUse(auth.tenant_id)).bindingIds : null;
    const earlierOwn = new Set<string>();
    if (inUse) {
      const own = await db
        .from("ads_account_binding_details")
        .select("id,tenant_id,funding_source,credential_tenant_id")
        .eq("platform", "linkedin")
        .eq("funding_source", "provider")
        .range(0, 999);
      if (own.error || !Array.isArray(own.data) || own.data.length === 1000) throw new Error("Campaign inventory is incomplete");
      for (const b of own.data as Array<{ id: unknown; tenant_id: unknown; funding_source: unknown; credential_tenant_id?: unknown }>)
        if (typeof b.id === "string" && b.tenant_id === auth.tenant_id && b.funding_source === "provider" && (!b.credential_tenant_id || b.credential_tenant_id === auth.tenant_id) && !inUse.has(b.id)) earlierOwn.add(b.id);
    }
    const pauseOnly = (c: { account_binding_id?: unknown; funding_source?: unknown }) => earlierOwn.has(String(c.account_binding_id)) && c.funding_source === "provider";
    const listed = (data as Array<{ id: string; provider_campaign_id: string; account_binding_id?: unknown } & Record<string, unknown>>).filter((c) => !inUse || inUse.has(String(c.account_binding_id)) || pauseOnly(c));
    const rows = await newestFirst(db, platform, listed);
    const names = new Map<string, string>();
    const archived = new Set<string>();
    const settingUp = new Map<string, "retry" | "check" | "closed">();
    const zaviIds = new Set<string>();
    const canRetry = new Set<string>();
    const openCard = new Set<string>();
    const closedCard = new Set<string>();
    if (platform === "linkedin" && rows.length) {
      const made = await db
        .from("channel_actions")
        .select(
          "campaign_id:exec_progress->>campaign_id,name:exec_payload->campaign->>name,archived:exec_progress->>archived,exec_status,exec_result,status",
        )
        .eq("channel_slug", "linkedin_ads")
        .eq("exec_class", "linkedin_ads.create_campaign_bundle")
        .in(
          "exec_progress->>campaign_id",
          rows.map((c) => c.provider_campaign_id),
        );
      for (const r of (made.error ? [] : (made.data ?? [])) as Array<{
        campaign_id: unknown;
        name: unknown;
        archived?: unknown;
        exec_status?: unknown;
        exec_result?: unknown;
        status?: unknown;
      }>) {
        if (typeof r.campaign_id === "string") zaviIds.add(r.campaign_id);
        const bucket = execVerdictOf(r.exec_status, r.exec_result)?.bucket;
        const code = r.exec_result && typeof r.exec_result === "object" ? (r.exec_result as { code?: unknown }).code : null;
        if (typeof r.campaign_id === "string" && r.status === "pending") openCard.add(r.campaign_id);
        if (typeof r.campaign_id === "string" && typeof r.status === "string" && r.status !== "pending" && r.exec_status !== "queued" && r.exec_status !== "dispatching") closedCard.add(r.campaign_id);
        if (typeof r.campaign_id === "string" && r.status === "pending" && r.exec_status === "failed" && !isPartialRiskExecCode(code) && bucket !== "partial_risk" && bucket !== "blocked_on_us")
          canRetry.add(r.campaign_id);
        if (typeof r.campaign_id === "string" && r.archived === "true") archived.add(r.campaign_id);
        if (typeof r.campaign_id === "string" && typeof r.name === "string" && r.name.trim())
          names.set(r.campaign_id, r.name.trim());
      }
      const zaviMade = rows.filter((c) => zaviIds.has(c.provider_campaign_id));
      if (zaviMade.length) {
        const life = await db
          .from("ads_campaign_lifecycle")
          .select("campaign_binding_id,provider_creative_ids")
          .in("campaign_binding_id", zaviMade.map((c) => c.id));
        if (!life.error) {
          const ready = new Set(((life.data ?? []) as Array<{ campaign_binding_id: unknown; provider_creative_ids: unknown }>).filter((r) => Array.isArray(r.provider_creative_ids) && r.provider_creative_ids.length).map((r) => r.campaign_binding_id));
          for (const c of zaviMade) if (!ready.has(c.id)) settingUp.set(c.provider_campaign_id, canRetry.has(c.provider_campaign_id) ? "retry" : closedCard.has(c.provider_campaign_id) && !openCard.has(c.provider_campaign_id) ? "closed" : "check");
        }
      }
    }
    const accountOf = new Map<string, string>();
    const accountBindingIds = [...new Set(rows.map((c) => c.account_binding_id).filter((v): v is string => typeof v === "string"))];
    if (platform === "linkedin" && accountBindingIds.length) {
      const accounts = await db
        .from("ads_account_binding_details")
        .select("id,tenant_id,provider_account_id")
        .in("id", accountBindingIds);
      for (const a of (accounts?.error || !Array.isArray(accounts?.data) ? [] : accounts.data) as Array<{ id: unknown; tenant_id: unknown; provider_account_id: unknown }>)
        if (a.tenant_id === auth.tenant_id && typeof a.id === "string" && typeof a.provider_account_id === "string" && a.provider_account_id)
          accountOf.set(a.id, a.provider_account_id);
    }
    const launching = new Set<string>();
    const pausing = new Set<string>();
    const states = platform === "linkedin" ? await storedCampaignStates(db, auth.tenant_id, rows.filter((c) => !archived.has(c.provider_campaign_id)).map((c) => (c as unknown as { id: string }).id), launching, pausing) : new Map<string, CampaignState>();
    res.json({
      campaigns: rows.filter((c) => !archived.has(c.provider_campaign_id) && !(pauseOnly(c) && states.get((c as unknown as { id: string }).id) === "ENDED")).map((c) => ({
        ...c,
        ...(pauseOnly(c) ? { pause_only: true } : {}),
        name: names.get(c.provider_campaign_id) ?? null,
        ...(accountOf.has(c.account_binding_id as string) ? { provider_account_id: accountOf.get(c.account_binding_id as string) } : {}),
        ...(states.has((c as unknown as { id: string }).id) ? { status: states.get((c as unknown as { id: string }).id) } : {}),
        ...(settingUp.has(c.provider_campaign_id) ? { setting_up: settingUp.get(c.provider_campaign_id) } : {}),
        ...(launching.has((c as unknown as { id: string }).id) ? { launch_pending: true } : {}),
        ...(pausing.has((c as unknown as { id: string }).id) ? { pause_pending: true } : {}),
      })),
    });
  } catch (e) {
    walletError(res, e);
  }
}
export async function adsCampaignLaunchSummary(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true, true);
  if (!auth) return;
  try {
    const id = z.string().uuid().parse(req.params.bindingId);
    const binding = await getCampaignBinding(auth.tenant_id, id);
    if (binding.platform !== "linkedin") {
      res.status(409).json({
        error: { message: "Use this platform's campaign review to launch." },
      });
      return;
    }
    const [summary, observed, ownHold] = await Promise.all([
      linkedinLaunchSummary(auth.tenant_id, id),
      linkedinLaunchObservedCents(auth.tenant_id, id, binding.funding_source),
      linkedinLaunchOwnHoldUsd(auth.tenant_id, id),
    ]);
    res.json({ ...summary, observed_spend_cents: observed, own_hold_usd: ownHold });
  } catch (e) {
    walletError(res, e);
  }
}
export async function adsCampaignLaunch(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true, true);
  if (!auth) return;
  try {
    const { reviewed_units_per_usd, ...body } = z
      .object({ reviewed_units_per_usd: z.number().positive().finite().nullable().default(null) })
      .passthrough()
      .parse(req.body ?? {});
    const id = z.string().uuid().parse(req.params.bindingId);
    const binding = await getCampaignBinding(auth.tenant_id, id);
    if (binding.platform === "linkedin" && binding.funding_source === "provider" && !(await linkedinBindingsInUse(auth.tenant_id)).bindingIds.has(binding.account_binding_id)) {
      res.status(409).json({ error: { code: "ads_account_not_in_use", message: "This campaign is on an ad account this workspace no longer uses for new campaigns, so Zavi cannot launch it. You can still pause it." } });
      return;
    }
    res.json(
      await launchLinkedinCampaign(
        auth.tenant_id,
        id,
        body,
        undefined,
        { approved_by: auth.user_id, reviewed_units_per_usd },
      ),
    );
  } catch (e) {
    walletError(res, e);
  }
}
export async function adsCampaignPause(req: Request, res: Response) {
  const auth = await adsAuth(req, res, true, true);
  if (!auth) return;
  try {
    const id = z.string().uuid().parse(req.params.bindingId);
    res.json({ status: await requestLinkedinPause(auth.tenant_id, id) });
  } catch (e) {
    const refused = linkedinPauseRefusedCopy(e, "this campaign");
    walletError(res, refused ? new ExpectedToolError((e as ExpectedToolError).code, refused) : e);
  }
}
