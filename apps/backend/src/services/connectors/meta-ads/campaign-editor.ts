
import { z } from "zod";
import { tenantClient, tenantRpc, type TenantId } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { fbGet, getAdAccountCurrency, metaAdsCreds } from "@/services/tools/meta-ads/_client";
import { isMetaAdsWriteEnabled } from "@/services/tools/meta-ads/write/_flag-check";
import { liveSpendCap } from "@/services/tools/meta-ads/write/campaign_writes";
import { targetingFingerprint } from "@/services/tools/meta-ads/write/adset_ad_writes";
import {
  MAX_META_GEO_PLACES,
  metaGeoFingerprint,
  metaPlacesOf,
  shapeGeoLocations,
  unsupportedGeoKeys,
  verifyMetaPlaces,
  type GeoLocations,
} from "@/services/tools/meta-ads/write/replace_ad_set_geo";
import {
  createAdBodySchema,
  createAdSetBodySchema,
  launchCampaignBodySchema,
  launchCtaSchema,
  normalizeMetaTime,
  updateAdSetBodySchema,
  updateCampaignBodySchema,
} from "@/services/tools/meta-ads/write/_decision-bodies";
import { minorToMajor, isWritableCurrency, formatMoney } from "@/services/tools/meta-ads/write/_currency";
import { resolveMetaAdCapability } from "@/services/tools/meta-ads/write/_library-ad-capability";
import { resolveCreateAdSetBid } from "@/services/tools/meta-ads/write/_ad-set-bid";
import { readTenantCapAndToday } from "@/services/tools/meta-ads/write/cap-reader";
import { parseMetaPlaceId } from "@/services/ad-locations/places";
import { applyPlannedChanges, type PlannedEditorChange } from "@/services/connectors/_editor-save";

const ORIGIN = "user_initiated_ledger" as const;
const MAX_DAILY_BUDGET = 10_000;

export const META_PLACEMENTS = ["facebook", "instagram", "messenger", "audience_network", "threads"] as const;
export type MetaPlacement = (typeof META_PLACEMENTS)[number];

export type EditorAdSet = {
  id: string;
  name: string;
  status: string | null;
  daily_budget: number | null;
  end_time: string | null;
  places: Array<{ id: string; name: string }>;
  places_editable: boolean;
  placements: MetaPlacement[] | null;
};

export type EditorAd = {
  id: string;
  name: string;
  status: string | null;
  ad_set_id: string | null;
  headline: string | null;
  primary_text: string | null;
  link_url: string | null;
  image_url: string | null;
};

export type MetaCampaignEditorView = {
  campaign: {
    id: string;
    name: string;
    status: string | null;
    objective: string | null;
    budget_level: "campaign" | "ad_set" | "lifetime" | "mixed" | "none";
    daily_budget: number | null;
    spend_cap: number | null;
  };
  ad_sets: EditorAdSet[];
  ads: EditorAd[];
  currency: string;
  writes_enabled: boolean;
};

type GraphCampaign = {
  id?: string;
  account_id?: string;
  name?: string;
  status?: string;
  objective?: string;
  daily_budget?: string | null;
  lifetime_budget?: string | null;
  spend_cap?: string | null;
};
type GraphAdSet = {
  id?: string;
  name?: string;
  status?: string;
  daily_budget?: string | null;
  lifetime_budget?: string | null;
  end_time?: string | null;
  targeting?: Record<string, unknown> & { geo_locations?: GeoLocations; publisher_platforms?: string[] };
};
type GraphAd = {
  id?: string;
  name?: string;
  status?: string;
  adset_id?: string;
  creative?: {
    title?: string;
    body?: string;
    image_url?: string;
    thumbnail_url?: string;
    object_story_spec?: { link_data?: { link?: string; message?: string; name?: string; picture?: string } };
  };
};

const sameAccount = (a: unknown, ours: string) =>
  typeof a === "string" && a.replace(/^act_/, "") === ours.replace(/^act_/, "");

const DELETED = new Set(["DELETED", "ARCHIVED"]);

async function readOwnCampaignFull(tenant_id: string, campaign_id: string): Promise<GraphCampaign> {
  if (!/^\d+$/.test(campaign_id)) throw new ExpectedToolError("meta_ads_invalid_target", "That is not a Meta campaign id.");
  const [creds, c] = await Promise.all([
    metaAdsCreds(tenant_id),
    fbGet(tenant_id, campaign_id, {
      fields: "id,account_id,name,status,objective,daily_budget,lifetime_budget,spend_cap",
    }) as Promise<GraphCampaign>,
  ]);
  if (!c?.id || !sameAccount(c.account_id, creds.ad_account_id)) {
    throw new ExpectedToolError("meta_ads_invalid_target", "This campaign is not in your connected Meta ad account.");
  }
  return c;
}

async function readAdSets(tenant_id: string, campaign_id: string): Promise<GraphAdSet[]> {
  const r = (await fbGet(tenant_id, `${campaign_id}/adsets`, {
    fields: "id,name,status,daily_budget,lifetime_budget,end_time,targeting",
    limit: 50,
  })) as { data?: GraphAdSet[] };
  return (r.data ?? []).filter((a) => a.id && !DELETED.has(String(a.status ?? "")));
}

export function budgetLevel(c: GraphCampaign, sets: GraphAdSet[]): MetaCampaignEditorView["campaign"]["budget_level"] {
  if (Number(c.lifetime_budget ?? 0) > 0) return "lifetime";
  if (Number(c.daily_budget ?? 0) > 0) return "campaign";
  if (sets.some((s) => Number(s.lifetime_budget ?? 0) > 0)) return "lifetime";
  const budgeted = sets.filter((s) => Number(s.daily_budget ?? 0) > 0);
  if (budgeted.length === 1) return "ad_set";
  return budgeted.length === 0 ? "none" : "mixed";
}

function placeIds(geo: GeoLocations | undefined): Array<{ id: string; name: string }> {
  return metaPlacesOf(geo).map((p) => ({ id: `${p.type}:${p.key}`, name: p.name ?? p.key }));
}

function placementsOf(t: GraphAdSet["targeting"]): MetaPlacement[] | null {
  const p = t?.publisher_platforms;
  if (!Array.isArray(p) || p.length === 0) return null;
  return p.filter((x): x is MetaPlacement => (META_PLACEMENTS as readonly string[]).includes(x));
}

export async function readMetaCampaignEditor(tenant_id: string, campaign_id: string): Promise<MetaCampaignEditorView> {
  const [c, sets, currency, writes_enabled] = await Promise.all([
    readOwnCampaignFull(tenant_id, campaign_id),
    readAdSets(tenant_id, campaign_id),
    getAdAccountCurrency(tenant_id),
    isMetaAdsWriteEnabled(),
  ]);
  const adsRes = (await fbGet(tenant_id, `${campaign_id}/ads`, {
    fields: "id,name,status,adset_id,creative{title,body,image_url,thumbnail_url,object_story_spec}",
    limit: 50,
  })) as { data?: GraphAd[] };
  const level = budgetLevel(c, sets);
  const money = (v: string | null | undefined) => (v == null || Number(v) <= 0 ? null : minorToMajor(v, currency));
  return {
    campaign: {
      id: c.id!,
      name: c.name ?? c.id!,
      status: c.status ?? null,
      objective: c.objective ?? null,
      budget_level: level,
      daily_budget:
        level === "campaign" ? money(c.daily_budget) : level === "ad_set" ? money(sets.find((s) => Number(s.daily_budget ?? 0) > 0)!.daily_budget) : null,
      spend_cap: liveSpendCap(c, currency),
    },
    ad_sets: sets.map((s) => ({
      id: s.id!,
      name: s.name ?? s.id!,
      status: s.status ?? null,
      daily_budget: money(s.daily_budget),
      end_time: s.end_time ? normalizeMetaTime(s.end_time) : null,
      places: placeIds(s.targeting?.geo_locations),
      places_editable: unsupportedGeoKeys(s.targeting?.geo_locations).length === 0,
      placements: placementsOf(s.targeting),
    })),
    ads: (adsRes.data ?? [])
      .filter((a) => a.id && !DELETED.has(String(a.status ?? "")))
      .map((a) => {
        const link = a.creative?.object_story_spec?.link_data;
        return {
          id: a.id!,
          name: a.name ?? a.id!,
          status: a.status ?? null,
          ad_set_id: a.adset_id ?? null,
          headline: a.creative?.title ?? link?.name ?? null,
          primary_text: a.creative?.body ?? link?.message ?? null,
          link_url: link?.link ?? null,
          image_url: a.creative?.image_url ?? link?.picture ?? a.creative?.thumbnail_url ?? null,
        };
      }),
    currency,
    writes_enabled,
  };
}

export type StagedChange = {
  label: string;
  decision_id: string;
  approved: boolean;
  code: string | null;
};

async function stageAndApprove(
  tenant_id: TenantId,
  user_id: string,
  decision_class: string,
  body: Record<string, unknown>,
  label: string,
): Promise<StagedChange> {
  const { data, error } = await tenantRpc(tenant_id, "emit_decision", {
    p_agent_run_id: null,
    p_decision_class: decision_class,
    p_body: body as object,
  });
  if (error || typeof data !== "string") throw new Error(`could not stage the change: ${error?.message ?? "no decision id"}`);
  const staged = await readStaged(tenant_id, data, decision_class, body);
  if (staged === "forbidden") {
    throw new ExpectedToolError("meta_editor_forbidden", `Zavi is not allowed to make this kind of change in this workspace ("${label}"). Nothing was sent.`);
  }
  if (staged === "unreadable") {
    throw new ExpectedToolError(
      "meta_editor_stage_unknown",
      `Zavi saved "${label}" but could not confirm it. Check Approvals before saving it again.`,
      { decision_id: data, label },
    );
  }
  if (staged !== "ours") {
    throw new ExpectedToolError(
      "meta_editor_change_open",
      `Another change like "${label}" is already waiting in Approvals, so this one was not saved. Approve or reject that one first.`,
    );
  }
  const { decideOnDecision } = await import("@/services/approvals/decide-service");
  let decided: Awaited<ReturnType<typeof decideOnDecision>>;
  try {
    decided = await decideOnDecision({ decision_id: data, tenant_id, action: "approve", actor: { user_id }, surface: "web" });
  } catch (e) {
    console.warn(`[campaign-editor] approve of ${data} threw: ${(e as Error)?.message ?? String(e)}`);
    let st: string | undefined;
    try {
      const { data: now } = await tenantClient(tenant_id).from("decisions").select("status").eq("id", data).maybeSingle();
      st = (now as { status?: string } | null)?.status;
    } catch {
      st = undefined;
    }
    let unsent = false;
    if (st === "approved") {
      try {
        const { inngest } = await import("@/../workers/client");
        await inngest.send({ id: `approve:${data}`, name: "decision.approved", data: { decision_id: data, tenant_id, decision_class } });
      } catch (err) {
        console.error(`[campaign-editor] decision.approved resend for ${data} failed: ${(err as Error)?.message ?? String(err)}`);
        unsent = true;
      }
    }
    if (unsent) return { label, decision_id: data, approved: false, code: "dispatch_unsent" };
    const went = st === "approved" || st === "dispatching" || st === "acted";
    return { label, decision_id: data, approved: went, code: went ? null : "approve_failed" };
  }
  if (decided.code === "ok") return { label, decision_id: data, approved: true, code: null };
  const approved = decided.status === "approved" || decided.status === "acted";
  return { label, decision_id: data, approved, code: approved ? null : decided.code };
}

async function readStaged(tenant_id: TenantId, id: string, decision_class: string, body: Record<string, unknown>): Promise<"ours" | "forbidden" | "other" | "unreadable"> {
  const { data, error } = await tenantClient(tenant_id)
    .from("decisions")
    .select("decision_class, status, body")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return "unreadable";
  const row = data as { decision_class: string; status: string; body: Record<string, unknown> | null };
  if (row.decision_class !== decision_class) return "other";
  if (JSON.stringify(canon(row.body ?? {})) !== JSON.stringify(canon(body))) return "other";
  if (row.status === "rejected") return "forbidden";
  return row.status === "proposed" ? "ours" : "other";
}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canon(x)]),
    );
  }
  return v;
}

async function assertWritable(tenant_id: string): Promise<string> {
  if (!(await isMetaAdsWriteEnabled())) {
    throw new ExpectedToolError("meta_ads_write_disabled", "Zavi can't change Meta campaigns right now. Nothing was saved.");
  }
  const currency = await getAdAccountCurrency(tenant_id);
  if (!isWritableCurrency(currency)) {
    throw new ExpectedToolError("meta_ads_unsupported_currency", `Zavi changes Meta campaigns in USD and INR ad accounts only; this one is ${currency}.`);
  }
  return currency;
}

const placeIdSchema = z.string().regex(/^(country|region|city):[A-Za-z0-9]{1,32}$/);
const endTimeSchema = z.string().datetime({ offset: true });

export const metaCampaignEditSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    spend_cap: z.number().positive().max(10_000_000).nullable().optional(),
    ad_set: z
      .object({
        id: z.string().regex(/^\d+$/),
        end_time: endTimeSchema.optional(),
        places: z.array(placeIdSchema).min(1).max(MAX_META_GEO_PLACES).optional(),
        placements: z.array(z.enum(META_PLACEMENTS)).min(1).max(5).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type MetaCampaignEdit = z.infer<typeof metaCampaignEditSchema>;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export async function saveMetaCampaignEdits(
  tenant_id: TenantId,
  user_id: string,
  campaign_id: string,
  input: MetaCampaignEdit,
): Promise<StagedChange[]> {
  const currency = await assertWritable(tenant_id);
  const c = await readOwnCampaignFull(tenant_id, campaign_id);
  const label = (c.name ?? campaign_id).split("\n")[0]!;
  const planned: PlannedEditorChange[] = [];

  const campaignPatch: Record<string, unknown> = {};
  if (input.name !== undefined && input.name !== c.name) campaignPatch.new_name = input.name;
  if (input.spend_cap !== undefined) {
    const now = liveSpendCap(c, currency);
    if (Math.round((now ?? 0) * 100) !== Math.round((input.spend_cap ?? 0) * 100)) {
      campaignPatch.spend_cap_usd = input.spend_cap;
      campaignPatch.expected_current_spend_cap_usd = now;
    }
  }
  if (Object.keys(campaignPatch).length > 0) {
    const body = updateCampaignBodySchema.parse({
      campaign_id,
      ...campaignPatch,
      currency,
      name: label,
      about: "Changed by you in Zavi's campaign editor.",
      rationale: "The founder saved this in the campaign editor.",
      origin: ORIGIN,
    });
    const what = [
      campaignPatch.new_name !== undefined ? `rename to "${campaignPatch.new_name}"` : null,
      campaignPatch.spend_cap_usd !== undefined
        ? campaignPatch.spend_cap_usd === null
          ? "remove the spend cap"
          : `spend cap ${formatMoney(campaignPatch.spend_cap_usd as number, currency)}`
        : null,
    ].filter(Boolean);
    planned.push({ decision_class: "meta_ads.update_campaign", body: body as Record<string, unknown>, label: `${label}: ${what.join(", ")}` });
  }

  const s = input.ad_set;
  if (s) {
    const sets = await readAdSets(tenant_id, campaign_id);
    const live = sets.find((x) => x.id === s.id);
    if (!live) throw new ExpectedToolError("meta_ads_invalid_target", "That ad set is not in this campaign any more. Reopen the campaign.");
    const setName = live.name ?? s.id;
    const targeting = (live.targeting ?? {}) as Record<string, unknown> & { geo_locations?: GeoLocations; publisher_platforms?: string[] };

    const setPatch: Record<string, unknown> = {};
    if (s.end_time !== undefined) {
      const now = live.end_time ? normalizeMetaTime(live.end_time) : null;
      if (!now || Date.parse(now) !== Date.parse(s.end_time)) {
        if (Date.parse(s.end_time) <= Date.now()) throw new ExpectedToolError("meta_editor_bad_end", "The end date has already passed.");
        setPatch.end_time = s.end_time;
        setPatch.expected_current_end_time = now;
      }
    }
    if (s.placements !== undefined && !sameSet(s.placements, placementsOf(targeting) ?? [])) {
      setPatch.targeting_patch = { publisher_platforms: s.placements };
      setPatch.expected_targeting_fingerprint = targetingFingerprint(targeting);
    }
    if (Object.keys(setPatch).length > 0) {
      const body = updateAdSetBodySchema.parse({
        ad_set_id: s.id,
        ...setPatch,
        name: setName,
        about: "Changed by you in Zavi's campaign editor.",
        rationale: "The founder saved this in the campaign editor.",
        origin: ORIGIN,
      });
      const what = [setPatch.end_time ? "end date" : null, setPatch.targeting_patch ? "placements" : null].filter(Boolean).join(" and ");
      planned.push({ decision_class: "meta_ads.update_ad_set", body: body as Record<string, unknown>, label: `${setName}: ${what}` });
    }

    if (s.places !== undefined) {
      const liveIds = placeIds(targeting.geo_locations).map((p) => p.id);
      if (!sameSet(s.places, liveIds)) {
        if (unsupportedGeoKeys(targeting.geo_locations).length > 0) {
          throw new ExpectedToolError("ad_locations_unsupported", "This ad set targets places in a way Zavi can't edit (a radius or postcodes). Change its places in Meta.");
        }
        const places = await verifyMetaPlaces(tenant_id, s.places.map((id) => parseMetaPlaceId(id)!));
        const body = {
          ad_set_id: s.id,
          places,
          before_names: metaPlacesOf(targeting.geo_locations).map((p) => p.name ?? p.key),
          expected_fingerprint: metaGeoFingerprint(targeting.geo_locations),
          name: setName,
          about: "Where this ad set shows, changed by you in Zavi's campaign editor.",
          rationale: "The founder saved this in the campaign editor.",
          over_cap: true as const,
          origin: ORIGIN,
        };
        planned.push({ decision_class: "meta_ads.replace_ad_set_geo_review", body, label: `${setName}: where it shows` });
      }
    }
  }
  return applyPlannedChanges(planned, (p) => stageAndApprove(tenant_id, user_id, p.decision_class, p.body, p.label));
}

export const META_EDITOR_GOALS = {
  traffic: { objective: "OUTCOME_TRAFFIC", optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS" },
  awareness: { objective: "OUTCOME_AWARENESS", optimization_goal: "REACH", billing_event: "IMPRESSIONS" },
  conversions: { objective: "OUTCOME_SALES", optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS" },
} as const;
export type MetaEditorGoal = keyof typeof META_EDITOR_GOALS;

export const META_CONVERSION_EVENTS = ["PURCHASE", "LEAD", "COMPLETE_REGISTRATION", "ADD_TO_CART", "INITIATED_CHECKOUT"] as const;

export const metaCampaignCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    goal: z.enum(["traffic", "awareness", "conversions"]),
    conversion_event: z.enum(META_CONVERSION_EVENTS).optional(),
    daily_budget: z.number().positive(),
    end_time: endTimeSchema.optional(),
    places: z.array(placeIdSchema).min(1).max(MAX_META_GEO_PLACES),
    placements: z.array(z.enum(META_PLACEMENTS)).min(1).max(5).optional(),
    age_min: z.number().int().min(18).max(65).optional(),
    age_max: z.number().int().min(18).max(65).optional(),
    headline: z.string().trim().min(1).max(255),
    primary_text: z.string().trim().min(1).max(2000),
    link_url: z.string().url().refine((u) => u.startsWith("https://"), "the link must start with https://"),
    image_url: z.string().url().refine((u) => u.startsWith("https://"), "the image link must start with https://"),
    cta: launchCtaSchema.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.goal === "conversions" && !b.conversion_event) {
      ctx.addIssue({ code: "custom", path: ["conversion_event"], message: "Pick the conversion to count." });
    }
    if (b.age_min !== undefined && b.age_max !== undefined && b.age_min > b.age_max) {
      ctx.addIssue({ code: "custom", path: ["age_min"], message: "The youngest age is above the oldest." });
    }
  });
export type MetaCampaignCreate = z.infer<typeof metaCampaignCreateSchema>;

async function firstPixelId(tenant_id: string): Promise<string> {
  const creds = await metaAdsCreds(tenant_id);
  const r = (await fbGet(tenant_id, `${creds.ad_account_id}/adspixels`, { fields: "id,name", limit: 5 })) as { data?: Array<{ id?: string }> };
  const id = r.data?.find((p) => p.id && /^\d+$/.test(p.id))?.id;
  if (!id) throw new ExpectedToolError("meta_editor_no_pixel", "This ad account has no Meta pixel, so Zavi can't count conversions. Pick Traffic, or add a pixel in Meta first.");
  return id;
}

async function assertBudgetAllowed(tenant_id: string, daily_budget: number, currency: string): Promise<void> {
  const ceiling = currency.toUpperCase() === "USD" ? MAX_DAILY_BUDGET : null;
  if (ceiling !== null && daily_budget > ceiling) {
    throw new ExpectedToolError("meta_editor_budget_typo", `A daily budget above ${formatMoney(ceiling, currency)} looks like a typo.`);
  }
  const { cap, cap_row_absent } = await readTenantCapAndToday(tenant_id);
  if (!cap && !cap_row_absent) {
    throw new ExpectedToolError(
      "meta_editor_cap_unreadable",
      "Zavi couldn't read your Meta daily limit, so nothing was built. Try again in a minute.",
    );
  }
  if (cap?.enabled && cap.max_daily_budget_usd != null && daily_budget > cap.max_daily_budget_usd) {
    throw new ExpectedToolError(
      "meta_editor_over_cap",
      `Your Meta daily limit in Zavi is ${formatMoney(cap.max_daily_budget_usd, currency)}. Lower the budget or raise the limit in Settings.`,
    );
  }
}

export async function createMetaCampaign(tenant_id: TenantId, user_id: string, input: MetaCampaignCreate): Promise<StagedChange> {
  const currency = await assertWritable(tenant_id);
  await assertBudgetAllowed(tenant_id, input.daily_budget, currency);
  const capability = await resolveMetaAdCapability(tenant_id);
  if (!capability.ok) throw new ExpectedToolError(`meta_ads_${capability.reason_code}`, capability.reason);

  const goal = META_EDITOR_GOALS[input.goal];
  const places = await verifyMetaPlaces(tenant_id, input.places.map((id) => parseMetaPlaceId(id)!));
  const targeting: Record<string, unknown> = {
    geo_locations: shapeGeoLocations(places, null),
    ...(input.age_min !== undefined ? { age_min: input.age_min } : {}),
    ...(input.age_max !== undefined ? { age_max: input.age_max } : {}),
    ...(input.placements ? { publisher_platforms: input.placements } : {}),
  };
  const parsed = launchCampaignBodySchema.safeParse({
    campaign: { name: input.name, objective: goal.objective, daily_budget_usd: input.daily_budget },
    ad_set: {
      name: input.name,
      optimization_goal: goal.optimization_goal,
      billing_event: goal.billing_event,
      targeting,
      ...(input.goal === "conversions"
        ? { promoted_object: { pixel_id: await firstPixelId(tenant_id), custom_event_type: input.conversion_event } }
        : {}),
      ...(input.end_time ? { end_time: input.end_time } : {}),
    },
    ad: {
      image_url: input.image_url,
      primary_text: input.primary_text,
      headline: input.headline,
      link_url: input.link_url,
      ...(input.cta ? { cta: input.cta } : {}),
      source: "library",
      name: input.name,
    },
    switch_on: false,
    currency,
    about: "A new campaign you built in Zavi's campaign editor. It stays paused until you launch it.",
    rationale: "The founder built this campaign in the campaign editor.",
    origin: ORIGIN,
  });
  if (!parsed.success) {
    throw new ExpectedToolError("meta_editor_invalid", parsed.error.issues.map((i) => i.message).join("; "));
  }
  return stageAndApprove(tenant_id, user_id, "meta_ads.launch_campaign", parsed.data as Record<string, unknown>, `New campaign "${input.name}"`);
}

const OBJECTIVE_GOAL: Record<string, MetaEditorGoal> = {
  OUTCOME_TRAFFIC: "traffic",
  OUTCOME_AWARENESS: "awareness",
  OUTCOME_SALES: "conversions",
};

const httpsLink = (message: string) => z.string().url().refine((u) => u.startsWith("https://"), message);

export const metaAdSetCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    conversion_event: z.enum(META_CONVERSION_EVENTS).optional(),
    daily_budget: z.number().positive(),
    places: z.array(placeIdSchema).min(1).max(MAX_META_GEO_PLACES),
    placements: z.array(z.enum(META_PLACEMENTS)).min(1).max(5).optional(),
    age_min: z.number().int().min(18).max(65).optional(),
    age_max: z.number().int().min(18).max(65).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.age_min !== undefined && b.age_max !== undefined && b.age_min > b.age_max) {
      ctx.addIssue({ code: "custom", path: ["age_min"], message: "The youngest age is above the oldest." });
    }
  });
export type MetaAdSetCreate = z.infer<typeof metaAdSetCreateSchema>;

export async function createMetaAdSet(tenant_id: TenantId, user_id: string, campaign_id: string, input: MetaAdSetCreate): Promise<StagedChange> {
  const currency = await assertWritable(tenant_id);
  await assertBudgetAllowed(tenant_id, input.daily_budget, currency);
  const campaign = await readOwnCampaignFull(tenant_id, campaign_id);
  if (Number(campaign.daily_budget ?? 0) > 0 || Number(campaign.lifetime_budget ?? 0) > 0) {
    throw new ExpectedToolError(
      "meta_editor_campaign_budget",
      "This campaign holds the budget for all its ad sets, so Meta takes no budget on a new one. Add the ad set in Meta, or build a new campaign here.",
    );
  }
  const goalKey = OBJECTIVE_GOAL[campaign.objective ?? ""];
  if (!goalKey) {
    throw new ExpectedToolError(
      "meta_editor_objective_unsupported",
      "Zavi adds ad sets to website-visit, reach and sales campaigns only. Add this one in Meta.",
    );
  }
  if (goalKey === "conversions" && !input.conversion_event) {
    throw new ExpectedToolError("meta_editor_invalid", "Pick the conversion to count.");
  }
  const goal = META_EDITOR_GOALS[goalKey];
  const places = await verifyMetaPlaces(tenant_id, input.places.map((id) => parseMetaPlaceId(id)!));
  const draft = createAdSetBodySchema.safeParse({
    campaign_id,
    name: input.name,
    daily_budget_usd: input.daily_budget,
    currency,
    optimization_goal: goal.optimization_goal,
    billing_event: goal.billing_event,
    targeting: {
      geo_locations: shapeGeoLocations(places, null),
      ...(input.age_min !== undefined ? { age_min: input.age_min } : {}),
      ...(input.age_max !== undefined ? { age_max: input.age_max } : {}),
      ...(input.placements ? { publisher_platforms: input.placements } : {}),
    },
    rationale: "The founder added this ad set in the campaign editor.",
    ...(goalKey === "conversions"
      ? { promoted_object: { pixel_id: await firstPixelId(tenant_id), custom_event_type: input.conversion_event } }
      : {}),
  });
  if (!draft.success) {
    throw new ExpectedToolError("meta_editor_invalid", draft.error.issues.map((i) => i.message).join("; "));
  }
  const body = createAdSetBodySchema.safeParse(await resolveCreateAdSetBid(tenant_id, draft.data));
  if (!body.success) {
    throw new ExpectedToolError("meta_editor_invalid", body.error.issues.map((i) => i.message).join("; "));
  }
  return stageAndApprove(tenant_id, user_id, "meta_ads.create_ad_set", body.data as Record<string, unknown>, `New ad set "${input.name}"`);
}

export const metaAdCreateSchema = z
  .object({
    ad_set_id: z.string().trim().regex(/^[0-9]{5,25}$/),
    name: z.string().trim().min(1).max(200),
    headline: z.string().trim().min(1).max(255),
    primary_text: z.string().trim().min(1).max(2000),
    link_url: httpsLink("the link must start with https://"),
    image_url: httpsLink("the image link must start with https://"),
    cta: launchCtaSchema.optional(),
  })
  .strict();
export type MetaAdCreate = z.infer<typeof metaAdCreateSchema>;

export async function createMetaAd(tenant_id: TenantId, user_id: string, campaign_id: string, input: MetaAdCreate): Promise<StagedChange> {
  await assertWritable(tenant_id);
  const capability = await resolveMetaAdCapability(tenant_id);
  if (!capability.ok) throw new ExpectedToolError(`meta_ads_${capability.reason_code}`, capability.reason);
  await readOwnCampaignFull(tenant_id, campaign_id);
  const sets = await readAdSets(tenant_id, campaign_id);
  if (!sets.some((s) => s.id === input.ad_set_id)) {
    throw new ExpectedToolError("meta_ads_invalid_target", "That ad set is not in this campaign.");
  }
  const parsed = createAdBodySchema.safeParse({
    ad_set_id: input.ad_set_id,
    image_url: input.image_url,
    primary_text: input.primary_text,
    headline: input.headline,
    link_url: input.link_url,
    ...(input.cta ? { cta: input.cta } : {}),
    source: "library",
    name: input.name,
    about: "A new ad you added in Zavi's campaign editor.",
    rationale: "The founder added this ad in the campaign editor.",
    origin: ORIGIN,
  });
  if (!parsed.success) {
    throw new ExpectedToolError("meta_editor_invalid", parsed.error.issues.map((i) => i.message).join("; "));
  }
  return stageAndApprove(tenant_id, user_id, "meta_ads.create_ad", parsed.data as Record<string, unknown>, `New ad "${input.name}"`);
}
