
import type { z } from "zod";
import {
  createAdBodySchema,
  createAdSetBodySchema,
  createCustomAudienceBodySchema,
  duplicateAdSetBodySchema,
  duplicateCampaignBodySchema,
  setStatusBodySchema,
  updateAdSetBudgetBodySchema,
  updateCampaignBudgetBodySchema,
  createCampaignBodySchema,
  updateCampaignBodySchema,
  deleteCampaignBodySchema,
  updateAdSetBodySchema,
  updateAdBodySchema,
  duplicateAdBodySchema,
  createCreativeBodySchema,
  updateCreativeBodySchema,
  uploadAssetBodySchema,
  createLookalikeAudienceBodySchema,
  createCustomConversionBodySchema,
  createLeadFormBodySchema,
  launchCampaignBodySchema,
} from "./_decision-bodies";
import { pausePastGuardBodySchema } from "./_pause-past-guard";
import { replaceAdSetGeoBodySchema } from "./replace_ad_set_geo";
import { audienceModeLabel, type PromotedObject } from "./_targeting-validate";
import { formatMoney, normalizeCurrency } from "./_currency";
import { adChangeHeadline, adChangeObjectLabel } from "@zavi/shared";

export type ChangeRow = { item: string; before: string; after: string };

export type MetaChange = {
  title: string;
  change_sentence: string;
  rows: ChangeRow[];
};

function money(n: number, currency?: string | null): string {
  if (normalizeCurrency(currency) === "INR") return formatMoney(n, "INR");
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function quoted(name: string | undefined): string | null {
  return name ? `“${name}”` : null;
}

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> | null {
  const r = schema.safeParse(body);
  return r.success ? r.data : null;
}

export function metaChangeRows(decisionClass: string, body: unknown): MetaChange | null {
  switch (decisionClass) {
    case "meta_ads.update_ad_set_budget":
    case "meta_ads.update_ad_set_budget_review":
    case "meta_ads.update_campaign_budget":
    case "meta_ads.update_campaign_budget_review": {
      const isCampaign = decisionClass.startsWith("meta_ads.update_campaign_budget");
      const campaign = isCampaign ? parse(updateCampaignBudgetBodySchema, body) : null;
      const adSet = isCampaign ? null : parse(updateAdSetBudgetBodySchema, body);
      const b = campaign ?? adSet;
      if (!b) return null;
      const who = adChangeObjectLabel(decisionClass, body) ?? quoted(b.name) ?? (campaign ? `campaign ${campaign.campaign_id}` : `ad set ${adSet!.ad_set_id}`);
      const from = b.expected_current_daily_budget_usd;
      const to = b.daily_budget_usd;
      const verb = to > from ? "Raise" : to < from ? "Lower" : "Set";
      const monthly = Math.round(Math.abs(to - from) * 30.4);
      const effect =
        to === from
          ? ""
          : `, ${to > from ? "adding" : "cutting"} about ${money(monthly, b.currency)} a month at full delivery`;
      return {
        title: adChangeHeadline(decisionClass, body) ?? `${verb} the ${who} budget to ${money(to, b.currency)} a day`,
        change_sentence: `Zavi changes the daily budget of ${who} from ${money(from, b.currency)} to ${money(to, b.currency)}${effect}.`,
        rows: [
          { item: `${capFirst(who)} daily budget`, before: `${money(from, b.currency)}/day`, after: `${money(to, b.currency)}/day` },
        ],
      };
    }

    case "meta_ads.set_status":
    case "meta_ads.set_status_review": {
      const b = parse(setStatusBodySchema, body);
      if (!b) return null;
      const noun =
        adChangeObjectLabel(decisionClass, body) ?? quoted(b.name) ?? (b.level === "adset" ? `ad set ${b.object_id}` : `campaign ${b.object_id}`);
      const pause = b.status === "PAUSED";
      return {
        title: adChangeHeadline(decisionClass, body) ?? (pause ? `Pause ${noun}` : `Turn on ${noun}`),
        change_sentence: pause
          ? `Zavi pauses ${noun}. It stops showing ads and stops spending.`
          : `Zavi turns on ${noun}. It starts showing ads and spending.`,
        rows: [{ item: capFirst(noun), before: pause ? "Active" : "Paused", after: pause ? "Paused" : "Active" }],
      };
    }

    case "meta_ads.replace_ad_set_geo_review": {
      const b = parse(replaceAdSetGeoBodySchema, body);
      if (!b) return null;
      const noun = quoted(b.name) ?? `ad set ${b.ad_set_id}`;
      const label = (p: { name?: string; key: string }) => p.name?.trim() || p.key;
      const after = b.places.map(label).join(", ");
      const priorNames = b.before_names.map((n) => n.trim()).filter(Boolean);
      const before = priorNames.join(", ") || "Unknown";
      const budget = b.budget_daily ? `${money(b.budget_daily, b.budget_currency)}/day` : null;
      const undo = b.origin === "zavi_location_undo" && priorNames.length > 0;
      return {
        title: undo ? `Put the places back for ${noun}` : `Change where ${noun} shows`,
        change_sentence:
          `Zavi changes where ${noun} shows to: ${after}. ` +
          `${budget ? `Budget stays ${budget}.` : "The budget does not change."} Meta re-learns delivery after a location change (about a week).`,
        rows: [
          { item: `${capFirst(noun)} places`, before, after },
          { item: "Daily budget", before: budget ?? "As it is", after: budget ? `${budget} (unchanged)` : "Unchanged" },
        ],
      };
    }

    case "meta_ads.pause_past_cut_guard": {
      const b = parse(pausePastGuardBodySchema, body);
      if (!b) return null;
      const noun = quoted(b.name) ?? `ad set ${b.object_id}`;
      return {
        title: `Pause ${noun} anyway?`,
        change_sentence: `Zavi pauses ${noun}. It stops showing ads and stops spending. Pausing now resets Meta's learning when you turn it back on.`,
        rows: [
          { item: capFirst(noun), before: "Active", after: "Paused" },
          { item: "Spent in the last 7 days", before: b.spend_7d_usd === null ? "Unknown" : money(b.spend_7d_usd), after: "Stops" },
          { item: "Why Zavi held it", before: b.guard_reason, after: "Your call" },
        ],
      };
    }

    case "meta_ads.create_campaign": {
      const b = parse(createCampaignBodySchema, body);
      if (!b) return null;
      const budget = b.daily_budget_usd !== undefined ? `${money(b.daily_budget_usd, b.currency)}/day on the campaign` : "Set on each ad set";
      const rows: ChangeRow[] = [
        { item: "Campaign", before: "None", after: b.name },
        { item: "Objective", before: "None", after: objectiveLabel(b.objective) },
        { item: "Budget", before: "None", after: budget },
        { item: "Status", before: "None", after: "Created paused" },
      ];
      if (b.bid_strategy !== undefined) rows.push({ item: "Bid strategy", before: "None", after: bidLabel(b.bid_strategy) });
      if (b.special_ad_categories.length) {
        const where = b.special_ad_category_country?.length ? ` (${b.special_ad_category_country.join(", ")})` : "";
        rows.push({ item: "Special ad category", before: "None", after: b.special_ad_categories.map(categoryLabel).join(", ") + where });
      }
      return {
        title: `Create the campaign “${b.name}”`,
        change_sentence: `Zavi creates the campaign “${b.name}” (${objectiveLabel(b.objective).toLowerCase()}). It starts paused, so nothing is spent until it has ad sets and ads and is turned on.`,
        rows,
      };
    }

    case "meta_ads.update_campaign": {
      const b = parse(updateCampaignBodySchema, body);
      if (!b) return null;
      const who = quoted(b.name) ?? `campaign ${b.campaign_id}`;
      const rows: ChangeRow[] = [];
      const parts: string[] = [];
      if (b.new_name !== undefined) {
        rows.push({ item: "Name", before: b.name ?? "Current name", after: b.new_name });
        parts.push(`renames it “${b.new_name}”`);
      }
      if (b.spend_cap_usd !== undefined) {
        const was = b.expected_current_spend_cap_usd == null ? "No cap" : money(b.expected_current_spend_cap_usd, b.currency);
        const now = b.spend_cap_usd === null ? "No cap" : money(b.spend_cap_usd, b.currency);
        rows.push({ item: "Spend cap", before: was, after: now });
        parts.push(b.spend_cap_usd === null ? "removes its spend cap" : `caps its total spend at ${now}`);
      }
      if (b.bid_strategy !== undefined) {
        rows.push({ item: "Bid strategy", before: bidLabel(b.expected_current_bid_strategy ?? null), after: bidLabel(b.bid_strategy) });
        parts.push(`sets its bid strategy to ${bidLabel(b.bid_strategy).toLowerCase()}`);
      }
      if (b.special_ad_categories !== undefined) {
        const cats = b.special_ad_categories.length ? b.special_ad_categories.map(categoryLabel).join(", ") : "None";
        rows.push({ item: "Special ad category", before: "Current setting", after: cats });
        parts.push(`sets its special ad category to ${cats.toLowerCase()}`);
      }
      return {
        title: `Change ${who}`,
        change_sentence: `Zavi ${parts.join(", ")} on ${who}.`,
        rows,
      };
    }

    case "meta_ads.delete_campaign": {
      const b = parse(deleteCampaignBodySchema, body);
      if (!b) return null;
      const who = quoted(b.name) ?? `campaign ${b.campaign_id}`;
      return {
        title: `Delete ${who}`,
        change_sentence: `Zavi deletes ${who} with its ad sets and ads. It stops spending and cannot be brought back.`,
        rows: [{ item: capFirst(who), before: "Exists", after: "Deleted (cannot be undone)" }],
      };
    }

    case "meta_ads.update_ad_set": {
      const b = parse(updateAdSetBodySchema, body);
      if (!b) return null;
      const who = quoted(b.name) ?? `ad set ${b.ad_set_id}`;
      const rows: ChangeRow[] = [];
      if (b.new_name !== undefined) rows.push({ item: "Name", before: b.name ?? "Current name", after: b.new_name });
      if (b.end_time !== undefined) rows.push({ item: "End date", before: dateLabel(b.expected_current_end_time ?? null), after: dateLabel(b.end_time) });
      if (b.bid_strategy !== undefined) rows.push({ item: "Bid strategy", before: bidLabel(b.expected_current_bid_strategy ?? null), after: bidLabel(b.bid_strategy) });
      if (b.bid_amount_usd !== undefined) {
        rows.push({
          item: "Bid",
          before: b.expected_current_bid_amount_usd == null ? "None" : money(b.expected_current_bid_amount_usd, b.currency),
          after: money(b.bid_amount_usd, b.currency),
        });
      }
      for (const [k, v] of Object.entries(b.targeting_patch ?? {})) {
        rows.push({ item: TARGETING_LABELS[k] ?? k, before: "Current setting", after: targetingValueLabel(k, v) });
      }
      return {
        title: `Change ${who}`,
        change_sentence: `Zavi changes ${rows.map((r) => r.item.toLowerCase()).join(", ")} on ${who}. Everything else on it stays as it is.`,
        rows,
      };
    }

    case "meta_ads.update_ad": {
      const b = parse(updateAdBodySchema, body);
      if (!b) return null;
      const who = quoted(b.name) ?? `ad ${b.ad_id}`;
      const rows: ChangeRow[] = [];
      const parts: string[] = [];
      if (b.new_name !== undefined) {
        rows.push({ item: "Name", before: b.name ?? "Current name", after: b.new_name });
        parts.push(`renames it “${b.new_name}”`);
      }
      if (b.creative_id !== undefined) {
        rows.push({ item: "Creative", before: b.expected_current_creative_id ?? "None", after: b.creative_id });
        parts.push(`swaps it onto creative ${b.creative_id}`);
      }
      if (b.status !== undefined) {
        const off = b.status === "PAUSED";
        rows.push({ item: "Status", before: off ? "Active" : "Paused", after: off ? "Paused" : "Active" });
        parts.push(off ? "pauses it (its ad set keeps running)" : "turns it on");
      }
      return { title: `Change ${who}`, change_sentence: `Zavi ${parts.join(", ")} on ${who}.`, rows };
    }

    case "meta_ads.duplicate_ad": {
      const b = parse(duplicateAdBodySchema, body);
      if (!b) return null;
      const label = quoted(b.name) ?? `a copy of ad ${b.source_ad_id}`;
      return {
        title: `Launch ${label} in ad set ${b.ad_set_id}`,
        change_sentence: `Zavi copies ad ${b.source_ad_id} with its creative into ad set ${b.ad_set_id} and switches the copy on. It adds no budget: the ad set's budget is the spend.`,
        rows: [{ item: "Ad", before: "None", after: `${label}, on` }],
      };
    }

    case "meta_ads.create_creative": {
      const b = parse(createCreativeBodySchema, body);
      if (!b) return null;
      const media = b.image_url ? "A new image" : b.image_hash ? "An image in the account" : b.video_asset_id ? `Video ${b.video_asset_id}` : `The media of ad ${b.source_ad_id}`;
      return {
        title: `Create the creative “${b.name}”`,
        change_sentence: `Zavi adds the creative “${b.name}” to the ad account. It runs nowhere until an ad uses it.`,
        rows: [
          { item: "Creative", before: "None", after: b.name },
          { item: "Primary text", before: "None", after: b.primary_text },
          { item: "Headline", before: "None", after: b.headline },
          { item: "Button", before: "None", after: b.cta ?? "LEARN_MORE" },
          { item: "Media", before: "None", after: media },
          { item: "Link", before: "None", after: b.link_url },
        ],
      };
    }

    case "meta_ads.update_creative": {
      const b = parse(updateCreativeBodySchema, body);
      if (!b) return null;
      return {
        title: `Rename creative ${b.creative_id}`,
        change_sentence: `Zavi renames creative ${b.creative_id} “${b.new_name}”. Ads using it do not change.`,
        rows: [{ item: "Name", before: b.name ?? "Current name", after: b.new_name }],
      };
    }

    case "meta_ads.upload_asset": {
      const b = parse(uploadAssetBodySchema, body);
      if (!b) return null;
      return {
        title: `Add the ${b.kind} “${b.name}” to the ad account`,
        change_sentence: `Zavi adds the ${b.kind} “${b.name}” to the ad account's library. It runs nowhere until a creative uses it.`,
        rows: [{ item: b.kind === "image" ? "Image" : "Video", before: "None", after: b.name }],
      };
    }

    case "meta_ads.create_lookalike_audience": {
      const b = parse(createLookalikeAudienceBodySchema, body);
      if (!b) return null;
      const pct = `${Math.round(b.ratio * 100)}%`;
      return {
        title: `Build a ${pct} lookalike in ${b.country}`,
        change_sentence: `Zavi builds an audience of the ${pct} of people in ${b.country} most like audience ${b.origin_audience_id}. It spends nothing until an ad set targets it.`,
        rows: [
          { item: "Audience", before: "None", after: `${pct} lookalike, ${b.country}` },
          { item: "Based on", before: "None", after: `Audience ${b.origin_audience_id}` },
        ],
      };
    }

    case "meta_ads.create_custom_conversion": {
      const b = parse(createCustomConversionBodySchema, body);
      if (!b) return null;
      return {
        title: `Create the conversion “${b.name}”`,
        change_sentence: `Zavi counts a ${b.custom_event_type.toLowerCase().replace(/_/g, " ")} when the pixel sees a page whose address contains “${b.url_contains}”.`,
        rows: [
          { item: "Conversion", before: "None", after: b.name },
          { item: "Counts when the page contains", before: "None", after: b.url_contains },
        ],
      };
    }

    case "meta_ads.create_lead_form": {
      const b = parse(createLeadFormBodySchema, body);
      if (!b) return null;
      const page = quoted(b.page_name) ?? `Page ${b.page_id}`;
      const asks = b.questions.map((q) => ("label" in q ? q.label : q.type.toLowerCase().replace(/_/g, " "))).join(", ");
      return {
        title: `Create the lead form “${b.name}” on ${page}`,
        change_sentence: `Zavi adds a lead form to ${page} that asks for ${asks}, under your privacy policy (${b.privacy_policy_url}). Zavi never reads the leads.`,
        rows: [
          { item: "Lead form", before: "None", after: b.name },
          { item: "Asks for", before: "None", after: asks },
          { item: "Privacy policy", before: "None", after: b.privacy_policy_url },
        ],
      };
    }

    case "meta_ads.create_ad_set": {
      const b = parse(createAdSetBodySchema, body);
      if (!b) return null;
      const rows: ChangeRow[] = [
        { item: "Ad set", before: "None", after: b.name },
        { item: "Daily budget", before: "None", after: `${money(b.daily_budget_usd, b.currency)}/day` },
        { item: "Optimizing for", before: "None", after: b.optimization_goal },
        { item: "Audience", before: "None", after: targetingLabel(b.targeting) },
        { item: "Audience reach", before: "None", after: audienceModeLabel(b.targeting) },
        { item: "Status", before: "None", after: "Created paused" },
      ];
      if (b.promoted_object) {
        rows.push({ item: "Conversion event", before: "None", after: promotedEventLabel(b.promoted_object) });
      }
      const bid = b.campaign_bid_strategy !== undefined ? campaignBidRow(b) : bidRow(b.bid_strategy, b.bid_amount_usd, b.currency);
      if (bid) rows.push(bid);
      return {
        title: `Create the ad set “${b.name}”`,
        change_sentence: `Zavi creates the ad set “${b.name}” in campaign ${b.campaign_id} with a ${money(b.daily_budget_usd, b.currency)} daily budget. It starts paused, so nothing is spent until you turn it on.`,
        rows,
      };
    }

    case "meta_ads.duplicate_ad_set":
    case "meta_ads.duplicate_campaign": {
      const isSet = decisionClass === "meta_ads.duplicate_ad_set";
      const b = isSet ? parse(duplicateAdSetBodySchema, body) : parse(duplicateCampaignBodySchema, body);
      if (!b) return null;
      const sourceId = "source_ad_set_id" in b ? b.source_ad_set_id : b.source_campaign_id;
      const what = isSet ? "ad set" : "campaign";
      const label = quoted(b.name) ?? `a copy of ${what} ${sourceId}`;
      const where = b.places?.length ? b.places.map((p) => p.name ?? `${p.type} ${p.key}`).join(", ") : null;
      return {
        title: `Launch ${label} at ${money(b.daily_budget_usd, b.currency)} a day`,
        change_sentence: `Zavi copies the running ${what} ${sourceId} with its ads and switches the copy on at ${money(b.daily_budget_usd, b.currency)} a day${where ? `, shown in ${where} instead of the original's places` : ""}. Ads that are off in the original stay off.`,
        rows: [
          { item: `Copy of ${what} ${sourceId}`, before: "None", after: b.name ?? "New copy" },
          { item: "Daily budget", before: "None", after: `${money(b.daily_budget_usd, b.currency)}/day` },
          ...(where ? [{ item: "Where it shows", before: "Same as the original", after: where }] : []),
          { item: "Status", before: "None", after: "Live" },
        ],
      };
    }

    case "meta_ads.create_ad": {
      const b = parse(createAdBodySchema, body);
      if (!b) return null;
      const media = b.video_asset_id ? `Video ${b.video_asset_id}` : b.image_url ? "Image" : `From ad ${b.source_ad_id}`;
      return {
        title: `Add the ad “${b.headline}” to ad set ${b.ad_set_id}`,
        change_sentence: `Zavi adds a new ad to ad set ${b.ad_set_id} and switches it on. It adds no budget: the ad set's own budget pays for it.`,
        rows: [
          { item: "Headline", before: "None", after: b.headline },
          { item: "Primary text", before: "None", after: b.primary_text.slice(0, 200) },
          { item: "Media", before: "None", after: media },
          { item: "Link", before: "None", after: b.link_url },
          { item: "Status", before: "None", after: "Live" },
        ],
      };
    }

    case "meta_ads.launch_campaign": {
      const b = parse(launchCampaignBodySchema, body);
      if (!b) return null;
      const { campaign: c, ad_set: s, ad } = b;
      const media = ad.video_asset_id ? `Video ${ad.video_asset_id}` : ad.image_url ? "Image" : `From ad ${ad.source_ad_id}`;
      const rows: ChangeRow[] = [
        { item: "Campaign", before: "None", after: c.name },
        { item: "Objective", before: "None", after: objectiveLabel(c.objective) },
        { item: "Daily budget", before: "None", after: `${money(c.daily_budget_usd, b.currency)}/day on the campaign` },
        bidRow(c.bid_strategy, s.bid_amount_usd, b.currency) ?? { item: "Bid", before: "None", after: bidLabel(c.bid_strategy) },
        { item: "Optimizing for", before: "None", after: s.optimization_goal },
        { item: "Audience", before: "None", after: targetingLabel(s.targeting) },
        { item: "Audience reach", before: "None", after: audienceModeLabel(s.targeting) },
      ];
      if (s.promoted_object) rows.push({ item: "Conversion event", before: "None", after: promotedEventLabel(s.promoted_object) });
      if (c.special_ad_categories.length) {
        const where = c.special_ad_category_country?.length ? ` (${c.special_ad_category_country.join(", ")})` : "";
        rows.push({ item: "Special ad category", before: "None", after: c.special_ad_categories.map(categoryLabel).join(", ") + where });
      }
      rows.push(
        { item: "Headline", before: "None", after: ad.headline },
        { item: "Primary text", before: "None", after: ad.primary_text.slice(0, 200) },
        { item: "Media", before: "None", after: media },
        { item: "Link", before: "None", after: ad.link_url },
        { item: "Status", before: "None", after: "Live" },
      );
      return {
        title: `Launch the campaign “${c.name}” at ${money(c.daily_budget_usd, b.currency)} a day`,
        change_sentence: `Zavi creates the campaign “${c.name}” with one ad set and one ad, and switches it on at ${money(c.daily_budget_usd, b.currency)} a day. If any step fails, it is switched off and nothing keeps spending.`,
        rows,
      };
    }

    case "meta_ads.create_custom_audience": {
      const b = parse(createCustomAudienceBodySchema, body);
      if (!b) return null;
      return {
        title: `Build the audience of website visitors from the last ${b.retention_days} days`,
        change_sentence: `Zavi builds an audience of everyone the pixel saw on the site in the last ${b.retention_days} days, for retargeting. It spends nothing on its own.`,
        rows: [
          { item: "Audience", before: "None", after: b.name ?? `Website visitors, ${b.retention_days} days` },
          { item: "Pixel", before: "None", after: b.pixel_id ?? "The account's pixel" },
        ],
      };
    }

    default:
      return null;
  }
}

function entryNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (typeof x === "string" || typeof x === "number") return String(x);
    const o = (x ?? {}) as { name?: unknown; key?: unknown; id?: unknown; radius?: unknown; distance_unit?: unknown };
    const label = String(o.name ?? o.key ?? o.id ?? "?");
    return typeof o.radius === "number" ? `${label} +${o.radius} ${o.distance_unit ?? "mile"}` : label;
  });
}

export function targetingLabel(t: Record<string, unknown>): string {
  const parts: string[] = [];
  const shown = new Set(["geo_locations", "excluded_geo_locations", "age_min", "age_max", "genders", "interests", "custom_audiences", "excluded_custom_audiences"]);
  const g = (t.geo_locations ?? {}) as Record<string, unknown>;
  const where = [...entryNames(g.countries), ...entryNames(g.regions), ...entryNames(g.cities)];
  if (Array.isArray(g.zips) && g.zips.length) where.push(`${g.zips.length} ZIP codes`);
  const geoOther = Object.keys(g).filter((k) => !["countries", "regions", "cities", "zips"].includes(k));
  if (geoOther.length) where.push(`+ ${geoOther.join(", ")}`);
  if (where.length) parts.push(`Locations: ${where.join(", ")}`);
  const x = (t.excluded_geo_locations ?? {}) as Record<string, unknown>;
  const notWhere = [...entryNames(x.countries), ...entryNames(x.regions), ...entryNames(x.cities)];
  const xOther = Object.keys(x).filter((k) => !["countries", "regions", "cities"].includes(k));
  if (xOther.length) notWhere.push(`+ ${xOther.join(", ")}`);
  if (notWhere.length) parts.push(`Excluded locations: ${notWhere.join(", ")}`);
  if (typeof t.age_min === "number" || typeof t.age_max === "number") {
    const max = typeof t.age_max === "number" && t.age_max < 65 ? t.age_max : "65+";
    parts.push(`Ages ${t.age_min ?? 18}-${max}`);
  }
  if (Array.isArray(t.genders) && t.genders.length) {
    parts.push(t.genders.map((x) => (x === 1 ? "Men" : x === 2 ? "Women" : String(x))).join(" and "));
  }
  const clauses: string[][] = [];
  const top = entryNames(t.interests);
  if (top.length) clauses.push(top);
  if (Array.isArray(t.flexible_spec)) {
    const specs = t.flexible_spec as Array<Record<string, unknown>>;
    for (const s of specs) {
      const c = entryNames(s?.interests);
      if (c.length) clauses.push(c);
    }
    if (specs.every((s) => s && Object.keys(s).every((k) => k === "interests"))) shown.add("flexible_spec");
  }
  if (clauses.length) {
    const text =
      clauses.length === 1 ? clauses[0].join(", ") : clauses.map((c) => `(${c.join(" or ")})`).join(" and ");
    parts.push(`Interests: ${text}`);
  }
  const aud = entryNames(t.custom_audiences);
  if (aud.length) parts.push(`Audiences: ${aud.join(", ")}`);
  const excl = entryNames(t.excluded_custom_audiences);
  if (excl.length) parts.push(`Excluding: ${excl.join(", ")}`);
  shown.add("targeting_automation");
  shown.add("targeting_relaxation_types");
  const other = Object.keys(t).filter((k) => !shown.has(k));
  if (other.length) parts.push(`Other settings: ${other.join(", ")}`);
  return parts.length ? parts.join(" · ") : "No limits set (Meta's broadest audience)";
}

function promotedEventLabel(promoted: PromotedObject): string {
  const event = promoted.custom_event_type ?? null;
  const pixel = promoted.pixel_id ?? null;
  if (event && pixel) return `${event} (pixel ${pixel})`;
  return event ?? pixel ?? "Set";
}

const OBJECTIVE_LABELS: Record<string, string> = {
  OUTCOME_AWARENESS: "Awareness",
  OUTCOME_TRAFFIC: "Traffic",
  OUTCOME_ENGAGEMENT: "Engagement",
  OUTCOME_LEADS: "Leads",
  OUTCOME_APP_PROMOTION: "App promotion",
  OUTCOME_SALES: "Sales",
};
function objectiveLabel(o: string): string {
  return OBJECTIVE_LABELS[o] ?? o;
}

const CATEGORY_LABELS: Record<string, string> = {
  EMPLOYMENT: "Employment",
  HOUSING: "Housing",
  FINANCIAL_PRODUCTS_SERVICES: "Financial products",
  ISSUES_ELECTIONS_POLITICS: "Politics and elections",
};
function categoryLabel(c: string): string {
  return CATEGORY_LABELS[c] ?? c;
}

const BID_LABELS: Record<string, string> = {
  LOWEST_COST_WITHOUT_CAP: "Lowest cost",
  LOWEST_COST_WITH_BID_CAP: "Bid cap",
  COST_CAP: "Cost per result goal",
  LOWEST_COST_WITH_MIN_ROAS: "ROAS goal",
};
function bidLabel(b: string | null): string {
  return b ? BID_LABELS[b] ?? b : "None";
}

function campaignBidRow(b: {
  campaign_bid_strategy?: string;
  bid_amount_usd?: number;
  roas_floor?: number;
  bid_copied_from?: { ad_sets: number; result: string };
  currency?: string;
}): ChangeRow | null {
  const label = bidLabel(b.campaign_bid_strategy ?? null);
  const from = b.bid_copied_from
    ? b.bid_copied_from.ad_sets === 1
      ? `, copied from the campaign's ad set for ${b.bid_copied_from.result}`
      : `, picked from the campaign's ${b.bid_copied_from.ad_sets} ad sets for ${b.bid_copied_from.result}`
    : "";
  if (b.roas_floor !== undefined) return { item: "Bid", before: "None", after: `${label}, at least ${b.roas_floor}x${from}` };
  if (b.bid_amount_usd !== undefined) return { item: "Bid", before: "None", after: `${label}, ${money(b.bid_amount_usd, b.currency)}${from}` };
  return { item: "Bid", before: "None", after: `${label}, set by the campaign` };
}

function bidRow(strategy: string | undefined, amount: number | undefined, currency?: string): ChangeRow | null {
  if (strategy === undefined && amount === undefined) return null;
  const label = bidLabel(strategy ?? null);
  return { item: "Bid", before: "None", after: amount !== undefined ? `${label}, ${money(amount, currency)}` : label };
}

const TARGETING_LABELS: Record<string, string> = {
  age_min: "Minimum age",
  age_max: "Maximum age",
  genders: "Gender",
  flexible_spec: "Interests",
  custom_audiences: "Audiences",
  excluded_custom_audiences: "Excluded audiences",
  publisher_platforms: "Platforms",
  facebook_positions: "Facebook placements",
  instagram_positions: "Instagram placements",
};

function targetingValueLabel(key: string, v: unknown): string {
  if (key === "genders" && Array.isArray(v)) {
    const g = new Set(v);
    return g.has(1) && g.has(2) ? "Everyone" : g.has(1) ? "Men" : g.has(2) ? "Women" : "Everyone";
  }
  if (Array.isArray(v)) {
    const names = v.flatMap((x) => {
      if (typeof x === "string") return [x];
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        if (Array.isArray(o.interests)) return o.interests.map((i) => String((i as Record<string, unknown>)?.name ?? (i as Record<string, unknown>)?.id ?? "")).filter(Boolean);
        return [String(o.name ?? o.id ?? "")].filter(Boolean);
      }
      return [];
    });
    return names.length ? names.slice(0, 8).join(", ") + (names.length > 8 ? ` and ${names.length - 8} more` : "") : "None";
  }
  return String(v);
}

function dateLabel(iso: string | null): string {
  if (!iso) return "No end date";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : iso;
}
