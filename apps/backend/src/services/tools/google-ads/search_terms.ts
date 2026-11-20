
import { z } from "zod";
import { gadsSearch } from "./_client";
import type { ToolSpec } from "@/services/tools/types";
import { buildWaste } from "@/services/tools/_shared/waste";
import {
  CONVERSION_COLUMNS_NOTE,
  GOOGLE_CONVERSION_FIELDS,
  GOOGLE_OUTCOME_LABEL,
  GOOGLE_SECONDARY_OUTCOME,
} from "./_shared";

const MAX_ROWS = 5_000;

const MAX_SAMPLE = 120;

const MAX_NGRAMS = 40;

const MAX_KEYWORDS = 40;
const TERMS_PER_KEYWORD = 3;

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "is",
  "are", "was", "were", "be", "with", "my", "me", "i", "you", "your", "it",
]);

const inputSchema = z.object({
  date_range: z
    .enum(["LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"])
    .default("LAST_30_DAYS"),
  custom_range: z
    .object({
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
  campaign_id: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  ad_group_id: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  brand_terms: z.array(z.string().min(1).max(80)).max(40).optional(),
  skip_keyword_enrichment: z.boolean().default(false),
});

type CampaignTermRow = {
  campaignSearchTermView?: { searchTerm?: string };
  campaign?: { id?: string; name?: string; advertisingChannelType?: string };
  metrics?: {
    costMicros?: string;
    clicks?: string;
    impressions?: string;
    conversions?: string;
    allConversions?: string;
    conversionsValue?: string;
  };
};

type EnrichRow = {
  searchTermView?: { searchTerm?: string; status?: string };
  campaign?: { id?: string; name?: string };
  adGroup?: { id?: string; name?: string };
  segments?: {
    keyword?: { adGroupCriterion?: string; info?: { text?: string; matchType?: string } };
    searchTermMatchType?: string;
  };
  metrics?: {
    costMicros?: string;
    clicks?: string;
    impressions?: string;
    conversions?: string;
    allConversions?: string;
  };
};

type KeywordView = {
  keyword: string;
  match_type: string | null;
  campaign_id: string;
  ad_group_id: string | null;
  ad_group_name: string | null;
  criterion_id: string | null;
  cost: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  conversions: number;
  all_conversions: number;
  top_terms: Array<{ term: string; cost: number; clicks: number; conversions: number; all_conversions: number }>;
};

type Term = {
  search_term: string;
  campaign_id: string;
  campaign_name: string;
  campaign_channel_type: string;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  all_conversions: number;
  conversions_value: number;
  ctr: number | null;
  cpc: number | null;
  matched_keyword: string | null;
  keyword_match_type: string | null;
  search_term_match_type: string | null;
  ad_group_name: string | null;
  targeting_status: string | null;
  ad_groups_matched: number | null;
};

type Totals = {
  terms: number;
  cost: number;
  clicks: number;
  conversions: number;
  all_conversions: number;
  conversions_value: number;
  cpa: number | null;
  roas: number | null;
};

export const searchTermsTool: ToolSpec = {
  name: "google_ads_search_terms",
  effect: "read",
  description:
    "Read the Google Ads search-terms report: the actual queries people typed that triggered ads, with cost, clicks and conversions. Covers BOTH Search and Performance Max campaigns (campaign grain), and additionally attaches the matched keyword and match type for Search campaigns (ad-group grain). Returns deterministic aggregates computed over every fetched row — total wasted spend (cost on terms with zero conversions), a brand vs non-brand split when brand_terms is supplied, cost rolled up by 1-gram and 2-gram, and a per-campaign-type breakdown — plus a cost-ranked sample of individual terms. Throws google_ads_not_connected if OAuth is not wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { date_range, custom_range, campaign_id, ad_group_id, brand_terms, skip_keyword_enrichment } =
      inputSchema.parse(input);

    const dateClause = custom_range
      ? `segments.date BETWEEN '${custom_range.since}' AND '${custom_range.until}'`
      : `segments.date DURING ${date_range}`;
    const campaignClause = campaign_id ? `AND campaign.id = ${campaign_id}` : "";
    const adGroupClause = ad_group_id ? `AND ad_group.id = ${ad_group_id}` : "";

    const spineQuery = `
      SELECT
        campaign_search_term_view.search_term,
        campaign.id,
        campaign.name,
        campaign.advertising_channel_type,
        metrics.cost_micros,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions,
        metrics.all_conversions,
        metrics.conversions_value
      FROM campaign_search_term_view
      WHERE ${dateClause}
      ${campaignClause}
      ORDER BY metrics.cost_micros DESC
      LIMIT ${MAX_ROWS}
    `;

    const spineRows = (await gadsSearch(ctx.tenant_id, spineQuery)) as CampaignTermRow[];

    let currency_code: string | null = null;
    try {
      const cur = (await gadsSearch(
        ctx.tenant_id,
        "SELECT customer.currency_code FROM customer LIMIT 1",
      )) as Array<{ customer?: { currencyCode?: string } }>;
      currency_code = cur[0]?.customer?.currencyCode ?? null;
    } catch {
      currency_code = null;
    }

    const terms: Term[] = spineRows.map((r) => withRates({
      search_term: r.campaignSearchTermView?.searchTerm ?? "",
      campaign_id: r.campaign?.id ?? "",
      campaign_name: r.campaign?.name ?? "",
      campaign_channel_type: r.campaign?.advertisingChannelType ?? "",
      cost: Number(r.metrics?.costMicros ?? 0) / 1_000_000,
      clicks: Number(r.metrics?.clicks ?? 0),
      impressions: Number(r.metrics?.impressions ?? 0),
      conversions: Number(r.metrics?.conversions ?? 0),
      all_conversions: Number(r.metrics?.allConversions ?? 0),
      conversions_value: Number(r.metrics?.conversionsValue ?? 0),
      matched_keyword: null,
      keyword_match_type: null,
      search_term_match_type: null,
      ad_group_name: null,
      targeting_status: null,
      ad_groups_matched: null,
      ctr: null,
      cpc: null,
    }));

    let enrichment_status: string;
    let enriched_count = 0;
    let by_keyword: KeywordView[] | null = null;
    if (skip_keyword_enrichment) {
      enrichment_status = "skipped_by_caller";
    } else {
      try {
        const enrichQuery = `
          SELECT
            search_term_view.search_term,
            search_term_view.status,
            campaign.id,
            ad_group.id,
            ad_group.name,
            segments.keyword.ad_group_criterion,
            segments.keyword.info.text,
            segments.keyword.info.match_type,
            segments.search_term_match_type,
            metrics.cost_micros,
            metrics.clicks,
            metrics.impressions,
            metrics.conversions,
            metrics.all_conversions
          FROM search_term_view
          WHERE ${dateClause}
          ${campaignClause}
          ${adGroupClause}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${MAX_ROWS}
        `;
        const enrichRows = (await gadsSearch(ctx.tenant_id, enrichQuery)) as EnrichRow[];
        const byKey = new Map<string, EnrichRow>();
        const matchCount = new Map<string, number>();
        for (const e of enrichRows) {
          const key = joinKey(e.campaign?.id ?? "", e.searchTermView?.searchTerm ?? "");
          matchCount.set(key, (matchCount.get(key) ?? 0) + 1);
          if (!byKey.has(key)) byKey.set(key, e);
        }
        for (const t of terms) {
          const hit = byKey.get(joinKey(t.campaign_id, t.search_term));
          if (!hit) continue;
          t.matched_keyword = hit.segments?.keyword?.info?.text ?? null;
          t.keyword_match_type = hit.segments?.keyword?.info?.matchType ?? null;
          t.search_term_match_type = hit.segments?.searchTermMatchType ?? null;
          t.ad_group_name = hit.adGroup?.name ?? null;
          t.targeting_status = hit.searchTermView?.status ?? null;
          t.ad_groups_matched = matchCount.get(joinKey(t.campaign_id, t.search_term)) ?? 1;
          enriched_count += 1;
        }
        by_keyword = keywordView(enrichRows);
        enrichment_status = "ok";
      } catch (e) {
        enrichment_status = `unavailable: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    const brandMatcher = buildBrandMatcher(brand_terms);
    const brandRows = brandMatcher ? terms.filter((t) => brandMatcher(t.search_term)) : [];
    const nonBrandRows = brandMatcher ? terms.filter((t) => !brandMatcher(t.search_term)) : [];

    const zeroConv = terms.filter((t) => t.conversions === 0 && t.cost > 0);
    zeroConv.sort((a, b) => b.cost - a.cost);

    return {
      window: custom_range ? `${custom_range.since}..${custom_range.until}` : date_range,
      currency_code,
      currency_note:
        currency_code === null
          ? "The account's currency could not be read. Every cost below is in the ACCOUNT's currency — do NOT write a dollar sign in front of it; say 'in the account currency' instead."
          : `All cost and value figures are in ${currency_code}, the account's own currency. Google reports cost in account-currency micros, never USD.`,
      grain:
        "Campaign grain (campaign_search_term_view), which is what makes Performance Max visible here. Keyword and ad-group fields come from the Search-only search_term_view and are null on Performance Max rows BY CONSTRUCTION — a null matched_keyword never means the term matched no keyword.",
      row_count: terms.length,
      truncated: terms.length >= MAX_ROWS,
      truncation_note:
        terms.length >= MAX_ROWS
          ? `Only the ${MAX_ROWS} highest-cost search terms in this window were read. Every total below covers those rows only and understates the long tail.`
          : null,
      enrichment: {
        status: enrichment_status,
        enriched_rows: enriched_count,
        note:
          "Search-only. Performance Max rows are never enriched. If status is not 'ok', keyword detail is missing but every aggregate below is still complete. Where ad_groups_matched is greater than 1, the keyword and ad-group fields describe the highest-cost match only.",
      },
      conversion_columns: CONVERSION_COLUMNS_NOTE,
      totals: totalsOf(terms),
      by_campaign_type: byCampaignType(terms),
      brand_split: brandMatcher
        ? {
            brand_terms_used: brand_terms,
            brand: totalsOf(brandRows),
            non_brand: totalsOf(nonBrandRows),
            note:
              "Classified by whole-word match of the supplied brand tokens against the search term. Non-brand CPA/ROAS is the honest read of what paid acquisition is actually buying; a blended figure carried by brand queries flatters the account.",
          }
        : null,
      waste: buildWaste(terms, {
        labelFields: ["search_term"],
        spendField: "cost",
        conversionFields: GOOGLE_CONVERSION_FIELDS,
        secondaryField: GOOGLE_SECONDARY_OUTCOME,
        outcomeLabel: GOOGLE_OUTCOME_LABEL,
        window: custom_range ? `${custom_range.since}..${custom_range.until}` : date_range,
        entity: "search terms",
        complete: terms.length < MAX_ROWS,
        currency: currency_code ?? "account currency",
      }),
      zero_conversion: {
        term_count: zeroConv.length,
        cost: round2(zeroConv.reduce((a, t) => a + t.cost, 0)),
        clicks: zeroConv.reduce((a, t) => a + t.clicks, 0),
        note:
          "Cost on search terms with zero `conversions` (the column the account bids on) in this window; a term with all_conversions only is still here, as that column also counts page views, unless the founder counts that action. Zero conversions is NOT proof a term is worthless — a long sales cycle, a lagging conversion window, or a broken conversion action all produce this shape — so read it against the tracking findings before negating anything.",
        top_terms: zeroConv.slice(0, MAX_SAMPLE).map(presentable),
      },
      ngrams: {
        note:
          "Cost and conversions summed across every fetched term containing the gram. A single query is rarely legible on its own; a gram is where waste shows up. Grams overlap, so these do NOT sum to the totals above.",
        one_gram: ngramRollup(terms, 1),
        two_gram: ngramRollup(terms, 2),
      },
      by_keyword,
      by_keyword_note:
        "Search keywords only, cost-ranked, from the ad-group-grain read; each carries its own spend, CTR, CPC and both conversion columns, and the three costliest search terms it matched. Judge keep / pause / exclude per keyword on these rows. Null means the keyword read did not run.",
      terms_sample: terms.slice(0, MAX_SAMPLE).map(presentable),
      terms_sample_note: `Cost-ranked sample of ${Math.min(terms.length, MAX_SAMPLE)} of ${terms.length} terms. Aggregates above cover all ${terms.length}.`,
      coverage_note:
        "Covers Search, Shopping and Performance Max. Demand Gen and video campaigns do not report search terms at all, so absence of a campaign from these rows is not evidence it has no wasted spend.",
    };
  },
};

function joinKey(campaignId: string, term: string): string {
  return `${campaignId} ${term.trim().toLowerCase()}`;
}

function totalsOf(rows: readonly Term[]): Totals {
  const cost = rows.reduce((a, t) => a + t.cost, 0);
  const conv = rows.reduce((a, t) => a + t.conversions, 0);
  const value = rows.reduce((a, t) => a + t.conversions_value, 0);
  return {
    terms: rows.length,
    cost: round2(cost),
    clicks: rows.reduce((a, t) => a + t.clicks, 0),
    conversions: round2(conv),
    all_conversions: round2(rows.reduce((a, t) => a + t.all_conversions, 0)),
    conversions_value: round2(value),
    cpa: conv > 0 ? round2(cost / conv) : null,
    roas: cost > 0 ? round2(value / cost) : null,
  };
}

function rate(n: number, d: number, digits: number): number | null {
  if (d <= 0) return null;
  const f = 10 ** digits;
  return Math.round((n / d) * f) / f;
}

function withRates(t: Term): Term {
  return { ...t, ctr: rate(t.clicks, t.impressions, 4), cpc: rate(t.cost, t.clicks, 2) };
}

function keywordView(rows: readonly EnrichRow[]): KeywordView[] {
  type Acc = Omit<KeywordView, "ctr" | "cpc" | "top_terms"> & { terms: KeywordView["top_terms"] };
  const acc = new Map<string, Acc>();
  for (const e of rows) {
    const text = e.segments?.keyword?.info?.text;
    if (!text) continue;
    const criterion = e.segments?.keyword?.adGroupCriterion ?? null;
    const key = criterion ?? `${e.campaign?.id ?? ""}|${e.adGroup?.id ?? ""}|${text}|${e.segments?.keyword?.info?.matchType ?? ""}`;
    let k = acc.get(key);
    if (!k) {
      k = {
        keyword: text,
        match_type: e.segments?.keyword?.info?.matchType ?? null,
        campaign_id: e.campaign?.id ?? "",
        ad_group_id: e.adGroup?.id ?? null,
        ad_group_name: e.adGroup?.name ?? null,
        criterion_id: criterion ? (criterion.split("~").at(-1) ?? null) : null,
        cost: 0, impressions: 0, clicks: 0, conversions: 0, all_conversions: 0,
        terms: [],
      };
      acc.set(key, k);
    }
    const cost = Number(e.metrics?.costMicros ?? 0) / 1_000_000;
    const clicks = Number(e.metrics?.clicks ?? 0);
    const conversions = Number(e.metrics?.conversions ?? 0);
    const all_conversions = Number(e.metrics?.allConversions ?? 0);
    k.cost += cost;
    k.impressions += Number(e.metrics?.impressions ?? 0);
    k.clicks += clicks;
    k.conversions += conversions;
    k.all_conversions += all_conversions;
    k.terms.push({ term: e.searchTermView?.searchTerm ?? "", cost, clicks, conversions, all_conversions });
  }
  return [...acc.values()]
    .sort((a, b) => b.cost - a.cost)
    .slice(0, MAX_KEYWORDS)
    .map(({ terms, ...k }) => ({
      ...k,
      cost: round2(k.cost),
      conversions: round2(k.conversions),
      all_conversions: round2(k.all_conversions),
      ctr: rate(k.clicks, k.impressions, 4),
      cpc: rate(k.cost, k.clicks, 2),
      top_terms: [...terms]
        .sort((a, b) => b.cost - a.cost)
        .slice(0, TERMS_PER_KEYWORD)
        .map((t) => ({ ...t, cost: round2(t.cost), conversions: round2(t.conversions), all_conversions: round2(t.all_conversions) })),
    }));
}

function presentable(t: Term) {
  return { ...t, cost: round2(t.cost), conversions_value: round2(t.conversions_value) };
}

function byCampaignType(rows: readonly Term[]): Array<{ channel_type: string } & Totals> {
  const acc = new Map<string, Term[]>();
  for (const t of rows) {
    const k = t.campaign_channel_type || "UNKNOWN";
    const cur = acc.get(k);
    if (cur) cur.push(t);
    else acc.set(k, [t]);
  }
  return [...acc.entries()]
    .map(([channel_type, group]) => ({ channel_type, ...totalsOf(group) }))
    .sort((a, b) => b.cost - a.cost);
}

function buildBrandMatcher(
  brandTerms: readonly string[] | undefined,
): ((term: string) => boolean) | null {
  if (!brandTerms || brandTerms.length === 0) return null;
  const phrases = brandTerms.map((b) => tokenize(b)).filter((toks) => toks.length > 0);
  if (phrases.length === 0) return null;
  return (term: string) => {
    const toks = tokenize(term);
    return phrases.some((phrase) => containsSequence(toks, phrase));
  };
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

type Ngram = {
  gram: string;
  terms: number;
  cost: number;
  clicks: number;
  conversions: number;
  cpa: number | null;
};

function ngramRollup(terms: readonly Term[], n: number): Ngram[] {
  const acc = new Map<string, { terms: number; cost: number; clicks: number; conv: number }>();
  for (const t of terms) {
    const toks = tokenize(t.search_term);
    const seen = new Set<string>();
    for (let i = 0; i + n <= toks.length; i++) {
      const window = toks.slice(i, i + n);
      if (window.every((w) => STOP_WORDS.has(w))) continue;
      const gram = window.join(" ");
      if (seen.has(gram)) continue;
      seen.add(gram);
      const cur = acc.get(gram) ?? { terms: 0, cost: 0, clicks: 0, conv: 0 };
      cur.terms += 1;
      cur.cost += t.cost;
      cur.clicks += t.clicks;
      cur.conv += t.conversions;
      acc.set(gram, cur);
    }
  }
  return [...acc.entries()]
    .map(([gram, v]) => ({
      gram,
      terms: v.terms,
      cost: round2(v.cost),
      clicks: v.clicks,
      conversions: round2(v.conv),
      cpa: v.conv > 0 ? round2(v.cost / v.conv) : null,
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, MAX_NGRAMS);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
