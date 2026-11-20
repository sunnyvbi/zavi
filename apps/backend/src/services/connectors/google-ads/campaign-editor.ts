
import { z } from "zod";
import { tenantClient, tenantRpc, type TenantId } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { gadsSearch, gadsGetAdGroup, gadsGetCampaign, gadsGetKeyword, gadsListAdGroupNames, gadsListCampaignNames } from "@/services/tools/google-ads/_client";
import { isGoogleAdsWriteEnabled } from "@/services/tools/google-ads/write/_flag-check";
import { readGoogleAccountCurrency } from "@/services/tools/google-ads/write/_currency-guard";
import { readTenantGoogleCapAndToday } from "@/services/tools/google-ads/write/cap-reader";
import { assertNoGoogleNameCollision } from "@/services/tools/google-ads/write/_helpers";
import {
  GEO_LEVEL_BY_CHANNEL_TYPE,
  MAX_GEO_PLACES,
  geoFingerprint,
  geoShape,
  liveGeoIds,
  readGoogleGeoTargets,
} from "@/services/tools/google-ads/write/replace_geo_targets";
import {
  KEYWORD_MATCH_TYPES,
  addKeywordsBodySchema,
  checkAdKindForAdGroupType,
  createAdBodySchema,
  createAdGroupBodySchema,
  createCampaignBodySchema,
  removeResourceBodySchema,
  updateAdGroupBodySchema,
  updateCampaignBodySchema,
} from "@/services/tools/google-ads/write/_decision-bodies";
import { googlePlaceNames, readGooglePlaces } from "@/services/ad-locations/places";
import { applyPlannedChanges, type PlannedEditorChange } from "@/services/connectors/_editor-save";

const ORIGIN = "user_initiated_ledger" as const;
const MAX_DAILY_BUDGET = 10_000;
const MAX_ROWS = 500;

const micros = (v: unknown): number | null => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? null : Math.round((n / 1_000_000) * 100) / 100;
};
const idOk = (s: string) => /^[0-9]{1,20}$/.test(s);

export type GoogleKeyword = { criterion_id: string; text: string; match_type: string; status: string | null };

export type GoogleEditorView = {
  campaign: {
    id: string;
    name: string;
    status: string | null;
    channel_type: string;
    bidding_strategy_type: string;
    daily_budget: number | null;
    budget_shared: boolean;
    target_cpa: number | null;
    target_roas: number | null;
    network: { search_network: boolean; content_network: boolean } | null;
    end_date: string | null;
  };
  places: Array<{ id: string; name: string }>;
  places_editable: boolean;
  places_fingerprint: string | null;
  ad_groups: Array<{ id: string; name: string; status: string | null; type: string; cpc_bid: number | null; keywords: GoogleKeyword[] }>;
  negative_keywords: GoogleKeyword[];
  ads: Array<{ id: string; ad_group_id: string; status: string | null; type: string; headlines: string[]; descriptions: string[]; final_url: string | null }>;
  keywords_editable: boolean;
  read_only: "video" | null;
  currency: string;
  writes_enabled: boolean;
};

type CampaignRow = {
  campaign?: {
    id?: string;
    name?: string;
    status?: string;
    advertisingChannelType?: string;
    biddingStrategyType?: string;
    endDateTime?: string;
    maximizeConversions?: { targetCpaMicros?: string };
    targetCpa?: { targetCpaMicros?: string };
    maximizeConversionValue?: { targetRoas?: number };
    targetRoas?: { targetRoas?: number };
    networkSettings?: { targetGoogleSearch?: boolean; targetSearchNetwork?: boolean; targetContentNetwork?: boolean; targetPartnerSearchNetwork?: boolean };
  };
  campaignBudget?: { amountMicros?: string; explicitlyShared?: boolean };
};

async function readCampaignRow(tenant_id: string, campaign_id: string): Promise<CampaignRow> {
  const rows = (await gadsSearch(
    tenant_id,
    "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.end_date_time, " +
      "campaign.maximize_conversions.target_cpa_micros, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign.target_roas.target_roas, " +
      "campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network, " +
      `campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${campaign_id} AND campaign.status != 'REMOVED' LIMIT 1`,
  )) as CampaignRow[];
  if (!rows[0]?.campaign) throw new ExpectedToolError("google_ads_campaign_not_found", "That campaign is not in your Google Ads account any more.");
  return rows[0];
}

function targetsOf(c: NonNullable<CampaignRow["campaign"]>): { target_cpa: number | null; target_roas: number | null } {
  const s = c.biddingStrategyType ?? "";
  const cpa = s === "MAXIMIZE_CONVERSIONS" ? micros(c.maximizeConversions?.targetCpaMicros) : s === "TARGET_CPA" ? micros(c.targetCpa?.targetCpaMicros) : null;
  const roasRaw = s === "MAXIMIZE_CONVERSION_VALUE" ? c.maximizeConversionValue?.targetRoas : s === "TARGET_ROAS" ? c.targetRoas?.targetRoas : undefined;
  const roas = roasRaw !== undefined && Number(roasRaw) > 0 ? Number(roasRaw) : null;
  return { target_cpa: cpa && cpa > 0 ? cpa : null, target_roas: roas };
}

export async function readGoogleCampaignEditor(tenant_id: string, campaign_id: string): Promise<GoogleEditorView> {
  if (!idOk(campaign_id)) throw new ExpectedToolError("google_ads_invalid_target", "That is not a Google Ads campaign id.");
  const [row, groups, kws, negs, ads, currency, writes] = await Promise.all([
    readCampaignRow(tenant_id, campaign_id),
    gadsSearch(
      tenant_id,
      `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros FROM ad_group WHERE campaign.id = ${campaign_id} AND ad_group.status != 'REMOVED' LIMIT ${MAX_ROWS}`,
    ) as Promise<Array<{ adGroup?: { id?: string; name?: string; status?: string; type?: string; cpcBidMicros?: string } }>>,
    gadsSearch(
      tenant_id,
      "SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status " +
        `FROM ad_group_criterion WHERE campaign.id = ${campaign_id} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED' LIMIT 2000`,
    ) as Promise<Array<{ adGroup?: { id?: string }; adGroupCriterion?: { criterionId?: string; status?: string; keyword?: { text?: string; matchType?: string } } }>>,
    gadsSearch(
      tenant_id,
      "SELECT campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type " +
        `FROM campaign_criterion WHERE campaign.id = ${campaign_id} AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE LIMIT ${MAX_ROWS}`,
    ) as Promise<Array<{ campaignCriterion?: { criterionId?: string; keyword?: { text?: string; matchType?: string } } }>>,
    gadsSearch(
      tenant_id,
      "SELECT ad_group.id, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions " +
        `FROM ad_group_ad WHERE campaign.id = ${campaign_id} AND ad_group_ad.status != 'REMOVED' LIMIT 100`,
    ) as Promise<
      Array<{
        adGroup?: { id?: string };
        adGroupAd?: { status?: string; ad?: { id?: string; type?: string; finalUrls?: string[]; responsiveSearchAd?: { headlines?: Array<{ text?: string }>; descriptions?: Array<{ text?: string }> } } };
      }>
    >,
    readGoogleAccountCurrency(tenant_id).catch(() => ""),
    isGoogleAdsWriteEnabled(),
  ]);
  const c = row.campaign!;
  const channel = c.advertisingChannelType ?? "";
  const search = channel === "SEARCH";

  let places: Array<{ id: string; name: string }> = [];
  let places_editable = false;
  let places_fingerprint: string | null = null;
  const level = GEO_LEVEL_BY_CHANNEL_TYPE[channel];
  if (level) {
    const live = await gadsGetCampaign(tenant_id, campaign_id);
    const targets = await readGoogleGeoTargets(tenant_id, live, level);
    const named = await googlePlaceNames(tenant_id, liveGeoIds(targets));
    places = named.map((p) => ({ id: p.id, name: p.name }));
    places_editable = level === "campaign" ? geoShape(targets) !== "mixed" : geoShape(targets) === "single";
    places_fingerprint = geoFingerprint(targets);
  }

  const kwByGroup = new Map<string, GoogleKeyword[]>();
  for (const r of kws) {
    const g = r.adGroup?.id;
    const k = r.adGroupCriterion;
    if (!g || !k?.criterionId || !k.keyword?.text) continue;
    const list = kwByGroup.get(g) ?? [];
    list.push({ criterion_id: k.criterionId, text: k.keyword.text, match_type: k.keyword.matchType ?? "", status: k.status ?? null });
    kwByGroup.set(g, list);
  }
  const net = c.networkSettings;
  return {
    campaign: {
      id: c.id ?? campaign_id,
      name: c.name ?? "",
      status: c.status ?? null,
      channel_type: channel,
      bidding_strategy_type: c.biddingStrategyType ?? "",
      daily_budget: micros(row.campaignBudget?.amountMicros),
      budget_shared: row.campaignBudget?.explicitlyShared === true,
      ...targetsOf(c),
      network: search ? { search_network: net?.targetSearchNetwork === true, content_network: net?.targetContentNetwork === true } : null,
      end_date: typeof c.endDateTime === "string" && c.endDateTime.trim() ? c.endDateTime.trim().slice(0, 10) : null,
    },
    places,
    places_editable,
    places_fingerprint,
    ad_groups: groups
      .filter((g) => g.adGroup?.id)
      .map((g) => ({
        id: g.adGroup!.id!,
        name: g.adGroup!.name ?? g.adGroup!.id!,
        status: g.adGroup!.status ?? null,
        type: g.adGroup!.type ?? "",
        cpc_bid: micros(g.adGroup!.cpcBidMicros),
        keywords: kwByGroup.get(g.adGroup!.id!) ?? [],
      })),
    negative_keywords: negs
      .filter((n) => n.campaignCriterion?.criterionId && n.campaignCriterion.keyword?.text)
      .map((n) => ({ criterion_id: n.campaignCriterion!.criterionId!, text: n.campaignCriterion!.keyword!.text!, match_type: n.campaignCriterion!.keyword!.matchType ?? "", status: null })),
    ads: ads
      .filter((a) => a.adGroupAd?.ad?.id && a.adGroup?.id)
      .map((a) => {
        const ad = a.adGroupAd!.ad!;
        return {
          id: ad.id!,
          ad_group_id: a.adGroup!.id!,
          status: a.adGroupAd!.status ?? null,
          type: ad.type ?? "",
          headlines: (ad.responsiveSearchAd?.headlines ?? []).map((h) => h.text ?? "").filter(Boolean),
          descriptions: (ad.responsiveSearchAd?.descriptions ?? []).map((h) => h.text ?? "").filter(Boolean),
          final_url: ad.finalUrls?.[0] ?? null,
        };
      }),
    keywords_editable: search,
    read_only: channel === "VIDEO" ? "video" : null,
    currency: currency || "USD",
    writes_enabled: writes,
  };
}

export type StagedChange = { label: string; decision_id: string; approved: boolean; code: string | null };

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
    throw new ExpectedToolError("google_editor_forbidden", `Zavi is not allowed to make this kind of change in this workspace ("${label}"). Nothing was sent.`);
  }
  if (staged === "unreadable") {
    throw new ExpectedToolError(
      "google_editor_stage_unknown",
      `Zavi saved "${label}" but could not confirm it. Check Approvals before saving it again.`,
      { decision_id: data, label },
    );
  }
  if (staged !== "ours") {
    throw new ExpectedToolError(
      "google_editor_change_open",
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

async function assertWritable(tenant_id: string): Promise<void> {
  if (!(await isGoogleAdsWriteEnabled())) {
    throw new ExpectedToolError("google_ads_write_disabled", "Zavi can't change Google Ads campaigns right now. Nothing was saved.");
  }
  let currency: string;
  try {
    currency = await readGoogleAccountCurrency(tenant_id);
  } catch {
    throw new ExpectedToolError("google_ads_currency_unverified", "Zavi couldn't read your Google Ads account's currency, so nothing was saved. Try again in a minute.");
  }
  if (currency !== "USD") {
    throw new ExpectedToolError("google_ads_non_usd_account", `Zavi changes Google Ads campaigns in USD accounts only; this one is ${currency || "not USD"}.`);
  }
}

function parseOrRefuse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ExpectedToolError("google_editor_invalid", parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

const keywordIn = z.object({ text: z.string().trim().min(1).max(80), match_type: z.enum(KEYWORD_MATCH_TYPES) });
const Id = z.string().regex(/^[0-9]{1,20}$/);

export const googleCampaignEditSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    target_cpa_usd: z.number().positive().max(MAX_DAILY_BUDGET).optional(),
    target_roas: z.number().positive().max(100).optional(),
    network: z.object({ search_network: z.boolean(), content_network: z.boolean() }).optional(),
    places: z.object({ ids: z.array(Id).min(1).max(MAX_GEO_PLACES), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
    ad_groups: z.array(z.object({ id: Id, name: z.string().trim().min(1).max(255).optional(), cpc_bid_usd: z.number().positive().max(1000).optional() })).max(50).optional(),
    add_keywords: z.array(z.object({ ad_group_id: Id, keywords: z.array(keywordIn).min(1).max(200) })).max(50).optional(),
    remove_keywords: z.array(z.object({ ad_group_id: Id, criterion_id: Id })).max(200).optional(),
    add_negatives: z.array(keywordIn).max(200).optional(),
    remove_negatives: z.array(Id).max(200).optional(),
  })
  .strict();
export type GoogleCampaignEdit = z.infer<typeof googleCampaignEditSchema>;

const common = (label: string) => ({
  name: label,
  about: "A change you made in Zavi's campaign editor.",
  rationale: "The founder saved this in the campaign editor.",
  origin: ORIGIN,
});

export async function saveGoogleCampaignEdits(tenant_id: TenantId, user_id: string, campaign_id: string, input: GoogleCampaignEdit): Promise<StagedChange[]> {
  await assertWritable(tenant_id);
  const row = await readCampaignRow(tenant_id, campaign_id);
  const c = row.campaign!;
  const label = c.name ?? campaign_id;
  if (c.advertisingChannelType === "VIDEO") {
    throw new ExpectedToolError("google_ads_video_mutate_unsupported", "Google's Ads API can't change Video campaigns. Change this one in Google Ads.");
  }
  const search = c.advertisingChannelType === "SEARCH";
  const planned: PlannedEditorChange[] = [];
  const plan = (decision_class: string, body: Record<string, unknown>, label: string) => planned.push({ decision_class, body, label });

  const patch: Record<string, unknown> = {};
  const what: string[] = [];
  if (input.name !== undefined && input.name !== (c.name ?? "")) {
    const names = await gadsListCampaignNames(tenant_id);
    assertNoGoogleNameCollision(names.filter((n) => n !== c.name), input.name, "campaign");
    patch.new_name = input.name;
    what.push("name");
  }
  const t = targetsOf(c);
  if (input.target_cpa_usd !== undefined && input.target_cpa_usd !== t.target_cpa) {
    if (!["MAXIMIZE_CONVERSIONS", "TARGET_CPA"].includes(c.biddingStrategyType ?? "")) {
      throw new ExpectedToolError("google_editor_invalid", "This campaign's bidding doesn't take a target cost per conversion.");
    }
    patch.target_cpa_usd = input.target_cpa_usd;
    what.push("target cost per conversion");
  }
  if (input.target_roas !== undefined && input.target_roas !== t.target_roas) {
    if (!["MAXIMIZE_CONVERSION_VALUE", "TARGET_ROAS"].includes(c.biddingStrategyType ?? "")) {
      throw new ExpectedToolError("google_editor_invalid", "This campaign's bidding doesn't take a target return on ad spend.");
    }
    patch.target_roas = input.target_roas;
    what.push("target return on ad spend");
  }
  if (input.network) {
    if (!search) throw new ExpectedToolError("google_editor_invalid", "Where ads show (search partners, Display) can be changed on Search campaigns only.");
    const n = c.networkSettings ?? {};
    if (input.network.search_network !== (n.targetSearchNetwork === true) || input.network.content_network !== (n.targetContentNetwork === true)) {
      patch.network = {
        google_search: n.targetGoogleSearch !== false,
        search_network: input.network.search_network,
        content_network: input.network.content_network,
        partner_search_network: n.targetPartnerSearchNetwork === true,
      };
      what.push("where ads show");
    }
  }
  if (what.length > 0) {
    const body = parseOrRefuse(updateCampaignBodySchema, { campaign_id, ...patch, ...common(label) });
    plan("google_ads.update_campaign", body as Record<string, unknown>, `${label}: ${what.join(", ")}`);
  }

  if (input.places) {
    const live = await gadsGetCampaign(tenant_id, campaign_id);
    const level = GEO_LEVEL_BY_CHANNEL_TYPE[live.channel_type];
    if (!level) throw new ExpectedToolError("ad_locations_unsupported", "Zavi can't change where this campaign shows. Change it in Google Ads.");
    const targets = await readGoogleGeoTargets(tenant_id, live, level);
    if (geoFingerprint(targets) !== input.places.fingerprint) {
      throw new ExpectedToolError("google_editor_drift", "Where this campaign shows changed in Google Ads since you opened it. Reopen the campaign and try again.");
    }
    if (level === "ad_group" && geoShape(targets) !== "single") {
      throw new ExpectedToolError("ad_locations_unsupported", "This campaign's ad groups show in different places. Change them in Google Ads.");
    }
    const ids = [...new Set(input.places.ids.map(Number))];
    const now = liveGeoIds(targets);
    if (ids.slice().sort((a, b) => a - b).join(",") !== now.join(",")) {
      let known: Awaited<ReturnType<typeof readGooglePlaces>>;
      try {
        known = await readGooglePlaces(tenant_id, ids);
      } catch {
        throw new ExpectedToolError("ad_locations_unverified", "Zavi couldn't check these places with Google Ads just now. Try again in a minute.");
      }
      if (ids.some((id) => !known.has(id))) throw new ExpectedToolError("ad_locations_bad_place", "One of the places is not a place Google Ads knows. Search for it again.");
      const before = await googlePlaceNames(tenant_id, now);
      const body = {
        campaign_id,
        level,
        scope: level === "ad_group" ? ("all_ad_groups" as const) : ("campaign" as const),
        location_ids: ids,
        place_names: ids.map((id) => known.get(id)!.name),
        before_names: before.map((p) => p.name),
        expected_fingerprint: input.places.fingerprint,
        over_cap: true as const,
        ...common(label),
      };
      plan("google_ads.replace_geo_targets_review", body, `${label}: places`);
    }
  }

  const groupIn = async (ad_group_id: string) => {
    const g = await gadsGetAdGroup(tenant_id, ad_group_id);
    if (g.campaign_id !== campaign_id) throw new ExpectedToolError("google_ads_invalid_target", "That ad group is not in this campaign any more. Reopen the campaign.");
    return g;
  };
  for (const g of input.ad_groups ?? []) {
    const live = await groupIn(g.id);
    const rows = (await gadsSearch(tenant_id, `SELECT ad_group.cpc_bid_micros FROM ad_group WHERE ad_group.id = ${g.id} LIMIT 1`)) as Array<{ adGroup?: { cpcBidMicros?: string } }>;
    const bid = micros(rows[0]?.adGroup?.cpcBidMicros);
    const p: Record<string, unknown> = {};
    const w: string[] = [];
    if (g.name !== undefined && g.name !== live.name) {
      p.new_name = g.name;
      w.push("name");
    }
    if (g.cpc_bid_usd !== undefined && g.cpc_bid_usd !== bid) {
      p.cpc_bid_usd = g.cpc_bid_usd;
      w.push("max cost per click");
    }
    if (w.length === 0) continue;
    const body = parseOrRefuse(updateAdGroupBodySchema, { ad_group_id: g.id, ...p, ...common(live.name || g.id) });
    plan("google_ads.update_ad_group", body as Record<string, unknown>, `${live.name || g.id}: ${w.join(", ")}`);
  }

  const wantsKeywords = (input.add_keywords?.length ?? 0) + (input.remove_keywords?.length ?? 0) + (input.add_negatives?.length ?? 0) + (input.remove_negatives?.length ?? 0) > 0;
  if (wantsKeywords && !search) throw new ExpectedToolError("google_editor_invalid", "Keywords can be changed on Search campaigns only.");
  for (const a of input.add_keywords ?? []) {
    const g = await groupIn(a.ad_group_id);
    const body = parseOrRefuse(addKeywordsBodySchema, { level: "ad_group", ad_group_id: a.ad_group_id, negative: false, keywords: a.keywords, ...common(g.name || a.ad_group_id) });
    plan("google_ads.add_keywords", body as Record<string, unknown>, `${g.name || a.ad_group_id}: add ${a.keywords.length} keyword${a.keywords.length === 1 ? "" : "s"}`);
  }
  for (const r of input.remove_keywords ?? []) {
    const g = await groupIn(r.ad_group_id);
    const k = await gadsGetKeyword(tenant_id, { level: "ad_group", ad_group_id: r.ad_group_id }, r.criterion_id);
    const body = parseOrRefuse(removeResourceBodySchema, {
      level: "keyword",
      scope: "ad_group",
      parent_id: r.ad_group_id,
      criterion_id: r.criterion_id,
      keyword_text: k.text.slice(0, 80) || undefined,
      criterion_negative: k.negative,
      ...common(g.name || r.ad_group_id),
    });
    plan("google_ads.remove_resource", body as Record<string, unknown>, `${g.name || r.ad_group_id}: remove "${k.text}"`);
  }
  if ((input.add_negatives?.length ?? 0) > 0) {
    const body = parseOrRefuse(addKeywordsBodySchema, { level: "campaign", campaign_id, negative: true, keywords: input.add_negatives, ...common(label) });
    plan("google_ads.add_keywords", body as Record<string, unknown>, `${label}: add ${input.add_negatives!.length} negative keyword${input.add_negatives!.length === 1 ? "" : "s"}`);
  }
  for (const id of input.remove_negatives ?? []) {
    const k = await gadsGetKeyword(tenant_id, { level: "campaign", campaign_id }, id);
    const body = parseOrRefuse(removeResourceBodySchema, {
      level: "keyword",
      scope: "campaign",
      parent_id: campaign_id,
      criterion_id: id,
      keyword_text: k.text.slice(0, 80) || undefined,
      criterion_negative: k.negative,
      ...common(label),
    });
    plan("google_ads.remove_resource", body as Record<string, unknown>, `${label}: remove negative "${k.text}"`);
  }
  return applyPlannedChanges(planned, (p) => stageAndApprove(tenant_id, user_id, p.decision_class, p.body, p.label));
}

export const googleCampaignCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    daily_budget: z.number().positive(),
    goal: z.enum(["clicks", "conversions"]),
    max_cpc_usd: z.number().positive().max(1000).optional(),
    target_cpa_usd: z.number().positive().max(MAX_DAILY_BUDGET).optional(),
    places: z.array(Id).min(1).max(MAX_GEO_PLACES),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    search_partners: z.boolean().default(false),
    keywords: z.array(keywordIn).min(1).max(200),
    final_url: z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), "The link must start with http:// or https://"),
    headlines: z.array(z.string().trim().min(1).max(30)).min(3).max(15),
    descriptions: z.array(z.string().trim().min(1).max(90)).min(2).max(4),
    path1: z.string().trim().max(15).optional(),
    path2: z.string().trim().max(15).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.goal === "clicks" && b.target_cpa_usd !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target_cpa_usd"], message: "A target cost per conversion goes with the Conversions goal." });
    if (b.goal === "conversions" && b.max_cpc_usd !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["max_cpc_usd"], message: "A max cost per click goes with the Clicks goal." });
  });
export type GoogleCampaignCreate = z.infer<typeof googleCampaignCreateSchema>;

const dayAfter = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

async function preflightCreate(tenant_id: TenantId, input: { name: string; daily_budget: number; end_date?: string; places: string[] }): Promise<number[]> {
  await assertWritable(tenant_id);
  if (input.daily_budget > MAX_DAILY_BUDGET) {
    throw new ExpectedToolError("google_editor_budget_typo", `A daily budget above $${MAX_DAILY_BUDGET.toLocaleString("en-US")} looks like a typo.`);
  }
  const { cap, cap_row_absent } = await readTenantGoogleCapAndToday(tenant_id);
  if (!cap && !cap_row_absent) {
    throw new ExpectedToolError("google_editor_cap_unreadable", "Zavi couldn't read your Google daily limit, so nothing was built. Try again in a minute.");
  }
  if (cap?.enabled && cap.max_daily_budget_usd != null && input.daily_budget > cap.max_daily_budget_usd) {
    throw new ExpectedToolError(
      "google_editor_over_cap",
      `Your Google daily limit in Zavi is $${cap.max_daily_budget_usd}. Lower the budget or raise the limit in Settings.`,
    );
  }
  if (input.end_date && Date.parse(`${input.end_date}T00:00:00Z`) < Date.parse(new Date().toISOString().slice(0, 10))) {
    throw new ExpectedToolError("google_editor_bad_end", "The end date has already passed.");
  }
  assertNoGoogleNameCollision(await gadsListCampaignNames(tenant_id), input.name, "campaign");

  const ids = [...new Set(input.places.map(Number))];
  let known: Awaited<ReturnType<typeof readGooglePlaces>>;
  try {
    known = await readGooglePlaces(tenant_id, ids);
  } catch {
    throw new ExpectedToolError("ad_locations_unverified", "Zavi couldn't check these places with Google Ads just now. Try again in a minute.");
  }
  if (ids.some((id) => !known.has(id))) throw new ExpectedToolError("ad_locations_bad_place", "One of the places is not a place Google Ads knows. Search for it again.");
  return ids;
}

export async function createGoogleCampaign(tenant_id: TenantId, user_id: string, input: GoogleCampaignCreate): Promise<StagedChange> {
  const ids = await preflightCreate(tenant_id, input);
  const bidding =
    input.goal === "clicks"
      ? { strategy: "TARGET_SPEND" as const, ...(input.max_cpc_usd !== undefined ? { cpc_bid_ceiling_usd: input.max_cpc_usd } : {}) }
      : { strategy: "MAXIMIZE_CONVERSIONS" as const, ...(input.target_cpa_usd !== undefined ? { target_cpa_usd: input.target_cpa_usd } : {}) };
  const body = parseOrRefuse(createCampaignBodySchema, {
    name: input.name,
    channel_type: "SEARCH",
    daily_budget_usd: input.daily_budget,
    bidding,
    network: { google_search: true, search_network: input.search_partners, content_network: false, partner_search_network: false },
    location_ids: ids,
    ad_group: {
      name: input.name,
      type: "SEARCH_STANDARD",
      keywords: input.keywords,
      ads: [
        {
          kind: "responsive_search",
          final_urls: [input.final_url],
          headlines: input.headlines,
          descriptions: input.descriptions,
          ...(input.path1 ? { path1: input.path1 } : {}),
          ...(input.path2 ? { path2: input.path2 } : {}),
        },
      ],
    },
    ...(input.end_date ? { end_date: dayAfter(input.end_date) } : {}),
    about: "A new campaign you built in Zavi's campaign editor. It stays paused until you launch it.",
    rationale: "The founder built this campaign in the campaign editor.",
    origin: ORIGIN,
  });
  return stageAndApprove(tenant_id, user_id, "google_ads.create_campaign", body as Record<string, unknown>, `New campaign "${input.name}"`);
}

const httpsUrl = z.string().trim().url().max(2048).refine((u) => u.startsWith("https://"), "The link must start with https://");

export const youtubeCampaignCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    daily_budget: z.number().positive(),
    target_cpa_usd: z.number().positive().max(MAX_DAILY_BUDGET).optional(),
    places: z.array(Id).min(1).max(MAX_GEO_PLACES),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    videos: z.array(z.string().trim().min(1).max(300)).min(1).max(5),
    final_url: httpsUrl,
    headlines: z.array(z.string().trim().min(1).max(40)).min(1).max(5),
    long_headlines: z.array(z.string().trim().min(1).max(90)).min(1).max(5),
    descriptions: z.array(z.string().trim().min(1).max(90)).min(1).max(5),
    business_name: z.string().trim().min(1).max(25),
    logo_url: httpsUrl,
  })
  .strict();
export type YoutubeCampaignCreate = z.infer<typeof youtubeCampaignCreateSchema>;

export async function createYoutubeCampaign(tenant_id: TenantId, user_id: string, input: YoutubeCampaignCreate): Promise<StagedChange> {
  const { youtubeVideoIdFrom } = await import("@/services/tools/google-ads/write/_video-formats");
  const videoIds = input.videos.map((v) => youtubeVideoIdFrom(v));
  if (videoIds.some((v) => !v)) throw new ExpectedToolError("google_editor_invalid", "One of the videos is not a YouTube link. Paste youtube.com/watch?v=…, youtu.be/… or youtube.com/shorts/….");
  const ids = await preflightCreate(tenant_id, input);

  const { pinnedFetch, storeLogo } = await import("@/services/tools/google-ads/write/_logo");
  const logo = await storeLogo(tenant_id, (await pinnedFetch(input.logo_url)).bytes);
  const body = parseOrRefuse(createCampaignBodySchema, {
    name: input.name,
    channel_type: "DEMAND_GEN",
    daily_budget_usd: input.daily_budget,
    bidding: { strategy: "MAXIMIZE_CONVERSIONS", ...(input.target_cpa_usd !== undefined ? { target_cpa_usd: input.target_cpa_usd } : {}) },
    location_ids: ids,
    demand_gen_ad_group: {
      name: `${input.name} – video`.slice(0, 255),
      ad: {
        final_urls: [input.final_url],
        youtube_video_ids: [...new Set(videoIds as string[])],
        headlines: input.headlines,
        long_headlines: input.long_headlines,
        descriptions: input.descriptions,
        business_name: input.business_name,
        logo,
      },
    },
    ...(input.end_date ? { end_date: dayAfter(input.end_date) } : {}),
    about: "A new YouTube campaign you built in Zavi's campaign editor. It stays paused until you launch it.",
    rationale: "The founder built this campaign in the campaign editor.",
    origin: ORIGIN,
  });
  const { googleValidateCreateCampaign } = await import("@/services/tools/google-ads/write/create_campaign");
  try {
    await googleValidateCreateCampaign(tenant_id, body);
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "google_ads_demand_gen_rejected") {
      throw new ExpectedToolError("google_editor_rejected", e.message.replace("so no card was filed", "so nothing was saved"));
    }
    throw e;
  }
  return stageAndApprove(tenant_id, user_id, "google_ads.create_campaign", body as Record<string, unknown>, `New YouTube campaign "${input.name}"`);
}

const SEARCH_ONLY = "Zavi adds ad groups and ads to Search campaigns only. Add this one in Google Ads.";

const searchAdShape = {
  final_url: z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), "The link must start with http:// or https://"),
  headlines: z.array(z.string().trim().min(1).max(30)).min(3).max(15),
  descriptions: z.array(z.string().trim().min(1).max(90)).min(2).max(4),
  path1: z.string().trim().max(15).optional(),
  path2: z.string().trim().max(15).optional(),
};
type SearchAdInput = { final_url: string; headlines: string[]; descriptions: string[]; path1?: string; path2?: string };

const searchAd = (input: SearchAdInput) => ({
  kind: "responsive_search" as const,
  final_urls: [input.final_url],
  headlines: input.headlines,
  descriptions: input.descriptions,
  ...(input.path1 ? { path1: input.path1 } : {}),
  ...(input.path2 ? { path2: input.path2 } : {}),
});

export const googleAdGroupCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    max_cpc_usd: z.number().positive().max(1000).optional(),
    keywords: z.array(keywordIn).min(1).max(200),
    ...searchAdShape,
  })
  .strict();
export type GoogleAdGroupCreate = z.infer<typeof googleAdGroupCreateSchema>;

export async function createGoogleAdGroup(tenant_id: TenantId, user_id: string, campaign_id: string, input: GoogleAdGroupCreate): Promise<StagedChange> {
  await assertWritable(tenant_id);
  const campaign = await gadsGetCampaign(tenant_id, campaign_id);
  if (campaign.channel_type !== "SEARCH") throw new ExpectedToolError("google_editor_search_only", SEARCH_ONLY);
  assertNoGoogleNameCollision(await gadsListAdGroupNames(tenant_id, campaign_id), input.name, "ad group");
  const body = parseOrRefuse(createAdGroupBodySchema, {
    campaign_id,
    name: input.name,
    type: "SEARCH_STANDARD",
    ...(input.max_cpc_usd !== undefined ? { cpc_bid_usd: input.max_cpc_usd } : {}),
    keywords: input.keywords,
    ads: [searchAd(input)],
    about: "A new ad group you added in Zavi's campaign editor. It stays paused until you switch it on.",
    rationale: "The founder added this ad group in the campaign editor.",
    origin: ORIGIN,
  });
  return stageAndApprove(tenant_id, user_id, "google_ads.create_ad_group", body as Record<string, unknown>, `New ad group "${input.name}"`);
}

export const googleAdCreateSchema = z.object({ ad_group_id: Id, ...searchAdShape }).strict();
export type GoogleAdCreate = z.infer<typeof googleAdCreateSchema>;

export async function createGoogleAd(tenant_id: TenantId, user_id: string, campaign_id: string, input: GoogleAdCreate): Promise<StagedChange> {
  await assertWritable(tenant_id);
  const group = await gadsGetAdGroup(tenant_id, input.ad_group_id);
  if (group.campaign_id !== campaign_id) {
    throw new ExpectedToolError("google_ads_invalid_target", "That ad group is not in this campaign any more. Reopen the campaign.");
  }
  if (checkAdKindForAdGroupType("responsive_search", group.type)) throw new ExpectedToolError("google_editor_search_only", SEARCH_ONLY);
  const label = `New ad in "${group.name}"`;
  const body = parseOrRefuse(createAdBodySchema, {
    ad_group_id: input.ad_group_id,
    ad: searchAd(input),
    name: label,
    about: "A new ad you added in Zavi's campaign editor. It stays paused until you switch it on.",
    rationale: "The founder added this ad in the campaign editor.",
    origin: ORIGIN,
  });
  return stageAndApprove(tenant_id, user_id, "google_ads.create_ad", body as Record<string, unknown>, label);
}
