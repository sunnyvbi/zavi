
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const platformSecret = vi.fn();
const tenantSlugRow = vi.fn();
const creationRows = vi.fn();
const funding = vi.hoisted(() => vi.fn());
const planning = vi.hoisted(() => ({ read: vi.fn(), remaining: vi.fn(), ask: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) }));
vi.mock("@/services/approvals/approval-envelope", () => ({ founderAskFor: (...a: unknown[]) => planning.ask(...a) }));
vi.mock("@/services/channels/chatgpt-ads/proposal-readiness", () => ({ readProposalReadiness: planning.read }));
vi.mock("@/services/channels/chatgpt-ads/wallet-request", () => ({ remainingWalletRequest: planning.remaining }));
vi.mock("@/services/ads-wallet/funding-context", () => ({ readFundingContext: funding }));

vi.mock("@/services/tenant-client", () => ({
  platformSecretRpc: (...args: unknown[]) => platformSecret(...args),
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: (table: string) => table === "channel_actions" ? {
      select: () => {
        const q = { eq: () => q, order: () => q, limit: () => creationRows() };
        return q;
      },
    } : {
      select: () => ({ eq: () => ({ maybeSingle: () => tenantSlugRow() }) }),
    },
  }),
}));

import { chatgptAdsReadPerformanceTool, confirmsRequestedPeriod, readChatgptPerformance } from "../read_performance";
import type { ChatgptAdsInsightRow } from "@/services/connectors/chatgpt-ads/client";
import { readChatgptEvidence } from "@/services/growth/cgo-evidence";
import { __resetChatgptAdsKeyCacheForTests } from "@/services/connectors/chatgpt-ads/key-provider";
import { ExpectedToolError } from "@/services/tools/types";

const ctx = { tenant_id: "t-1", log: () => {} };

const ACCOUNT = [
  { id: "c-acme-1", name: "zv-acme--spring-search", status: "active" },
  { id: "c-acme-2", name: "ZV-Acme--Holiday", status: "paused" },
  { id: "c-labs-1", name: "zv-acme-labs--launch", status: "active" },
  { id: "c-globex-1", name: "zv-globex--always-on", status: "active" },
  { id: "c-loose-1", name: "house account brand test", status: "active" },
  { id: "c-loose-2", name: "", status: "active" },
];

const INSIGHTS: Record<string, Record<string, unknown>> = {
  "c-acme-1": { impressions: 1000, clicks: 40, spend: 20, ctr: 0.04, cpc: 0.5, readable_time: "Sep 1 to Sep 14" },
  "c-acme-2": { impressions: 500, clicks: 10, spend: 5, ctr: 0.02, cpc: 0.5, readable_time: "Sep 1 to Sep 14" },
  "c-labs-1": { impressions: 999999, clicks: 9999, spend: 7777, ctr: 0.9, cpc: 9, readable_time: "Sep 1 to Sep 14" },
  "c-globex-1": { impressions: 123456, clicks: 1234, spend: 4321, ctr: 0.5, cpc: 3, readable_time: "Sep 1 to Sep 14" },
};

const CONVERSIONS: Record<string, Record<string, unknown>> = {
  "c-acme-1": { entity_id: "c-acme-1", conversions: 5, click_through_conversions: 4, view_through_conversions: 1 },
  "c-acme-2": { entity_id: "c-acme-2", conversions: 1, click_through_conversions: 1, view_through_conversions: 0 },
  "c-labs-1": { entity_id: "c-labs-1", conversions: 900, click_through_conversions: 900, view_through_conversions: 0 },
};

type FetchOverride = (url: string, init?: RequestInit) => Response | undefined;

function installFetch(override?: FetchOverride) {
  const fake = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const forced = override?.(url, init);
    if (forced) return forced;
    if (url.endsWith("/ad_account")) return json({ timezone: "America/Los_Angeles", currency_code: "USD" });

    if (url.includes("/campaigns/") && url.includes("/insights")) {
      const id = url.split("/campaigns/")[1].split("/")[0];
      const row = INSIGHTS[decodeURIComponent(id)];
      return json({ object: "list", data: row ? [row] : [] });
    }
    if (url.includes("/conversions/insights")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { entity_ids?: string[] };
      const data = (body.entity_ids ?? []).map((id) => CONVERSIONS[id]).filter(Boolean);
      return json({ object: "list", data, count: data.length });
    }
    if (url.includes("/campaigns")) {
      return json({ object: "list", data: ACCOUNT, first_id: null, last_id: null, has_more: false });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fake);
  return fake;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  creationRows.mockResolvedValue({ data: [], error: null });
  planning.read.mockResolvedValue({ status: "read", complete: true, open_proposals: [], wallet_daily_plan: null });
  planning.remaining.mockResolvedValue(false);
  funding.mockResolvedValue({ status: "unavailable", reason: "Funding unavailable" });
  __resetChatgptAdsKeyCacheForTests();
  platformSecret.mockResolvedValue({ data: "sk-ads-platform", error: null });
  tenantSlugRow.mockResolvedValue({ data: { slug: "acme" }, error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type Report = {
  proposal_readiness: Awaited<ReturnType<typeof import("@/services/channels/chatgpt-ads/proposal-readiness").readProposalReadiness>>;
  requested_budget?: { top_up_authorized: boolean; next_step: string };
  zavi_ads_wallet?: unknown;
  no_campaigns_for_tenant?: boolean;
  campaign_name_prefix?: string;
  message?: string;
  campaigns?: Array<Record<string, unknown>>;
  totals_across_your_campaigns_only?: Record<string, number>;
  period?: { days: number };
};

const run = (input: unknown = {}) =>
  chatgptAdsReadPerformanceTool.execute(ctx, input) as Promise<Report>;

it("reads the current tenant wallet on demand even for a handoff without recipe context", async () => {
  installFetch();
  const snapshot = { status: "read", currency: "USD", balance_cents: 16882, reserved_cents: 2500, available_cents: 14382, auto_refill_enabled: false, read_at: "2026-10-15T14:30:00Z", activation: "requires_campaign_review_and_reservation" };
  funding.mockResolvedValue(snapshot);
  const result = await run();
  expect(funding).toHaveBeenCalledOnce();
  expect(funding).toHaveBeenCalledWith("t-1");
  expect(result.zavi_ads_wallet).toEqual(snapshot);
  expect(result.campaigns?.map(c => c.id)).toEqual(["c-acme-1", "c-acme-2"]);
  funding.mockResolvedValue({ ...snapshot, available_cents: 11882, reserved_cents: 5000 });
  expect((await run()).zavi_ads_wallet).toMatchObject({ available_cents: 11882, reserved_cents: 5000 });
});

it("keeps wallet read failures unknown while returning verified campaign data", async () => {
  installFetch();
  const result = await run();
  expect(result.zavi_ads_wallet).toEqual({ status: "unavailable", reason: "Funding unavailable" });
  expect(result.campaigns).toHaveLength(2);
});

it("includes funding for a workspace with no campaigns yet", async () => {
  installFetch(url => url.includes("/campaigns") ? json({ data: [], has_more: false }) : undefined);
  const snapshot = { status: "read", currency: "USD", balance_cents: 17500, reserved_cents: 0, available_cents: 17500, auto_refill_enabled: false, read_at: "2026-10-15T14:30:00Z", activation: "requires_campaign_review_and_reservation" };
  funding.mockResolvedValue(snapshot);
  const result = await run();
  expect(result.no_campaigns_for_tenant).toBe(true);
  expect(result.zavi_ads_wallet).toEqual(snapshot);
});

describe("cross-tenant isolation in a shared ad account", () => {
  it("keeps inactive days in the verified window before passing metrics to Growth", async () => {
    installFetch(url => {
      if (!url.includes("/campaigns/") || !url.includes("/insights")) return;
      const u = new URL(url);
      const id = decodeURIComponent(u.pathname.split("/campaigns/")[1].split("/")[0]);
      const expanded = u.searchParams.getAll("includes[]").includes("zero_impression_items");
      return json({ data: [{ ...INSIGHTS[id], campaign_id: id,
        start_time: Date.parse("2026-10-01T07:00:00Z") / 1000,
        end_time: Date.parse(expanded ? "2026-10-08T07:00:00Z" : "2026-10-04T07:00:00Z") / 1000,
      }] });
    });
    const result = await readChatgptEvidence("t-1", new Date("2026-10-08T12:00:00Z"));
    expect(result.campaigns?.[0].ad_sets[0].spend_7d_usd).toBe(20);
    expect(result.reason).not.toContain("Unconfirmed-period");
  });

  it("flags a shorter returned interval even when it contains readable dates", async () => {
    installFetch(url => {
      if (!url.includes("/campaigns/") || !url.includes("/insights")) return;
      return json({ data: [{ spend: 20, readable_time: "Partial interval",
        start_time: Date.parse("2026-10-01T07:00:00Z") / 1000,
        end_time: Date.parse("2026-10-04T07:00:00Z") / 1000,
      }] });
    });
    const out = await readChatgptPerformance("t-1", 7, undefined, new Date("2026-10-08T12:00:00Z"));
    expect("campaigns" in out).toBe(true);
    if (!("campaigns" in out)) throw new Error("Expected owned campaigns");
    expect(out.campaigns?.[0]).toMatchObject({ requested_period_confirmed: false, period_unconfirmed: true });
    expect(out).toHaveProperty("period_unconfirmed", true);
  });
  it("passes only owned, period-verified metrics through the real reader into CGO", async () => {
    installFetch(url => {
      if (url.includes("/campaigns/") && url.includes("/insights")) {
        const id = url.split("/campaigns/")[1].split("/")[0];
        return json({ data: [{ ...INSIGHTS[id], campaign_id: id,
          start_time: Date.parse("2026-10-01T07:00:00Z") / 1000,
          end_time: Date.parse("2026-10-08T07:00:00Z") / 1000,
          timezone: "America/Los_Angeles" }] });
      }
    });
    const result = await readChatgptEvidence("t-1", new Date("2026-10-08T12:00:00Z"));
    expect(result.status).toBe("read");
    expect(result.campaigns?.map(c => c.id)).toEqual(["c-acme-1", "c-acme-2"]);
    expect(result.campaigns?.[0].ad_sets[0].spend_7d_usd).toBe(20);
    expect(result.period).toMatchObject({ from: "2026-10-01", to: "2026-10-07", timezone: "America/Los_Angeles" });
    expect(JSON.stringify(result)).not.toMatch(/c-labs|globex|7777|4321/);
  });

  it("does not pass an unrelated human date label off as seven-day CGO performance", async () => {
    installFetch();
    const result = await readChatgptEvidence("t-1", new Date("2026-10-08T12:00:00Z"));
    expect(result.campaigns?.[0].ad_sets[0].spend_7d_usd).toBeNull();
    expect(result.campaigns?.[0].delivery_state).toBe("active_unverified");
  });
  it("returns ONLY this tenant's campaigns, never another advertiser's", async () => {
    installFetch();
    const out = await run();
    expect(out.campaigns?.map((c) => c.id)).toEqual(["c-acme-1", "c-acme-2"]);
    const serialized = JSON.stringify(out);
    for (const foreign of ["c-labs-1", "c-globex-1", "acme-labs", "globex", "house account"]) {
      expect(serialized, `leaked ${foreign}`).not.toContain(foreign);
    }
  });

  it("a slug that is a PREFIX of another slug sees none of that other tenant", async () => {
    installFetch();
    const out = await run();
    expect(out.campaigns?.map((c) => c.id)).not.toContain("c-labs-1");
    expect(out.totals_across_your_campaigns_only?.spend).toBe(25);
  });

  it("and the longer slug sees only ITS own campaign, not the shorter tenant's", async () => {
    tenantSlugRow.mockResolvedValue({ data: { slug: "acme-labs" }, error: null });
    installFetch();
    const out = await run();
    expect(out.campaigns?.map((c) => c.id)).toEqual(["c-labs-1"]);
    expect(JSON.stringify(out)).not.toContain("c-acme-1");
  });

  it("an unprefixed or unnamed campaign belongs to nobody, including the account owner", async () => {
    installFetch();
    const out = await run();
    const ids = out.campaigns?.map((c) => c.id) ?? [];
    expect(ids).not.toContain("c-loose-1");
    expect(ids).not.toContain("c-loose-2");
  });

  it("totals are the sum over the filtered set ONLY, never the account", async () => {
    installFetch();
    const out = await run();
    const totals = out.totals_across_your_campaigns_only!;
    expect(totals).toEqual({
      impressions: 1500,
      clicks: 50,
      spend: 25,
      conversions: 6,
      click_through_conversions: 5,
      view_through_conversions: 1,
    });
  });

  it("drops a conversion row the API returns for a campaign we did not ask about", async () => {
    installFetch((url) => {
      if (!url.includes("/conversions/insights")) return undefined;
      return json({
        object: "list",
        count: 2,
        data: [CONVERSIONS["c-acme-1"], CONVERSIONS["c-labs-1"]],
      });
    });
    const out = await run();
    expect(out.campaigns?.find((c) => c.id === "c-acme-1")?.conversions).toBe(5);
    expect(out.totals_across_your_campaigns_only?.conversions).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("900");
  });

  it("takes no tenant argument, so a model cannot ask for another tenant's data", async () => {
    installFetch();
    const shape = chatgptAdsReadPerformanceTool.input_schema;
    const parsed = shape.parse({ tenant_id: "someone-else", tenant_slug: "globex", days: 7 });
    expect(parsed).toEqual({ days: 7 });
    const out = await run({ tenant_id: "someone-else", tenant_slug: "globex" });
    expect(out.campaigns?.map((c) => c.id)).toEqual(["c-acme-1", "c-acme-2"]);
  });

  it("refuses to read anything when the workspace has no usable slug", async () => {
    tenantSlugRow.mockResolvedValue({ data: { slug: "" }, error: null });
    const fake = installFetch();
    await expect(run()).rejects.toMatchObject({ code: "chatgpt_ads_tenant_prefix_unavailable" });
    expect(fake).not.toHaveBeenCalled();
  });
});

describe("the four different nothings", () => {
  it("no matching campaign returns an explicit signal, not an empty object and not zeros", async () => {
    tenantSlugRow.mockResolvedValue({ data: { slug: "newco" }, error: null });
    installFetch();
    const out = await run();
    expect(out.no_campaigns_for_tenant).toBe(true);
    expect(out.campaign_name_prefix).toBe("zv-newco--");
    expect(out.message).toMatch(/No ChatGPT ad campaigns were returned/i);
    expect(out.campaigns).toBeUndefined();
    expect(out.totals_across_your_campaigns_only).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/"(impressions|clicks|spend)":\s*0/);
  });

  it("a missing platform key is a typed not-configured error, never zeros", async () => {
    platformSecret.mockResolvedValue({ data: null, error: null });
    const fake = installFetch();
    await expect(run()).rejects.toMatchObject({ code: "chatgpt_ads_not_configured" });
    expect(fake).not.toHaveBeenCalled();
  });

  it("an empty-string platform key is also not-configured, not a bearer of ''", async () => {
    platformSecret.mockResolvedValue({ data: "   ", error: null });
    installFetch();
    await expect(run()).rejects.toMatchObject({ code: "chatgpt_ads_not_configured" });
  });

  it("a 403 from OpenAI is a typed forbidden error", async () => {
    installFetch((url) => (url.includes("/campaigns") ? new Response("nope", { status: 403 }) : undefined));
    await expect(run()).rejects.toMatchObject({ code: "chatgpt_ads_forbidden" });
  });

  it("a 500 from OpenAI is a typed http error", async () => {
    installFetch((url) => (url.includes("/campaigns") ? new Response("boom", { status: 500 }) : undefined));
    await expect(run()).rejects.toMatchObject({ code: "chatgpt_ads_http_error" });
  });

  it("never echoes the upstream error body, which describes a shared account", async () => {
    installFetch((url) =>
      url.includes("/campaigns")
        ? new Response("account zv-globex-always-on quota exceeded", { status: 500 })
        : undefined,
    );
    const err = await run().catch((e) => e as ExpectedToolError);
    expect((err as ExpectedToolError).message).not.toContain("globex");
  });

  it("a malformed body is a typed bad-response error", async () => {
    installFetch((url) => (url.includes("/campaigns") ? new Response("<html>nope", { status: 200 }) : undefined));
    await expect(run()).rejects.toMatchObject({ code: "chatgpt_ads_bad_response" });
  });
});

describe("metric honesty", () => {
  it("omits a metric the API did not return rather than filling in a zero", async () => {
    installFetch((url) => {
      if (!url.includes("/campaigns/") || !url.includes("/insights")) return undefined;
      return json({ object: "list", data: [{ impressions: 10 }] });
    });
    const out = await run();
    const first = out.campaigns![0];
    expect(first.impressions).toBe(10);
    expect(first).not.toHaveProperty("clicks");
    expect(first).not.toHaveProperty("spend");
    expect(first).not.toHaveProperty("ctr");
    expect(first).not.toHaveProperty("cpc");
  });

  it("does not derive a blended rate across rows the API reported separately", async () => {
    installFetch((url) => {
      if (!url.includes("/campaigns/") || !url.includes("/insights")) return undefined;
      return json({
        object: "list",
        data: [
          { impressions: 100, clicks: 10, ctr: 0.1 },
          { impressions: 100, clicks: 30, ctr: 0.3 },
        ],
      });
    });
    const out = await run();
    const first = out.campaigns![0];
    expect(first.impressions).toBe(200);
    expect(first.clicks).toBe(40);
    expect(first).not.toHaveProperty("ctr");
    expect(out.totals_across_your_campaigns_only).not.toHaveProperty("ctr");
    expect(out.totals_across_your_campaigns_only).not.toHaveProperty("cpc");
  });

  it("defaults to a 14-day window and rejects one past 90 days", async () => {
    installFetch();
    expect((await run()).period?.days).toBe(14);
    expect((await run({ days: 30 })).period?.days).toBe(30);
    await expect(run({ days: 91 })).rejects.toBeTruthy();
    await expect(run({ days: 0 })).rejects.toBeTruthy();
  });
});

describe("an unread thing is never reported as a measured nothing", () => {
  it("a valid empty account returns no campaigns, without inventing zero spend", async () => {
    installFetch((url) => url.includes("/campaigns") ? json({ data: [], has_more: false }) : undefined);
    const report = await run();
    expect(report.no_campaigns_for_tenant).toBe(true);
    expect(report).not.toHaveProperty("totals_across_your_campaigns_only");
  });

  it("a campaign list cut short by the page budget reports UNVERIFIED, not 'no campaigns'", async () => {
    installFetch((url) =>
      url.includes("/campaigns") && !url.includes("/insights")
        ? json({
            object: "list",
            data: [{ id: "c-globex-9", name: "zv-globex--always-on", status: "active" }],
            has_more: true,
            last_id: "c-globex-9",
          })
        : undefined,
    );
    const out = (await run()) as Report & { unverified?: boolean };
    expect(out.unverified).toBe(true);
    expect(out.no_campaigns_for_tenant).toBeUndefined();
    expect(out.campaigns).toBeUndefined();
    expect(out.totals_across_your_campaigns_only).toBeUndefined();
    expect(String(out.message)).toMatch(/could not be read in full/i);
    expect(JSON.stringify(out)).not.toContain("globex");
  });

  it("rows dropped by the ownership belt are declared, not silently netted off the total", async () => {
    installFetch((url) => {
      if (url.includes("/campaigns/") && url.includes("/insights")) {
        const id = decodeURIComponent(url.split("/campaigns/")[1].split("/")[0]);
        if (id === "c-acme-2") {
          return json({ object: "list", data: [{ ...INSIGHTS["c-acme-2"], campaign_id: "c-labs-1" }] });
        }
      }
      return undefined;
    });
    const out = (await run()) as Report & { rows_dropped?: number; rows_dropped_note?: string };
    expect(out.rows_dropped).toBe(1);
    expect(String(out.rows_dropped_note)).toMatch(/understate/i);
    expect(JSON.stringify(out)).not.toContain("c-labs-1");
  });

  it("a window the API never corroborated is flagged, so no date range can be quoted", async () => {
    installFetch((url) => {
      if (url.includes("/campaigns/") && url.includes("/insights")) {
        return json({ object: "list", data: [{ impressions: 10, clicks: 1, spend: 2 }] });
      }
      return undefined;
    });
    const out = (await run()) as Report & { campaigns?: Array<{ period_unconfirmed?: boolean }> };
    expect(out.campaigns?.[0]?.period_unconfirmed).toBe(true);
  });

  it("a human date label alone cannot confirm the requested period", async () => {
    installFetch();
    const out = (await run()) as Report & { campaigns?: Array<{ period_unconfirmed?: boolean }> };
    expect(out.campaigns?.[0]?.period_unconfirmed).toBe(true);
  });
});

describe("a prefixed name that cannot be claimed is declared, not swallowed", () => {
  const withNames = (names: string[]) =>
    installFetch((url) =>
      url.includes("/campaigns") && !url.includes("/insights")
        ? json({
            object: "list",
            data: names.map((name, i) => ({ id: `c-${i}`, name, status: "active" })),
            has_more: false,
            last_id: null,
          })
        : undefined,
    );

  it("does not report 'Zavi runs nothing' when the only name is unclaimable", async () => {
    withNames(["zv-acme--q4--brand"]);
    const out = (await run()) as Report & {
      names_unclaimable?: number;
      unverified?: boolean;
    };
    expect(out.names_unclaimable).toBe(1);
    expect(out.no_campaigns_for_tenant).toBeUndefined();
    expect(out.unverified).toBe(true);
    expect(String(out.message)).toMatch(/renam/i);
    expect(String(out.message)).not.toMatch(/runs no ChatGPT ad campaigns/i);
  });

  it("declares it beside the total when the workspace also has claimable campaigns", async () => {
    withNames(["zv-acme--spring", "zv-acme--q4--brand"]);
    const out = (await run()) as Report & { names_unclaimable?: number };
    expect(out.campaigns?.map((c) => c.id)).toEqual(["c-0"]);
    expect(out.names_unclaimable).toBe(1);
  });

  it("stays silent when every prefixed name is claimable", async () => {
    withNames(["zv-acme--spring", "zv-globex--always-on"]);
    const out = (await run()) as Report & { names_unclaimable?: number };
    expect(out.names_unclaimable).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("globex");
  });

  it("still says nothing is running when no name carries the prefix at all", async () => {
    withNames(["zv-globex--always-on", "house brand test"]);
    const out = (await run()) as Report & { names_unclaimable?: number };
    expect(out.no_campaigns_for_tenant).toBe(true);
    expect(out.names_unclaimable).toBeUndefined();
  });
});

describe("strict requested reporting window", () => {
  const period = { from: "2026-10-01", to: "2026-10-07", timezone: "America/Los_Angeles", days: 7 };
  const start = Date.parse("2026-10-01T07:00:00Z") / 1000;
  const end = Date.parse("2026-10-08T07:00:00Z") / 1000;
  it("accepts exclusive midnight and inclusive last-second ends", () => {
    expect(confirmsRequestedPeriod([{ start_time: start, end_time: end }], period)).toBe(true);
    expect(confirmsRequestedPeriod([{ start_time: start, end_time: end - 1 }], period)).toBe(true);
  });
  const invalid: ChatgptAdsInsightRow[][] = [
    [{ start_time: start + 3600, end_time: end }],
    [{ start_time: start - 86400, end_time: end }],
    [{ start_time: start, end_time: end - 86400 }],
    [{ start_time: start, end_time: end, timezone: "UTC" }],
    [{ readable_time: "last week" }],
    [],
    [{ start_time: start, end_time: end }, { start_time: start, end_time: end }],
  ];
  it.each(invalid.map(rows => ({ rows })))("does not confirm missing, partial, overlapping or mismatched periods $rows", ({ rows }) => {
    expect(confirmsRequestedPeriod(rows, period)).toBe(false);
  });
  it("uses local calendar midnights across a daylight-saving transition", () => {
    expect(confirmsRequestedPeriod([{
      start_time: Date.parse("2026-10-29T07:00:00Z") / 1000,
      end_time: Date.parse("2026-11-05T08:00:00Z") / 1000,
    }], { from: "2026-10-29", to: "2026-11-04", timezone: period.timezone, days: 7 })).toBe(true);
  });
});

it("returns the current card shortfall and fitting plan with the wallet instead of relying on earlier notes", async () => {
  installFetch();
  planning.remaining.mockResolvedValue(true);
  planning.read.mockResolvedValue({ status: "read", complete: true, open_proposals: [{ id: "current-card", status: "pending", funding: { status: "insufficient", estimated_shortfall_cents: 13118 } }], wallet_daily_plan: { estimated_required_cents: 15000 } });
  const result = await run();
  expect(planning.read).toHaveBeenCalledWith("t-1", undefined, result.zavi_ads_wallet);
  expect(result.proposal_readiness.open_proposals).toHaveLength(1);
  expect(result.requested_budget).toMatchObject({ top_up_authorized: false, next_step: expect.stringContaining("replace an unfunded proposal") });
});

it.each(["read", "unavailable"])("does not recommend creating another campaign after an incomplete %s of existing proposals", async status => {
  installFetch();
  planning.remaining.mockResolvedValue(true);
  planning.read.mockResolvedValue({ status, complete: false, open_proposals: [], wallet_daily_plan: { estimated_required_cents: 15000 } });
  const result = await run();
  expect(result.requested_budget?.next_step).toContain("Refresh it before proposing another campaign");
});

it("can still point to a verified funded pending card in a partial list", async () => {
  installFetch();
  planning.remaining.mockResolvedValue(true);
  planning.read.mockResolvedValue({ status: "read", complete: false, open_proposals: [{ status: "pending", funding: { status: "covered" } }], wallet_daily_plan: null });
  const result = await run();
  expect(result.requested_budget?.next_step).toBe("Review the funded pending proposal on this channel.");
});

it("a founder's direct ask in this run: the read says to file it, not to point at the pending card", async () => {
  installFetch();
  planning.remaining.mockResolvedValue(false);
  planning.read.mockResolvedValue({ status: "read", complete: true, open_proposals: [{ id: "aae4d045", status: "pending", funding: { status: "covered" } }], wallet_daily_plan: null });
  planning.ask.mockResolvedValueOnce({ plan: { channel_slug: "chatgpt_ads", total_usd: 25 }, line: "Running $25 on ChatGPT as one total on Oct 16.", source: "ask" });
  const withAsk = (await run()) as Record<string, unknown>;
  expect(planning.ask.mock.calls[0][1]).toBe("chatgpt_ads");
  expect(withAsk.founder_direct_ask).toMatchObject({ line: expect.stringContaining("$25"), next_step: expect.stringContaining("closed automatically") });
  planning.ask.mockResolvedValueOnce(null);
  expect(((await run()) as Record<string, unknown>).founder_direct_ask).toBeUndefined();
  planning.ask.mockResolvedValueOnce({ plan: { channel_slug: "chatgpt_ads", total_usd: 25 }, line: "", source: "decision" });
  expect(((await run()) as Record<string, unknown>).founder_direct_ask).toBeUndefined();
});

it("reconciles an applied campaign omitted from inventory without inventing delivery metrics or first-use onboarding", async () => {
  const id = "cmpn_archived1";
  creationRows.mockResolvedValue({ data: [{ id: "action1", title: "Create Renters", exec_class: "chatgpt_ads.create_and_launch", exec_result: { created: { platform: "chatgpt", object_type: "campaign", id, status: "ACTIVE" } } }], error: null });
  const fake = installFetch(url => {
    if (url.endsWith(`/campaigns/${id}`)) return json({ id, name: "zv-acme--Renters", status: "archived", updated_at: 1792524483, start_time: 1792524556 });
    if (url.includes("/campaigns")) return json({ data: [], has_more: false });
  });
  const result = await run() as Report & { recent_creations: { campaigns: Array<Record<string, unknown>> } };
  expect(result.no_campaigns_for_tenant).toBeUndefined();
  expect(result.recent_creations.campaigns).toMatchObject([{ recorded_creation: true, campaign_reference: id, current_state: "verified", current_status: "archived", last_updated_at: 1792524483 }]);
  expect(result.totals_across_your_campaigns_only).toBeUndefined();
  expect(fake.mock.calls.some(([url]) => String(url).includes("/insights"))).toBe(false);
  expect(result.message).not.toContain("exists in Zavi's ad account");
});
it("an unavailable creation history does not turn empty current inventory into never-created", async () => {
  creationRows.mockResolvedValue({ data: null, error: { message: "unavailable" } });
  installFetch(url => url.includes("/campaigns") ? json({ data: [], has_more: false }) : undefined);
  const result = await run();
  expect(result.no_campaigns_for_tenant).toBeUndefined();
  expect(result.message).toContain("Creation history could not be read");
});
