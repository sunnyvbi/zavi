import { beforeEach, describe, expect, it } from "vitest";
import type { ComposioExecResult } from "@/services/connectors/composio/api";
import { EMAIL_PROVIDERS, EmailToolError, NO_RESULTS, resetKlaviyoMetricCache, type ProviderCall } from "../providers";
import { retryAfterSeconds, sendgridHttpCall } from "../providers-sendgrid";

const ok = (data: unknown): ComposioExecResult => ({ ok: true, status: 200, data, error: null, outcome_unknown: false });
const fail = (status: number): ComposioExecResult => ({ ok: false, status, data: null, error: `HTTP ${status}`, outcome_unknown: false });

function recorder(answer: (slug: string, args: Record<string, unknown>) => ComposioExecResult) {
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const call: ProviderCall = async (slug, args) => {
    calls.push({ slug, args });
    return answer(slug, args);
  };
  return { calls, call };
}

describe("Mailchimp results", () => {
  it("delivered = sent minus hard AND soft bounces; unsubscribes from `unsubscribed`", async () => {
    const { call } = recorder(() =>
      ok({ data: { emails_sent: 500, unsubscribed: 3, bounces: { hard_bounces: 7, soft_bounces: 11 }, opens: { unique_opens: 120, open_rate: 0.24 }, clicks: { unique_subscriber_clicks: 9, click_rate: 0.018 } } }),
    );
    expect(await EMAIL_PROVIDERS.mailchimp.results(call, "c1")).toEqual({
      recipients: 500,
      delivered: 482,
      bounces: 18,
      opens: 120,
      clicks: 9,
      unsubscribes: 3,
      open_rate: 0.24,
      click_rate: 0.018,
    });
  });

  it("campaign 54d23cdc92: sent 2, 0 hard, 1 soft bounce is delivered 1, bounces 1", async () => {
    const { call } = recorder(() => ok({ data: { emails_sent: 2, unsubscribed: 0, bounces: { hard_bounces: 0, soft_bounces: 1, syntax_errors: 0 }, opens: { unique_opens: 1 }, clicks: { unique_subscriber_clicks: 0 } } }));
    expect(await EMAIL_PROVIDERS.mailchimp.results(call, "54d23cdc92")).toMatchObject({ recipients: 2, delivered: 1, bounces: 1 });
  });

  it("more bounces than sent floors delivered at 0", async () => {
    const { call } = recorder(() => ok({ data: { emails_sent: 2, bounces: { hard_bounces: 2, soft_bounces: 1 } } }));
    expect(await EMAIL_PROVIDERS.mailchimp.results(call, "c1")).toMatchObject({ delivered: 0, bounces: 3 });
  });

  it("a field the report lacks is null, never 0", async () => {
    const { call } = recorder(() => ok({ data: { emails_sent: 10 } }));
    const r = await EMAIL_PROVIDERS.mailchimp.results(call, "c1");
    expect(r).toMatchObject({ recipients: 10, delivered: null, opens: null, unsubscribes: null });
  });

  it("an error carries the tool's status", async () => {
    const { call } = recorder(() => fail(429));
    const e = await EMAIL_PROVIDERS.mailchimp.results(call, "c1").catch((x) => x);
    expect(e).toBeInstanceOf(EmailToolError);
    expect((e as EmailToolError).status).toBe(429);
  });
});

describe("Klaviyo results", () => {
  beforeEach(() => resetKlaviyoMetricCache());
  const report = (rows: Array<{ id: string; stats: Record<string, number> }>) =>
    ok({ data: { type: "campaign-values-report", attributes: { results: rows.map((r) => ({ groupings: { campaign_id: r.id, send_channel: "email" }, statistics: r.stats })) } } });

  const METRICS = ok({ data: [{ id: "M1", attributes: { name: "Opened Email" } }, { id: "RX", attributes: { name: "Received Email" } }, { id: "SK", attributes: { name: "Skipped Send" } }] });
  const aggregate = (rows: Array<[string, number[]]>) =>
    ok({ data: { type: "metric-aggregate", attributes: { dates: [], data: rows.map(([id, count]) => ({ dimensions: [id], measurements: { count } })) } } });
  const skipFake = (byMetric: Record<string, ComposioExecResult>, values: ComposioExecResult = report([])) =>
    recorder((slug, args) => {
      if (slug === "KLAVIYO_GET_METRICS") return METRICS;
      if (slug === "KLAVIYO_QUERY_METRIC_AGGREGATES") return byMetric[String(args.data__attributes__metric__id)];
      return values;
    });

  it("1 of 4 reached, 3 skipped: the empty values report no longer hides it, counts summed across months", async () => {
    const { calls, call } = skipFake({ RX: aggregate([["CAMP", [0, 1]]]), SK: aggregate([["CAMP", [2, 1]], ["OTHER", [9]]]) });
    const many = await EMAIL_PROVIDERS.klaviyo.resultsMany!(call, ["CAMP"], "acct-s1");
    expect(many.get("CAMP")).toEqual({ ...NO_RESULTS, received: 1, skipped: 3 });
    const q = calls.find((c) => c.slug === "KLAVIYO_QUERY_METRIC_AGGREGATES")!.args;
    expect(q).toMatchObject({ data__attributes__by: ["$message"], data__attributes__measurements: ["count"] });
  });

  it("everyone skipped: a campaign with no received event reads 0 received, 4 skipped", async () => {
    const { call } = skipFake({ RX: aggregate([]), SK: aggregate([["CAMP", [4]]]) });
    const many = await EMAIL_PROVIDERS.klaviyo.resultsMany!(call, ["CAMP"], "acct-s2");
    expect(many.get("CAMP")).toMatchObject({ received: 0, skipped: 4 });
  });

  it("a failed skip read loses nothing and invents no zero: received stands, skipped stays unknown", async () => {
    const { call } = skipFake({ RX: aggregate([["CAMP", [1]]]), SK: fail(500) });
    const many = await EMAIL_PROVIDERS.klaviyo.resultsMany!(call, ["CAMP"], "acct-s3");
    expect(many.get("CAMP")).toMatchObject({ received: 1, skipped: null });
  });

  it("both event reads failing leaves the values report as it was", async () => {
    const { call } = skipFake({ RX: fail(500), SK: fail(429) }, report([{ id: "CAMP", stats: { recipients: 4, delivered: 4, opens_unique: 1, clicks_unique: 0, unsubscribe_uniques: 0 } }]));
    const many = await EMAIL_PROVIDERS.klaviyo.resultsMany!(call, ["CAMP"], "acct-s4");
    expect(many.get("CAMP")).toMatchObject({ recipients: 4 });
    expect(many.get("CAMP")?.skipped).toBeUndefined();
  });

  it("a campaign with no events yet stays out of the map, so the check tries again", async () => {
    const { call } = skipFake({ RX: aggregate([["OTHER", [1]]]), SK: aggregate([]) });
    expect((await EMAIL_PROVIDERS.klaviyo.resultsMany!(call, ["CAMP"], "acct-s5")).has("CAMP")).toBe(false);
  });

  it("reads a window that holds campaigns sent this month", async () => {
    const { calls, call } = skipFake({ RX: aggregate([]), SK: aggregate([]) });
    await EMAIL_PROVIDERS.klaviyo.resultsMany!(call, ["CAMP"], "acct-s7");
    expect(calls.find((c) => c.slug === "KLAVIYO_QUERY_CAMPAIGN_VALUES")!.args.data__attributes__timeframe).toEqual({ key: "last_365_days" });
  });

  it("the reads are read-only slugs", async () => {
    const { calls, call } = skipFake({ RX: aggregate([]), SK: aggregate([]) });
    await EMAIL_PROVIDERS.klaviyo.resultsMany!(call, ["CAMP"], "acct-s6");
    expect([...new Set(calls.map((c) => c.slug))].sort()).toEqual(["KLAVIYO_GET_METRICS", "KLAVIYO_QUERY_CAMPAIGN_VALUES", "KLAVIYO_QUERY_METRIC_AGGREGATES"]);
  });

  it("one report for several campaigns, metric id cached per account", async () => {
    const { calls, call } = recorder((slug) =>
      slug === "KLAVIYO_GET_METRICS"
        ? ok({ data: [{ id: "M1" }] })
        : report([
            { id: "A", stats: { recipients: 100, delivered: 98, opens_unique: 40, clicks_unique: 4, unsubscribe_uniques: 1 } },
            { id: "B", stats: { recipients: 50, delivered: 50, opens_unique: 10, clicks_unique: 0, unsubscribe_uniques: 0 } },
          ]),
    );
    const many = await EMAIL_PROVIDERS.klaviyo.resultsMany!(call, ["A", "B", "C"], "acct-1");
    expect(many.get("A")).toMatchObject({ delivered: 98, opens: 40, clicks: 4, unsubscribes: 1 });
    expect(many.get("B")).toMatchObject({ delivered: 50, unsubscribes: 0 });
    expect(many.has("C")).toBe(false);
    const q = calls.find((c) => c.slug === "KLAVIYO_QUERY_CAMPAIGN_VALUES")!;
    expect(q.args.data__attributes__filter).toBe('contains-any(campaign_id,["A","B","C"])');
    expect(q.args.data__attributes__statistics).toEqual(expect.arrayContaining(["delivered", "unsubscribe_uniques"]));
    await EMAIL_PROVIDERS.klaviyo.resultsMany!(call, ["A"], "acct-1");
    expect(calls.filter((c) => c.slug === "KLAVIYO_GET_METRICS")).toHaveLength(1);
    expect(calls.at(-1)!.args.data__attributes__filter).toBe('equals(campaign_id,"A")');
  });

  it("an account with no metric reads as not reported, not an error", async () => {
    const { calls, call } = recorder(() => ok({ data: [] }));
    const many = await EMAIL_PROVIDERS.klaviyo.resultsMany!(call, ["A"], "acct-2");
    expect(many.get("A")).toEqual(NO_RESULTS);
    expect(calls.map((c) => c.slug)).toEqual(["KLAVIYO_GET_METRICS"]);
  });

  it("an id that is not a Klaviyo id never reaches the filter", async () => {
    const { calls, call } = recorder((slug) => (slug === "KLAVIYO_GET_METRICS" ? ok({ data: [{ id: "M1" }] }) : report([])));
    await EMAIL_PROVIDERS.klaviyo.resultsMany!(call, ['x"),or(', "Good1"], "acct-3");
    expect(calls.at(-1)!.args.data__attributes__filter).toBe('equals(campaign_id,"Good1")');
  });
});

describe("SendGrid rate limit", () => {
  it("reads X-RateLimit-Reset as seconds to wait, bounded", () => {
    const now = 1_000_000_000_000;
    const h = (v: string | null) => ({ get: (k: string) => (k === "x-ratelimit-reset" ? v : null) });
    expect(retryAfterSeconds(h(String(now / 1000 + 42)), now)).toBe(42);
    expect(retryAfterSeconds(h(String(now / 1000 - 5)), now)).toBe(1);
    expect(retryAfterSeconds(h(String(now / 1000 + 99_999)), now)).toBe(3600);
    expect(retryAfterSeconds(h(null), now)).toBeNull();
  });

  it("a 429 from the stats read surfaces as an error with the wait", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "too many" }] }), {
        status: 429,
        headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30) },
      })) as unknown as typeof fetch;
    const e = await EMAIL_PROVIDERS.sendgrid.results(sendgridHttpCall("SG.test", fetchImpl), "123").catch((x) => x);
    expect(e).toBeInstanceOf(EmailToolError);
    expect((e as EmailToolError).status).toBe(429);
    expect((e as EmailToolError).retry_after_s).toBeGreaterThan(0);
  });
});
