
import type { z } from "zod";
import type { BiddingSpec } from "./_decision-bodies";
import {
  addKeywordsBodySchema,
  createAdBodySchema,
  createAdGroupBodySchema,
  createCampaignBodySchema,
  googleSetStatusBodySchema,
  removeResourceBodySchema,
  updateAdGroupBodySchema,
  updateCampaignBodySchema,
  updateCampaignBudgetBodySchema,
} from "./_decision-bodies";
import { adChangeHeadline, adChangeObjectLabel } from "@zavi/shared";

export type ChangeRow = { item: string; before: string; after: string };

export type GadsChange = {
  title: string;
  change_sentence: string;
  rows: ChangeRow[];
  campaign_id: string | null;
};

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function quoted(name: string | undefined): string | null {
  return name ? `“${name}”` : null;
}

function campaignLabel(name: string | undefined, id: string | undefined): string {
  return quoted(name) ?? `campaign ${id ?? ""}`.trim();
}

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const MATCH: Record<string, string> = { EXACT: "exact", PHRASE: "phrase", BROAD: "broad" };

export function biddingLabel(b: BiddingSpec): string {
  switch (b.strategy) {
    case "TARGET_SPEND":
      return `Maximize clicks, ${b.cpc_bid_ceiling_usd !== undefined ? `max cost per click ${money(b.cpc_bid_ceiling_usd)}` : "no max cost per click"}`;
    case "MAXIMIZE_CONVERSIONS":
      return `Maximize conversions${b.target_cpa_usd !== undefined ? `, target cost per conversion ${money(b.target_cpa_usd)}` : ""}`;
    case "MAXIMIZE_CONVERSION_VALUE":
      return `Maximize conversion value${b.target_roas !== undefined ? `, target return on ad spend ${b.target_roas}×` : ""}`;
    case "MANUAL_CPC":
      return "Manual cost per click";
    case "MANUAL_CPM":
      return "Manual cost per 1,000 impressions";
    case "MANUAL_CPV":
      return "Manual cost per view";
    case "TARGET_CPM":
      return "Target cost per 1,000 impressions";
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> | null {
  const r = schema.safeParse(body);
  return r.success ? r.data : null;
}

export function gadsChangeRows(decisionClass: string, body: unknown): GadsChange | null {
  switch (decisionClass) {
    case "google_ads.update_campaign_budget":
    case "google_ads.update_campaign_budget_review": {
      const b = parse(updateCampaignBudgetBodySchema, body);
      if (!b) return null;
      const who = adChangeObjectLabel(decisionClass, body) ?? campaignLabel(b.name, b.campaign_id);
      const from = b.expected_current_daily_budget_usd;
      const to = b.daily_budget_usd;
      const verb = to > from ? "Raise" : to < from ? "Lower" : "Set";
      const monthly = Math.round(Math.abs(to - from) * 30.4);
      const effect =
        to === from
          ? ""
          : `, ${to > from ? "adding" : "cutting"} about ${money(monthly)} a month at full delivery`;
      return {
        title: adChangeHeadline(decisionClass, body) ?? `${verb} the ${who} budget to ${money(to)} a day`,
        change_sentence: `Zavi changes the daily budget of ${who} from ${money(from)} to ${money(to)}${effect}.`,
        rows: [{ item: `${capFirst(who)} daily budget`, before: `${money(from)}/day`, after: `${money(to)}/day` }],
        campaign_id: b.campaign_id,
      };
    }

    case "google_ads.set_status":
    case "google_ads.set_status_review": {
      const b = parse(googleSetStatusBodySchema, body);
      if (!b) return null;
      const noun =
        adChangeObjectLabel(decisionClass, body) ??
        quoted(b.name) ??
        (b.level === "ad" ? `ad ${b.ad_id}` : b.level === "ad_group" ? `ad group ${b.ad_group_id}` : `campaign ${b.campaign_id}`);
      const pause = b.status === "PAUSED";
      return {
        title: adChangeHeadline(decisionClass, body) ?? (pause ? `Pause ${noun}` : `Turn on ${noun}`),
        change_sentence: pause
          ? `Zavi pauses ${noun}. It stops showing ads and stops spending.`
          : `Zavi turns on ${noun}. It starts showing ads and spending.`,
        rows: [{ item: capFirst(noun), before: pause ? "Enabled" : "Paused", after: pause ? "Paused" : "Enabled" }],
        campaign_id: b.campaign_id,
      };
    }

    case "google_ads.add_keywords": {
      const b = parse(addKeywordsBodySchema, body);
      if (!b) return null;
      const where =
        b.level === "campaign" ? campaignLabel(b.name, b.campaign_id) : quoted(b.name) ?? `ad group ${b.ad_group_id}`;
      const n = b.keywords.length;
      const rows = b.keywords.map((k) => ({
        item: `${k.text} (${MATCH[k.match_type] ?? k.match_type})`,
        before: b.negative ? "Your ads can show" : "Not added",
        after: b.negative ? "Your ads stop showing" : "Added",
      }));
      return b.negative
        ? {
            title: `Block ${n} search ${n === 1 ? "term" : "terms"} in ${where}`,
            change_sentence: `Zavi adds ${n} negative ${n === 1 ? "keyword" : "keywords"} to ${where}, so ads stop showing for ${n === 1 ? "that search" : "those searches"}.`,
            rows,
            campaign_id: b.campaign_id ?? null,
          }
        : {
            title: `Add ${n} ${n === 1 ? "keyword" : "keywords"} to ${where}`,
            change_sentence: `Zavi adds ${n} ${n === 1 ? "keyword" : "keywords"} to ${where}.`,
            rows,
            campaign_id: b.campaign_id ?? null,
          };
    }

    case "google_ads.remove_resource": {
      const b = parse(removeResourceBodySchema, body);
      if (!b) return null;
      const noun =
        b.level === "keyword"
          ? b.keyword_text
            ? `keyword ${quoted(b.keyword_text)}`
            : `keyword ${b.criterion_id}`
          : (quoted(b.name) ??
            (b.level === "campaign"
              ? `campaign ${b.campaign_id}`
              : b.level === "ad_group"
                ? `ad group ${b.ad_group_id}`
                : `ad ${b.ad_id}`));
      const within = b.level === "keyword" && b.name ? ` in ${b.name}` : "";
      return {
        title: `Remove ${noun}`,
        change_sentence: `Zavi removes ${noun}${within} from Google Ads. This cannot be undone.`,
        rows: [{ item: capFirst(noun), before: "In your account", after: "Removed for good" }],
        campaign_id: b.level === "campaign" ? b.campaign_id : null,
      };
    }

    case "google_ads.update_campaign": {
      const b = parse(updateCampaignBodySchema, body);
      if (!b) return null;
      const who = campaignLabel(b.name, b.campaign_id);
      const rows: ChangeRow[] = [];
      if (b.new_name !== undefined) rows.push({ item: "Name", before: "Current setting", after: b.new_name });
      if (b.target_cpa_usd !== undefined) rows.push({ item: "Target cost per conversion", before: "Current setting", after: money(b.target_cpa_usd) });
      if (b.target_roas !== undefined) rows.push({ item: "Target return on ad spend", before: "Current setting", after: `${b.target_roas}×` });
      if (b.network !== undefined) {
        rows.push({ item: "Search partners", before: "Current setting", after: b.network.search_network ? "On" : "Off" });
        rows.push({ item: "Display network", before: "Current setting", after: b.network.content_network ? "On" : "Off" });
      }
      return {
        title: `Update the settings of ${who}`,
        change_sentence: `Zavi updates ${rows.length === 1 ? "one setting" : `${rows.length} settings`} on ${who}. Spending continues under the new settings.`,
        rows,
        campaign_id: b.campaign_id,
      };
    }

    case "google_ads.update_ad_group": {
      const b = parse(updateAdGroupBodySchema, body);
      if (!b) return null;
      const who = quoted(b.name) ?? `ad group ${b.ad_group_id}`;
      const rows: ChangeRow[] = [];
      if (b.new_name !== undefined) rows.push({ item: "Name", before: "Current setting", after: b.new_name });
      if (b.cpc_bid_usd !== undefined) rows.push({ item: "Max cost per click", before: "Current setting", after: money(b.cpc_bid_usd) });
      if (b.cpv_bid_usd !== undefined) rows.push({ item: "Max cost per view", before: "Current setting", after: money(b.cpv_bid_usd) });
      if (b.cpm_bid_usd !== undefined) rows.push({ item: "Max cost per 1,000 impressions", before: "Current setting", after: money(b.cpm_bid_usd) });
      return {
        title: `Update ${who}`,
        change_sentence: `Zavi updates ${rows.length === 1 ? "one setting" : `${rows.length} settings`} on ${who}.`,
        rows,
        campaign_id: null,
      };
    }

    case "google_ads.create_campaign": {
      const b = parse(createCampaignBodySchema, body);
      if (!b) return null;
      const rows: ChangeRow[] = [
        { item: "Campaign", before: "None", after: b.name },
        { item: "Daily budget", before: "None", after: `${money(b.daily_budget_usd)}/day` },
        { item: "Bidding", before: "None", after: biddingLabel(b.bidding) },
        ...(b.bidding_replaced
          ? [{ item: "Bidding asked for", before: biddingLabel(b.bidding_replaced), after: "Replaced: no conversions in the last 30 days" }]
          : []),
        { item: "Status", before: "None", after: "Created paused" },
      ];
      if (b.negative_keywords.length > 0) rows.push({ item: "Negative keywords", before: "None", after: String(b.negative_keywords.length) });
      if (b.excluded_location_ids.length > 0) rows.push({ item: "Excluded places", before: "None", after: String(b.excluded_location_ids.length) });
      if (b.ad_group) rows.push({ item: "First ad group", before: "None", after: b.ad_group.name });
      const dg = b.demand_gen_ad_group;
      if (dg) {
        const n = dg.ad.youtube_video_ids.length;
        rows.push(
          { item: "Type", before: "None", after: "Demand Gen (YouTube, Discover, Gmail; not Display)" },
          { item: "First ad group", before: "None", after: dg.name },
          { item: "Video ad", before: "None", after: `${n} video${n === 1 ? "" : "s"}, ready under the paused campaign` },
          { item: "Logo", before: "None", after: `square ${dg.ad.logo.width}x${dg.ad.logo.height}` },
        );
        return {
          title: `Create the YouTube campaign “${b.name}”`,
          change_sentence: `Zavi creates “${b.name}” paused with a ${money(b.daily_budget_usd)} daily budget. Nothing spends until one approved change turns the campaign on.`,
          rows,
          campaign_id: null,
        };
      }
      const pm = b.pmax_asset_group;
      if (pm) {
        const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
        const images = [
          count(pm.landscape_images.length, "landscape"),
          count(pm.square_images.length, "square"),
          ...(pm.portrait_images.length > 0 ? [count(pm.portrait_images.length, "portrait")] : []),
        ].join(", ");
        rows.push(
          { item: "Type", before: "None", after: "Performance Max" },
          { item: "Asset group", before: "None", after: pm.name },
          { item: "Images", before: "None", after: images },
          { item: "Copy", before: "None", after: `${count(pm.headlines.length, "headline")}, ${count(pm.long_headlines.length, "long headline")}, ${count(pm.descriptions.length, "description")}` },
          { item: "Brand", before: "None", after: `${pm.business_name}, square logo ${pm.logo.width}x${pm.logo.height}` },
          { item: "Landing page", before: "None", after: pm.final_urls[0] },
        );
        return {
          title: `Create the Performance Max campaign “${b.name}”`,
          change_sentence: `Zavi creates “${b.name}” paused with a ${money(b.daily_budget_usd)} daily budget and its ads ready. Nothing spends until one approved change turns the campaign on.`,
          rows,
          campaign_id: null,
        };
      }
      return {
        title: `Create the campaign “${b.name}”`,
        change_sentence: `Zavi creates “${b.name}” with a ${money(b.daily_budget_usd)} daily budget. It starts paused, so nothing is spent until you turn it on.`,
        rows,
        campaign_id: null,
      };
    }

    case "google_ads.create_ad_group": {
      const b = parse(createAdGroupBodySchema, body);
      if (!b) return null;
      const rows: ChangeRow[] = [
        { item: "Ad group", before: "None", after: b.name },
        { item: "Status", before: "None", after: "Created paused" },
      ];
      if (b.keywords.length > 0) rows.push({ item: "Keywords", before: "None", after: String(b.keywords.length) });
      if (b.ads.length > 0) rows.push({ item: "Ads", before: "None", after: String(b.ads.length) });
      return {
        title: `Create the ad group “${b.name}”`,
        change_sentence: `Zavi creates the ad group “${b.name}” in campaign ${b.campaign_id}. It starts paused.`,
        rows,
        campaign_id: b.campaign_id,
      };
    }

    case "google_ads.create_ad": {
      const b = parse(createAdBodySchema, body);
      if (!b) return null;
      const where = quoted(b.name) ?? `ad group ${b.ad_group_id}`;
      const rows: ChangeRow[] = [{ item: "New ad", before: "None", after: "Created paused" }];
      if ("headlines" in b.ad) rows.push({ item: "Headlines", before: "None", after: String(b.ad.headlines.length) });
      if ("final_urls" in b.ad && b.ad.final_urls.length > 0) rows.push({ item: "Landing page", before: "None", after: b.ad.final_urls[0] });
      return {
        title: `Add a new ad to ${where}`,
        change_sentence: `Zavi adds a new ad to ${where}. It starts paused.`,
        rows,
        campaign_id: null,
      };
    }

    default:
      return null;
  }
}
