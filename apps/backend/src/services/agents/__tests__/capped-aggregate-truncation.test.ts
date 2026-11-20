
import { describe, it, expect } from "vitest";
import {
  smartTruncateToolResult,
  toolResultCapBytes,
} from "@/services/agents/smart-truncate";
import { buildTotals } from "@/services/tools/_shared/totals";
import { verifyCappedAggregate } from "@/services/agents/capped-aggregate-verifier";
import type { ToolCallTrace } from "@/services/tools/types";
import { previewJson, OUTPUT_PREVIEW_BYTES } from "@/services/tools/types";

function campaignRow(i: number) {
  return {
    campaign_id: `12026038987883${1000 + i}`,
    campaign_name: `Campaign ${i} — Labor Day Promo`,
    status: "ACTIVE",
    start_time: "2026-09-03T13:06:52-0700",
    end_time: "2026-09-07T00:00:00-0700",
    spend_usd: 51.6,
    impressions: 2152,
    clicks: 130,
    ctr_percent: 6.04,
    cpc_usd: 0.4,
    cpm_usd: 23.98,
    reach: 1827,
    frequency: 1.18,
    conversions: 12,
    purchases: 3,
    sign_ups: 5,
    leads: 4,
    purchase_value_usd: 69.7,
    roas: 1.35,
    cpa_usd: 4.3,
    cost_per_booking_usd: 17.2,
  };
}

const ROWS = Array.from({ length: 21 }, (_, i) => campaignRow(i));

function metaPayload(withTotals: boolean) {
  const base: Record<string, unknown> = {
    campaigns: ROWS,
    time_range: { since: "2026-08-31", until: "2026-09-07" },
    status_filter: "ALL",
    ad_account_id: "act_1500492811682727",
  };
  if (withTotals) {
    base.totals = buildTotals(ROWS, {
      sum: ["spend_usd", "impressions", "clicks", "conversions", "purchases", "leads", "purchase_value_usd"],
      ratios: {
        roas: ["purchase_value_usd", "spend_usd"],
        cpa_usd: ["spend_usd", "conversions"],
        ctr_percent: ["clicks", "impressions"],
      },
      scope: "21 campaigns · status=ALL · 2026-08-31..2026-09-07",
      complete: true,
    });
  }
  return JSON.stringify(base);
}

describe("totals survive truncation (incident 6f80b208)", () => {
  it("reproduces the incident envelope WITHOUT totals: the page is all the model sees", () => {
    const out = JSON.parse(smartTruncateToolResult(metaPayload(false), 2048));
    expect(out._truncated).toBe(true);
    expect(out._total).toBe(21);
    expect(out.campaigns.length).toBeLessThan(21);
    expect(out.totals).toBeUndefined();

    const pageSpend = out.campaigns.reduce(
      (a: number, c: { spend_usd: number }) => a + c.spend_usd,
      0,
    );
    const realSpend = ROWS.reduce((a, c) => a + c.spend_usd, 0);
    expect(pageSpend).toBeLessThan(realSpend / 2);
  });

  it("keeps the correct account ROAS at the 2KB cap when totals are present", () => {
    const out = JSON.parse(smartTruncateToolResult(metaPayload(true), 2048));
    expect(out._truncated).toBe(true);
    expect(out._total).toBe(21);
    expect(out.campaigns.length).toBeLessThan(21);
    expect(out.totals).toBeDefined();
    expect(out.totals.entities).toBe(21);
    expect(out.totals.roas).toBe(1.35);
    expect(out.totals.spend_usd).toBeCloseTo(1083.6, 1);
    expect(out.totals.complete).toBe(true);
  });

  it("never exceeds the cap it was given", () => {
    for (const cap of [1024, 2048, 6144]) {
      const out = smartTruncateToolResult(metaPayload(true), cap);
      expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(cap);
    }
  });
});

describe("analyst_brief no longer collapses to a single elided string", () => {
  function brief(i: number) {
    const w = {
      days: 7, spend_usd: 166.23, impressions: 5652, clicks: 630,
      purchases: 0, purchase_value_usd: 0, leads: 181,
      ctr_percent: 11.15, cpc_usd: 0.26, cpa_usd: null, roas: 0,
    };
    return {
      campaign_id: `12026038987883${1000 + i}`,
      campaign_name: `Campaign ${i} — Labor Day Promo`,
      ad_set_id: null, ad_set_name: null,
      funnel_diagnosis: "leak_below_click",
      recommended_posture: "INVESTIGATE_FUNNEL",
      confidence: "adequate",
      settled_through: "2026-09-04",
      maturing_days_excluded: 3,
      settled_window: w, prior_window: w,
      notes: ["Solid CTR with cheap clicks — the ad is working.", "Zero purchases downstream: the leak is below the click."],
    };
  }
  const payload = JSON.stringify({
    briefs: Array.from({ length: 21 }, (_, i) => brief(i)),
    as_of: "2026-09-07",
  });

  it.each([2048, 4096])("keeps real brief rows and an exact total at cap %i", (cap) => {
    const out = JSON.parse(smartTruncateToolResult(payload, cap));
    expect(typeof out.briefs).not.toBe("string");
    expect(Array.isArray(out.briefs)).toBe(true);
    expect(out.briefs.length).toBeGreaterThan(0);
    expect(out._total).toBe(21);
    expect(JSON.stringify(out)).not.toContain("[elided");
  });

  it("gives analyst_brief and the ad-list tools their own budgets", () => {
    expect(toolResultCapBytes("meta_ads", "analyst_brief")).toBe(32 * 1024);
    expect(toolResultCapBytes("meta_ads", "list_campaigns")).toBe(24 * 1024);
    expect(toolResultCapBytes("google_ads", "list_ad_groups")).toBe(24 * 1024);
    expect(toolResultCapBytes("some_server", "some_tool")).toBe(16 * 1024);
  });

  it("even when fully capped it reports how many exist, instead of eliding silently", () => {
    const out = JSON.parse(smartTruncateToolResult(payload, 2048));
    expect(out._total).toBe(21);
    expect(JSON.stringify(out)).not.toContain("[elided");
  });
});

describe("capped-aggregate verifier", () => {
  const asPreview = (payload: Record<string, unknown>): string =>
    previewJson(JSON.stringify(payload), OUTPUT_PREVIEW_BYTES);

  const cappedTrace: ToolCallTrace = {
    name: "mcp__server__meta_ads__list_campaigns",
    output_preview: asPreview({ campaigns: [], _truncated: true, _returned: 2, _total: 21 }),
  } as ToolCallTrace;

  const totalsTrace: ToolCallTrace = {
    name: "mcp__server__meta_ads__list_campaigns",
    output_preview: asPreview({
      totals: { scope: "21 campaigns", entities: 21, roas: 1.35, complete: true },
      campaigns: [],
      _truncated: true, _returned: 2, _total: 21,
    }),
  } as ToolCallTrace;

  const cleanTrace: ToolCallTrace = {
    name: "mcp__server__meta_ads__list_campaigns",
    output_preview: asPreview({ campaigns: [], _total: 3 }),
  } as ToolCallTrace;

  it("reads a DOUBLY-ENCODED preview — the shape production actually stores", () => {
    expect(totalsTrace.output_preview).toContain('\\"totals\\"');
    expect(totalsTrace.output_preview).not.toContain('"totals":{');
  });

  it("hedges the exact reply from the incident", () => {
    const r = verifyCappedAggregate({
      reply: "Based on the live data pulled this run: 0x ROAS for the last 7 days.",
      toolCalls: [cappedTrace],
    });
    expect(r.hedged).toBe(true);
    expect(r.text).toContain("fraction of the account");
    expect(r.flags.capped_tools).toContain("mcp__server__meta_ads__list_campaigns");
  });

  it("does NOT hedge when the evidence carried a totals block", () => {
    const r = verifyCappedAggregate({
      reply: "Blended ROAS was 1.35x for the last 7 days across all campaigns.",
      toolCalls: [totalsTrace],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge a NAMED-ENTITY claim that also carries a time window", () => {
    const r = verifyCappedAggregate({
      reply: "The Labor Day campaign spent $166.23 in the last 7 days.",
      toolCalls: [cappedTrace],
    });
    expect(r.hedged).toBe(false);
  });

  it("still hedges 'across all campaigns' even though it says 'campaigns'", () => {
    const r = verifyCappedAggregate({
      reply: "Across all campaigns, spend was $166.23 for the last 7 days.",
      toolCalls: [cappedTrace],
    });
    expect(r.hedged).toBe(true);
  });

  it("does NOT hedge a per-campaign figure", () => {
    const r = verifyCappedAggregate({
      reply: "Labor Day spent $166.23 and recorded 0 purchases, so it sits at 0x.",
      toolCalls: [cappedTrace],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge when the model already stated the scope honestly", () => {
    const r = verifyCappedAggregate({
      reply: "Across the 2 of 21 campaigns I can see, total spend is $166.23 for the last 7 days.",
      toolCalls: [cappedTrace],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge when nothing was truncated", () => {
    const r = verifyCappedAggregate({
      reply: "Total spend was $1,084 for the last 7 days and blended ROAS was 1.35x.",
      toolCalls: [cleanTrace],
    });
    expect(r.hedged).toBe(false);
  });

  it("fires regardless of agent — it is not gated to performance-marketer", () => {
    const r = verifyCappedAggregate({
      reply: "Overall CAC is $4 and total conversions: 266.",
      toolCalls: [cappedTrace],
    });
    expect(r.hedged).toBe(true);
  });

  it("honours the explicit trace flag when the marker is absent (legacy engine)", () => {
    const legacyTrace = {
      name: "mcp__server__meta_ads__list_campaigns",
      output_preview: JSON.stringify({ campaigns: [{ spend_usd: 51.6 }] }),
      result_truncated: true,
    } as ToolCallTrace;
    const r = verifyCappedAggregate({
      reply: "Account-wide ROAS is 0x for the last 7 days.",
      toolCalls: [legacyTrace],
    });
    expect(r.hedged).toBe(true);
  });

  it("does NOT hedge when a totals block rode along on a capped result", () => {
    const r = verifyCappedAggregate({
      reply: "Blended ROAS across all campaigns was 1.35x on $1,084 total spend for the last 7 days.",
      toolCalls: [totalsTrace],
    });
    expect(r.hedged).toBe(false);
  });

  it("trusts the trace flags over the preview text", () => {
    const flagged = {
      name: "mcp__server__meta_ads__list_campaigns",
      output_preview: previewJson(JSON.stringify({ campaigns: [{ spend_usd: 51.6 }] }), OUTPUT_PREVIEW_BYTES),
      result_truncated: true,
      result_had_totals: true,
    } as ToolCallTrace;
    const r = verifyCappedAggregate({
      reply: "Overall ROAS was 1.35x for the last 7 days.",
      toolCalls: [flagged],
    });
    expect(r.hedged).toBe(false);
  });

  it("a bare plural entity noun does not suppress — only a NAMED entity does", () => {
    const r = verifyCappedAggregate({
      reply: "ROAS is 0x over the last 7 days for the campaigns running.",
      toolCalls: [cappedTrace],
    });
    expect(r.hedged).toBe(true);
  });

  it("KNOWN LIMIT: misses an account claim whose metric and number sit far apart", () => {
    const r = verifyCappedAggregate({
      reply: "Meta ROAS over the last 7 days sits at 0x across the account.",
      toolCalls: [cappedTrace],
    });
    expect(r.hedged).toBe(false);
  });

  it("ignores memory tools as evidence", () => {
    const memTrace = {
      name: "memory__search",
      output_preview: JSON.stringify({ items: [], _truncated: true }),
    } as ToolCallTrace;
    const r = verifyCappedAggregate({
      reply: "Total spend was $1,084 for the last 7 days.",
      toolCalls: [memTrace],
    });
    expect(r.hedged).toBe(false);
  });
});
