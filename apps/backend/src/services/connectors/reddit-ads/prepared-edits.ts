import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import type { RedditAccount } from "./adapter";
import { prepareSchema, type CampaignPlan, type targetingSchema } from "./schema";
import type { z } from "zod";

export type PreparedEdit =
  | { kind: "budget"; ad_group_id: string; daily_budget_usd: number }
  | { kind: "targeting"; ad_group_id: string; targeting: z.infer<typeof targetingSchema> }
  | { kind: "destination"; ad_id: string; destination_url: string }
  | { kind: "refresh"; level: "campaign" | "ad_group" | "ad"; object_id: string };

type OpRow = { operation_key: string; step: string; result: unknown };
type Next = (plan: CampaignPlan, adIds: string[]) => CampaignPlan;

export type PreparedEditDeps = {
  rows: (tenantId: string) => Promise<OpRow[]>;
  load: (tenantId: string, key: string) => Promise<{ plan: CampaignPlan; adIds: string[] } | null>;
  adopt: (tenantId: string, account: RedditAccount, key: string, next: Next) => Promise<void>;
};

const ROW_PAGE = 1000;
const NO_ACTION = "00000000-0000-0000-0000-000000000000";

const defaultDeps: PreparedEditDeps = {
  async rows(tenantId) {
    const out: OpRow[] = [];
    for (let from = 0; ; from += ROW_PAGE) {
      const { data, error } = await tenantClient(asTenantId(tenantId))
        .from("reddit_ad_operations")
        .select("operation_key,step,result")
        .eq("state", "complete")
        .or("step.eq.manifest,step.like.enable_%")
        .order("operation_key", { ascending: true })
        .order("step", { ascending: true })
        .range(from, from + ROW_PAGE - 1);
      if (error) throw new Error(error.message);
      out.push(...((data ?? []) as OpRow[]));
      if ((data ?? []).length < ROW_PAGE) return out;
    }
  },
  async load(tenantId, key) {
    const { preparedCampaign } = await import("./lifecycle");
    try {
      const { plan, manifest } = await preparedCampaign(tenantId, key, NO_ACTION);
      return { plan, adIds: manifest.ads.map((a) => a.id) };
    } catch (e) {
      if (e instanceof ExpectedToolError && e.code === "reddit_ads_invalid_request") return null;
      throw e;
    }
  },
  async adopt(tenantId, account, key, next) {
    const { preparedCampaign, verifyManifest } = await import("./lifecycle");
    const { plan, manifest, store } = await preparedCampaign(tenantId, key, NO_ACTION);
    const updated = validPlan(next(plan, manifest.ads.map((a) => a.id)));
    const verified = await verifyManifest(account, updated, manifest, "PAUSED");
    await store.save("manifest", "complete", { ...verified, plan: updated });
    await store.save("plan", "complete", updated);
  },
};

const idOf = (v: unknown): string | null => (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

function validPlan(plan: CampaignPlan): CampaignPlan {
  const parsed = prepareSchema.safeParse(plan);
  if (parsed.success) return parsed.data;
  throw new ExpectedToolError("reddit_ads_invalid_request", `This change would leave the prepared campaign outside what Zavi can launch (${parsed.error.issues.map((i) => i.message).join("; ")}). Nothing was changed in Reddit.`);
}

export function preparedEditFor(cls: string, body: Record<string, unknown>): PreparedEdit | null {
  if (cls === "reddit_ads.update_budget") return { kind: "budget", ad_group_id: String(body.ad_group_id), daily_budget_usd: Number(body.daily_budget_usd) };
  if (cls === "reddit_ads.update_targeting") return { kind: "targeting", ad_group_id: String(body.ad_group_id), targeting: body.targeting as z.infer<typeof targetingSchema> };
  if (cls === "reddit_ads.update_ad") return { kind: "destination", ad_id: String(body.ad_id), destination_url: String(body.destination_url) };
  if (cls === "reddit_ads.rename_object") return { kind: "refresh", level: body.level as "campaign" | "ad_group" | "ad", object_id: String(body.object_id) };
  return null;
}

export function preparedKeyFor(rows: OpRow[], edit: PreparedEdit): string | null {
  const enabled = new Set(rows.filter((r) => r.step.startsWith("enable_")).map((r) => r.operation_key));
  for (const r of rows) {
    if (r.step !== "manifest" || enabled.has(r.operation_key) || !r.result || typeof r.result !== "object") continue;
    const m = r.result as { id?: unknown; campaign?: unknown; group?: unknown; ads?: unknown };
    const hasAd = (id: string) => Array.isArray(m.ads) && m.ads.some((a) => idOf(a) === id);
    const hit = edit.kind === "destination"
      ? hasAd(edit.ad_id)
      : edit.kind === "refresh"
        ? edit.level === "ad" ? hasAd(edit.object_id) : edit.level === "ad_group" ? idOf(m.group) === edit.object_id : m.id === edit.object_id || idOf(m.campaign) === edit.object_id
        : idOf(m.group) === edit.ad_group_id;
    if (hit) return r.operation_key;
  }
  return null;
}

export function applyPreparedEdit(plan: CampaignPlan, adIds: string[], edit: PreparedEdit): CampaignPlan {
  if (edit.kind === "budget") return { ...plan, daily_budget_usd: edit.daily_budget_usd };
  if (edit.kind === "targeting") return { ...plan, targeting: edit.targeting };
  if (edit.kind === "refresh") return plan;
  const index = adIds.indexOf(edit.ad_id);
  if (index < 0) return plan;
  return {
    ...plan,
    creatives: plan.creatives.map((c, i) => {
      if (i !== index) return c;
      const rest = { ...c };
      delete rest.click_url;
      return edit.destination_url === c.destination_url ? rest : { ...rest, click_url: edit.destination_url };
    }),
  };
}

export async function checkPreparedEdit(tenantId: string, edit: PreparedEdit, deps: PreparedEditDeps = defaultDeps): Promise<string | null> {
  const key = preparedKeyFor(await deps.rows(tenantId), edit);
  if (!key) return null;
  const loaded = await deps.load(tenantId, key);
  if (!loaded) return null;
  validPlan(applyPreparedEdit(loaded.plan, loaded.adIds, edit));
  return key;
}

export async function adoptPreparedEdit(tenantId: string, account: RedditAccount, edit: PreparedEdit, deps: PreparedEditDeps = defaultDeps): Promise<string | null> {
  const key = preparedKeyFor(await deps.rows(tenantId), edit);
  if (!key) return null;
  await deps.adopt(tenantId, account, key, (plan, adIds) => applyPreparedEdit(plan, adIds, edit));
  return key;
}

export const readPreparedRows = (tenantId: string): Promise<OpRow[]> => defaultDeps.rows(tenantId);
