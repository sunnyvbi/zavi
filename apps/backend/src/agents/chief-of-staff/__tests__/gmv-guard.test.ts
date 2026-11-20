import { describe, it, expect } from "vitest";
import {
  revenueDataAvailable,
  scrubUngroundedRevenue,
  scrubUngroundedRevenueProse,
  __test,
} from "../gmv-guard";

const NOT_CONNECTED = '{"ok":false,"error":"operator_db_not_connected","ready":false}';
const STRIPE_NC = '{"ok":false,"error":"stripe_not_connected"}';
const CATALOG_READY_FALSE = '{"ok":true,"data":{"ready":false,"note":"Operator DB not ready"}}';
const REAL_TX = '{"ok":true,"rows":[{"gmv_cents":9420000,"period":"wk"}]}';

describe("revenueDataAvailable", () => {
  it("false when every revenue tool returned not-connected", () => {
    expect(
      revenueDataAvailable([
        { name: "operator_db__catalog", output_preview: CATALOG_READY_FALSE, status: "ok" },
        { name: "operator_db__query_recent_transactions", output_preview: NOT_CONNECTED, status: "ok" },
        { name: "stripe__list_payouts", output_preview: STRIPE_NC, status: "ok" },
      ]),
    ).toBe(false);
  });

  it("false on the real failing-run trace (catalog ready:false + memory only, NO revenue tool called)", () => {
    expect(
      revenueDataAvailable([
        { name: "operator_db__catalog", output_preview: CATALOG_READY_FALSE, status: "ok" },
        { name: "memory__search", output_preview: '{"hits":[{"note":"take rate 14.1%"}]}', status: "ok" },
        { name: "memory__search", output_preview: '{"hits":[]}', status: "ok" },
      ]),
    ).toBe(false);
  });

  it("false when no revenue tool was called at all (tc=0)", () => {
    expect(revenueDataAvailable([])).toBe(false);
    expect(revenueDataAvailable(undefined)).toBe(false);
  });

  it("false when a revenue tool errored/threw even if name matches", () => {
    expect(
      revenueDataAvailable([
        { name: "operator_db__query_recent_transactions", output_preview: REAL_TX, status: "throw" },
      ]),
    ).toBe(false);
  });

  it("true when a revenue tool returned real data (connected tenant)", () => {
    expect(
      revenueDataAvailable([
        { name: "operator_db__query_recent_transactions", output_preview: REAL_TX, status: "ok" },
      ]),
    ).toBe(true);
  });

  it("tolerates legacy {tool_name, output} shape", () => {
    expect(
      revenueDataAvailable([{ tool_name: "stripe__list_charges", output: '{"ok":true,"data":[{"amount":1200}]}' }]),
    ).toBe(true);
  });
});

describe("scrubUngroundedRevenue — tier2 metrics", () => {
  it("replaces a tier2 GMV metric dollar with unavailable, leaves take-rate", () => {
    const digest = {
      tier2: [{ area: "liquidity", summary: "...", metrics: { gmv: "~$100K/mo", take_rate: "14.1%" } }],
      rendered_markdown: "**Liquidity/GMV:** GMV ~$100K/mo · take-rate 14.1%",
    };
    const subs = scrubUngroundedRevenue(digest);
    expect(subs).toBeGreaterThan(0);
    expect(digest.tier2[0].metrics.gmv).toBe(__test.UNAVAILABLE);
    expect(digest.tier2[0].metrics.take_rate).toBe("14.1%");
    expect(digest.rendered_markdown).toContain(__test.UNAVAILABLE);
    expect(digest.rendered_markdown).toContain("take-rate 14.1%");
    expect(digest.rendered_markdown).not.toMatch(/\$100K/);
  });

  it("matches underscore keys gmv_estimate / gmv_monthly_est (the \\b bug)", () => {
    const digest = {
      tier2: [
        { area: "growth", summary: "x", metrics: { gmv_estimate: "~$100K/mo (stale prior context)" } },
        { area: "g2", summary: "y", metrics: { gmv_monthly_est: "~$100K (unconfirmed — DB not connected)" } },
      ],
      rendered_markdown: "",
    };
    scrubUngroundedRevenue(digest);
    expect(digest.tier2[0].metrics.gmv_estimate).toBe(__test.UNAVAILABLE);
    expect(digest.tier2[1].metrics.gmv_monthly_est).toBe(__test.UNAVAILABLE);
  });

  it("scrubs hedged unverified GMV (the exact P0 shape)", () => {
    const digest = {
      tier2: [{ area: "growth", summary: "x", metrics: { gmv_estimate: "~$23K/wk (unverified)" } }],
      rendered_markdown: "**Revenue/liquidity:** Estimate ~$23K/wk (unverified — DB not connected)",
    };
    scrubUngroundedRevenue(digest);
    expect(digest.tier2[0].metrics.gmv_estimate).toBe(__test.UNAVAILABLE);
    expect(digest.rendered_markdown).not.toMatch(/\$23K/);
  });

  it("does not touch dispute amount or amount_at_risk (non-revenue keys)", () => {
    const digest = {
      tier2: [
        { area: "x", summary: "y", metrics: { open_disputes: "1 confirmed (du_1A2B, $4,200)", amount_at_risk: "$4,200" } },
      ],
      rendered_markdown: "",
    };
    const subs = scrubUngroundedRevenue(digest);
    expect(subs).toBe(0);
    expect(digest.tier2[0].metrics.open_disputes).toBe("1 confirmed (du_1A2B, $4,200)");
    expect(digest.tier2[0].metrics.amount_at_risk).toBe("$4,200");
  });

  it("does not touch take-rate-only or non-dollar metrics", () => {
    const digest = {
      tier2: [{ area: "x", summary: "y", metrics: { take_rate: "14.1%", dispute_rate: "0.9 per 100" } }],
      rendered_markdown: "take-rate 14.1% · disputes 0.9/100",
    };
    const subs = scrubUngroundedRevenue(digest);
    expect(subs).toBe(0);
    expect(digest.tier2[0].metrics.take_rate).toBe("14.1%");
  });
});

describe("scrubUngroundedRevenue — rendered_markdown", () => {
  it("scrubs the bolded **Liquidity/GMV:** metric line", () => {
    const md = "**Liquidity/GMV:** Unqueryable (DB not connected). Estimated ~$100K/mo GMV from prior context only.";
    const digest = { tier2: [], rendered_markdown: md };
    const subs = scrubUngroundedRevenue(digest);
    expect(subs).toBeGreaterThan(0);
    expect(digest.rendered_markdown).not.toMatch(/\$100K/);
    expect(digest.rendered_markdown).toContain(__test.UNAVAILABLE);
  });

  it("LEAVES the company-anchor header line untouched (parity with mkt-27)", () => {
    const header = "**Day 14+ | P2P car rental · ~600 hosts · ~$100K/mo GMV · 5 US states**";
    const digest = { tier2: [], rendered_markdown: header };
    const subs = scrubUngroundedRevenue(digest);
    expect(subs).toBe(0);
    expect(digest.rendered_markdown).toBe(header);
    expect(__test.REVENUE_METRIC_LINE_RX.test(header)).toBe(false);
  });

  it("scrubs the metric line but keeps the header in a full multi-line digest", () => {
    const md = [
      "**Day 14+ | P2P car rental · ~600 hosts · ~$100K/mo GMV · 5 US states**",
      "",
      "**Liquidity/GMV:** DB not connected (14th run). Estimates: ~$100K/mo GMV, ~600 hosts — unconfirmed.",
    ].join("\n");
    const digest = { tier2: [], rendered_markdown: md };
    scrubUngroundedRevenue(digest);
    const out = digest.rendered_markdown!.split("\n");
    expect(out[0]).toContain("~$100K/mo GMV");
    expect(out[2]).not.toMatch(/\$100K/);
    expect(out[2]).toContain(__test.UNAVAILABLE);
    expect(out[2]).toContain("~600 hosts");
  });

  it("leaves prose company-scale mentions that are NOT metric-shaped", () => {
    const digest = {
      tier2: [],
      rendered_markdown: "You're operating a ~$100K/mo marketplace — keep pushing host supply this week.",
    };
    const before = digest.rendered_markdown;
    const subs = scrubUngroundedRevenue(digest);
    expect(subs).toBe(0);
    expect(digest.rendered_markdown).toBe(before);
  });

  it("is a no-op on an empty digest", () => {
    expect(scrubUngroundedRevenue({})).toBe(0);
    expect(scrubUngroundedRevenue({ tier2: [], rendered_markdown: "" })).toBe(0);
  });
});

describe("scrubUngroundedRevenueProse — chat prose", () => {
  const U = __test.UNAVAILABLE;

  it("digest-shaped behavior is unchanged (scrubUngroundedRevenue still strips a **Revenue:** metric line)", () => {
    const digest = { rendered_markdown: "- **Revenue:** $100K/mo (est.)" };
    const subs = scrubUngroundedRevenue(digest);
    expect(subs).toBe(1);
    expect(digest.rendered_markdown).toContain(U);
  });

  it("chat PROSE: a revenue-framed $ figure with no fed-in provenance is STRIPPED", () => {
    const reply = "Your marketplace is doing well — GMV is around $100K/mo and climbing.";
    const { text, subs } = scrubUngroundedRevenueProse(reply, "");
    expect(subs).toBe(1);
    expect(text).toContain(U);
    expect(text).not.toContain("$100K");
  });

  it("chat PROSE negative: a figure the founder supplied THIS turn is PRESERVED (fed-in exemption)", () => {
    const reply = "On the $23K/wk you mentioned — that revenue puts you ahead of plan.";
    const fedIn = "we did about $23K/wk last month, is our revenue healthy?";
    const { text, subs } = scrubUngroundedRevenueProse(reply, fedIn);
    expect(subs).toBe(0);
    expect(text).toContain("$23K/wk");
    expect(text).not.toContain(U);
  });

  it("does NOT strip a non-revenue $ aside (no revenue keyword on the line)", () => {
    const reply = "Grab a $5 coffee and let's look at the dashboard.";
    const { text, subs } = scrubUngroundedRevenueProse(reply, "");
    expect(subs).toBe(0);
    expect(text).toBe(reply);
  });

  it("empty / no-money input is a no-op", () => {
    expect(scrubUngroundedRevenueProse("", "").subs).toBe(0);
    expect(scrubUngroundedRevenueProse("no numbers here about revenue at all", "").subs).toBe(0);
  });

  it("is idempotent (a second pass finds nothing to strip)", () => {
    const reply = "Revenue is roughly $50K/mo right now.";
    const first = scrubUngroundedRevenueProse(reply, "");
    expect(first.subs).toBe(1);
    const second = scrubUngroundedRevenueProse(first.text, "");
    expect(second.subs).toBe(0);
    expect(second.text).toBe(first.text);
  });
});
