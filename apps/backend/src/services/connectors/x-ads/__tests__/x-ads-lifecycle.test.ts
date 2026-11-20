import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ secret: vi.fn(), record: vi.fn(), switched: vi.fn(), locked: vi.fn(), plan: vi.fn(), reserve: vi.fn(), release: vi.fn(), commit: vi.fn(), drop: vi.fn(), rebase: vi.fn(), note: vi.fn(), role: vi.fn() }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: mocks.role }));
const testEndMock = vi.hoisted(() => ({ end: null as null | { decision_id: string; channel: string | null; ends_on: string } }));
vi.mock("@/services/growth/cgo-test-end", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/cgo-test-end")>()),
  cgoTestEndForRun: vi.fn(async () => testEndMock.end),
}));
vi.mock("@/services/growth/preview-plan", async (orig) => ({ ...(await orig<object>()), channelPlanLock: mocks.plan }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: mocks.secret }));
vi.mock("@/services/channels/lock", async (orig) => ({ ...(await orig<object>()), isChannelLockedStrict: mocks.locked }));
vi.mock("@/services/channels/exec-actions", async (orig) => ({ ...(await orig<object>()), recordChannelExecAction: mocks.record }));
vi.mock("@/services/channels/channel-actions", async (orig) => ({ ...(await orig<object>()), switchedChannelForRun: mocks.switched }));

vi.mock("@/services/decisions/ad-budget", async orig => ({ ...(await orig<object>()), reserveAdSpend: mocks.reserve, releaseAdSpendForObject: mocks.release, commitAdSpend: mocks.commit, dropAdSpendHold: mocks.drop, rebaseAdSpendForObject: mocks.rebase, noteAdSpendObject: mocks.note }));

import { statsWindows, xCampaignStats } from "../client";
import { executeXCreateCampaign, executeXSetStatus, executeXUpdateCampaign } from "../execute";
import { resolveXAdsEmit } from "@/services/tools/x-ads/_exec-action";
import { xAdsProposeCreateCampaignTool } from "@/services/tools/x-ads/propose_create_campaign";
import { xAdsProposePauseCampaignTool, xAdsProposeResumeCampaignTool } from "@/services/tools/x-ads/propose_status";
import { xAdsProposeUpdateCampaignTool } from "@/services/tools/x-ads/propose_update_campaign";
import { xAdsListCampaignsTool } from "@/services/tools/x-ads/list_campaigns";
import { callXAdsTool, listXAdsTools } from "@/services/mcp/internal/x-ads";
import { buildInlineDecisionBody } from "@/services/agents/build-inline-decision";

type Campaign = { id: string; name: string; entity_status: string; daily_budget_amount_local_micro: number; total_budget_amount_local_micro: number | null; funding_instrument_id: string; currency: string; deleted: boolean };
type Call = { method: string; path: string; params: Record<string, string>; auth: string };

const ACCOUNT = "18ce54d4x5t";
let campaigns: Map<string, Campaign>;
let lineItems: Map<string, { campaign_id: string; entity_status: string; end_time?: string }>;
let dropLineItemEnd = false;
let promoted: Array<{ line_item_id: string; tweet_ids: string }>;
let targeting: Array<{ line_item_id: string; targeting_type: string; targeting_value: string; operator_type: string }>;
let newPosts: Array<{ as_user_id: string; text: string; nullcast: string }>;
let failBatch = false;
let permissions: string[];
let calls: Call[];
let nextId: number;
let failNext: { method: string; pathEnds: string; status: number } | null;
let throwNext: { method: string } | null;
let failReadAfterPut: number | null = null;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function handle(method: string, path: string, params: Record<string, string>, body: unknown): Response {
  if (failNext && failNext.method === method && path.endsWith(failNext.pathEnds)) {
    const s = failNext.status;
    failNext = null;
    return json(s, { errors: [{ code: "INVALID_PARAMETER", message: "nope" }] });
  }
  if (method === "GET" && path.endsWith("authenticated_user_access")) return json(200, { data: { user_id: "7", permissions } });
  const parts = path.replace(/^\/12\//, "").split("/");
  if (method === "GET" && parts[0] === "accounts" && parts.length === 1) {
    return json(200, { data: [{ id: ACCOUNT, name: "Main", approval_status: "ACCEPTED" }] });
  }
  if (parts[0] === "accounts" && parts[2] === "funding_instruments") {
    return json(200, { data: [{ id: "lygyi", description: "Visa ending in 0650", type: "CREDIT_CARD", entity_status: "ACTIVE", able_to_fund: true, currency: "USD" }] });
  }
  if (parts[0] === "accounts" && parts[2] === "campaigns") {
    if (method === "GET" && parts.length === 3) return json(200, { data: [...campaigns.values()].filter((c) => !c.deleted), next_cursor: null });
    if (method === "POST") {
      const c: Campaign = {
        id: `c${nextId++}`,
        name: params.name,
        entity_status: params.entity_status,
        daily_budget_amount_local_micro: Number(params.daily_budget_amount_local_micro),
        total_budget_amount_local_micro: params.total_budget_amount_local_micro ? Number(params.total_budget_amount_local_micro) : null,
        funding_instrument_id: params.funding_instrument_id,
        currency: "USD",
        deleted: false,
      };
      campaigns.set(c.id, c);
      return json(200, { data: c });
    }
    const c = campaigns.get(parts[3]);
    if (!c) return json(404, { errors: [{ code: "NOT_FOUND", message: "no campaign" }] });
    if (method === "GET") return json(200, { data: c });
    if (method === "PUT") {
      if (params.name) c.name = params.name;
      if (params.entity_status) c.entity_status = params.entity_status;
      if (params.daily_budget_amount_local_micro) c.daily_budget_amount_local_micro = Number(params.daily_budget_amount_local_micro);
      if (params.total_budget_amount_local_micro) c.total_budget_amount_local_micro = Number(params.total_budget_amount_local_micro);
      return json(200, { data: c });
    }
    if (method === "DELETE") {
      c.deleted = true;
      return json(200, { data: { ...c, deleted: true } });
    }
  }
  if (method === "POST" && parts[2] === "line_items") {
    const id = `li${nextId++}`;
    lineItems.set(id, { campaign_id: params.campaign_id, entity_status: params.entity_status, ...(params.end_time && !dropLineItemEnd ? { end_time: params.end_time } : {}) });
    return json(200, { data: { id, entity_status: params.entity_status } });
  }
  if (method === "GET" && parts[2] === "line_items" && parts[3]) {
    const li = lineItems.get(parts[3]);
    return li ? json(200, { data: { id: parts[3], ...li } }) : json(404, { errors: [{ code: "NOT_FOUND", message: "no line item" }] });
  }
  if (method === "POST" && parts[0] === "batch" && parts[3] === "targeting_criteria") {
    const ops = body as Array<{ operation_type: string; params: { line_item_id: string; targeting_type: string; targeting_value: string; operator_type: string } }>;
    if (failBatch || !Array.isArray(ops) || ops.some((o) => o.operation_type !== "Create")) {
      failBatch = false;
      return json(400, { operation_errors: [[{ code: "INVALID_PARAMETER", message: "bad criterion" }]], request: ops });
    }
    for (const o of ops) targeting.push({ ...o.params });
    return json(200, { data: ops.map(() => ({ id: `tc${nextId++}` })), request: ops });
  }
  if (method === "GET" && parts[2] === "promotable_users") {
    return json(200, { data: [{ id: "pu1", user_id: 1234567, promotable_user_type: "FULL" }] });
  }
  if (method === "POST" && parts[2] === "tweet") {
    newPosts.push({ as_user_id: params.as_user_id, text: params.text, nullcast: params.nullcast });
    return json(200, { data: { id: 1900000000000000001, id_str: "1900000000000000001", text: params.text } });
  }
  if (method === "POST" && parts[2] === "promoted_tweets") {
    promoted.push({ line_item_id: params.line_item_id, tweet_ids: params.tweet_ids });
    return json(200, { data: params.tweet_ids.split(",").map(() => ({ id: `pt${nextId++}` })) });
  }
  if (method === "GET" && parts[0] === "stats") {
    const ids = params.entity_ids.split(",");
    return json(200, {
      data: ids.map((id) => ({
        id,
        id_data: [
          {
            metrics: {
              billed_charge_local_micro: [10_000_000],
              impressions: [1000],
              url_clicks: [20],
              conversion_purchases: { metric: [1], sale_amount: [50] },
              conversion_sign_ups: null,
            },
          },
        ],
      })),
    });
  }
  return json(404, { errors: [{ code: "ROUTE_NOT_FOUND", message: path }] });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (throwNext && throwNext.method === method) {
    throwNext = null;
    throw new Error("socket hang up");
  }
  const params = Object.fromEntries(url.searchParams);
  if (failReadAfterPut && method === "GET" && calls.some((c) => c.method === "PUT")) {
    const status = failReadAfterPut;
    failReadAfterPut = null;
    return json(status, { errors: [{ code: "TOO_MANY_REQUESTS", message: "slow down" }] });
  }
  calls.push({ method, path: url.pathname, params, auth: String((init?.headers as Record<string, string>)?.Authorization ?? "") });
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  return handle(method, url.pathname, params, body);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const seed = (c: Partial<Campaign> & { id: string }) =>
  campaigns.set(c.id, {
    name: "Spring",
    entity_status: "ACTIVE",
    daily_budget_amount_local_micro: 50_000_000,
    total_budget_amount_local_micro: null,
    funding_instrument_id: "lygyi",
    currency: "USD",
    deleted: false,
    ...c,
  });

let emitted: Array<{ cls: string; body: Record<string, unknown> }>;
const chatEmit = async (cls: string, body: unknown) => {
  emitted.push({ cls, body: body as Record<string, unknown> });
  return `d-${emitted.length}`;
};
const ctx = (extra: Record<string, unknown> = {}) => ({ tenant_id: "t1", log: () => {}, emit_decision: chatEmit, ...extra }) as never;
const human = (body: unknown) => ({ id: "action-1", tenant_id: "t1", body, approved_by: "u1", approved_by_source: "founder" });

beforeEach(() => {
  process.env.X_ADS_CONSUMER_KEY = "ck";
  process.env.X_ADS_CONSUMER_SECRET = "cs";
  campaigns = new Map();
  lineItems = new Map();
  promoted = [];
  targeting = [];
  newPosts = [];
  failBatch = false;
  permissions = ["AD_MANAGER", "TWEET_COMPOSER"];
  calls = [];
  nextId = 1;
  failNext = null;
  throwNext = null;
  emitted = [];
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.reserve.mockResolvedValue({ status: "no_budget" });
  mocks.commit.mockResolvedValue(undefined);
  mocks.drop.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.rebase.mockResolvedValue(undefined);
  mocks.note.mockResolvedValue(undefined);

  mocks.secret.mockImplementation(async (_t: string, k: string) => (k.endsWith("access_token") ? "tk" : "ts"));
  mocks.record.mockResolvedValue({ id: "card-1", replayed: false });
  mocks.locked.mockResolvedValue(false);
  mocks.plan.mockResolvedValue(null);
  mocks.role.mockResolvedValue("owner");
  failReadAfterPut = null;
  testEndMock.end = null;
  dropLineItemEnd = false;
});

describe("create → resume → change budget → pause, proposed and approved", () => {
  it("runs end to end against the API, every write signed and in the query string", async () => {
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT,
      funding_instrument_id: "lygyi",
      name: "Launch week",
      objective: "WEBSITE_CLICKS",
      daily_budget: 25,
      tweet_ids: ["1844000000000000001", "1844000000000000002"],
      locations: [{ id: "96683cc9126741d1", name: "United States" }],
      rationale: "Two posts with 3x the account's median link clicks last month.",
    });
    const create = emitted[0];
    expect(create.cls).toBe("x_ads.create_campaign");
    expect(create.body).toMatchObject({ launch: "PAUSED", daily_budget: 25, currency: "USD" });
    expect(calls.some((c) => c.method !== "GET")).toBe(false);

    expect(await executeXCreateCampaign(human(create.body))).toMatchObject({ ok: true });
    const [c] = [...campaigns.values()];
    expect(c).toMatchObject({ name: "Launch week", entity_status: "PAUSED", daily_budget_amount_local_micro: 25_000_000 });
    expect([...lineItems.values()][0]).toMatchObject({ campaign_id: c.id, entity_status: "ACTIVE" });
    expect(promoted).toEqual([{ line_item_id: expect.any(String), tweet_ids: "1844000000000000001,1844000000000000002" }]);
    expect(targeting).toEqual([{ line_item_id: expect.any(String), targeting_type: "LOCATION", targeting_value: "96683cc9126741d1", operator_type: "EQ" }]);
    expect(calls.filter((c) => c.path.includes("targeting_criteria"))).toHaveLength(1);
    for (const w of calls.filter((x) => x.method !== "GET")) {
      expect(w.auth).toMatch(/^OAuth /);
      expect(w.auth).toContain('oauth_token="tk"');
    }

    await xAdsProposeResumeCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: c.id, rationale: "Ready to go live." });
    expect(emitted[1].body).toMatchObject({ status: "ACTIVE", daily_budget: 25 });
    expect(await executeXSetStatus(human(emitted[1].body))).toMatchObject({ ok: true });
    expect(campaigns.get(c.id)?.entity_status).toBe("ACTIVE");

    await xAdsProposeUpdateCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: c.id, daily_budget: 40, name: "Launch week v2", rationale: "CPA $4 vs $9 elsewhere." });
    expect(emitted[2].body).toMatchObject({ changes: { daily_budget: 40, name: "Launch week v2" }, before: { daily_budget: 25 } });
    expect(await executeXUpdateCampaign(human(emitted[2].body))).toMatchObject({ ok: true });
    expect(campaigns.get(c.id)).toMatchObject({ name: "Launch week v2", daily_budget_amount_local_micro: 40_000_000 });

    await xAdsProposePauseCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: c.id, rationale: "$120 over 7 days, 0 conversions." });
    expect(await executeXSetStatus(human(emitted[3].body))).toMatchObject({ ok: true });
    expect(campaigns.get(c.id)?.entity_status).toBe("PAUSED");
  });

  it("targets the picked places and excludes the excluded ones, shown on the card", async () => {
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "Cities", objective: "ENGAGEMENTS", daily_budget: 10, tweet_ids: ["1"],
      locations: [{ id: "96683cc9126741d1", name: "United States" }],
      excluded_locations: [{ id: "3b77caf94bfc81fe", name: "Los Angeles, CA, USA" }],
      rationale: "US without LA",
    });
    const rows = (emitted[0].body as { exact_change: { rows: Array<{ item: string; after: string }> } }).exact_change.rows;
    expect(rows).toContainEqual({ item: "Excluded locations", before: "None", after: "Los Angeles, CA, USA" });
    expect(await executeXCreateCampaign(human(emitted[0].body))).toMatchObject({ ok: true });
    expect(targeting.map((t) => [t.targeting_value, t.operator_type])).toEqual([
      ["96683cc9126741d1", "EQ"],
      ["3b77caf94bfc81fe", "NE"],
    ]);
  });

  it("a card filed before exclusions existed still runs, targeting only its places", async () => {
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "Old", objective: "ENGAGEMENTS", daily_budget: 10, tweet_ids: ["1"],
      locations: [{ id: "96683cc9126741d1", name: "United States" }], rationale: "old card",
    });
    const { excluded_locations: _drop, ...old } = emitted[0].body as Record<string, unknown>;
    expect(await executeXCreateCampaign(human(old))).toMatchObject({ ok: true });
    expect(targeting.map((t) => t.operator_type)).toEqual(["EQ"]);
  });

  it("the audience, the locations and the exclusions go in one batch, so a refusal builds nothing half-targeted", async () => {
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "Founders", objective: "ENGAGEMENTS", daily_budget: 10, tweet_ids: ["1"],
      locations: [{ id: "96683cc9126741d1", name: "United States" }], excluded_locations: [{ id: "3b77caf94bfc81fe", name: "Los Angeles, CA, USA" }],
      keywords: ["saas", "startup", "saas"], languages: ["en"], genders: ["FEMALE"], ages: ["AGE_25_TO_49"], rationale: "r",
    });
    const rows = (emitted[0].body as { exact_change: { rows: Array<{ item: string; after: string }> } }).exact_change.rows;
    expect(rows).toContainEqual({ item: "Keywords", before: "None", after: "saas, startup" });
    expect(rows).toContainEqual({ item: "Gender", before: "None", after: "Women" });
    expect(rows).toContainEqual({ item: "Ages", before: "None", after: "25 to 49" });
    expect((emitted[0].body as { audience: unknown }).audience).toEqual({ keywords: ["saas", "startup"], languages: ["en"], genders: ["FEMALE"], ages: ["AGE_25_TO_49"] });

    failBatch = true;
    const refused = await executeXCreateCampaign(human(emitted[0].body));
    expect(refused).toMatchObject({ ok: false, code: "exec_partial" });
    expect(refused.error).toContain("bad criterion");
    expect(targeting).toEqual([]);
    expect(promoted).toEqual([]);

    expect(await executeXCreateCampaign(human(emitted[0].body))).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.path.includes("targeting_criteria")).map((c) => c.path)).toEqual([`/12/batch/accounts/${ACCOUNT}/targeting_criteria`, `/12/batch/accounts/${ACCOUNT}/targeting_criteria`]);
    expect(targeting.map((t) => [t.targeting_type, t.targeting_value, t.operator_type])).toEqual([
      ["LOCATION", "96683cc9126741d1", "EQ"],
      ["LOCATION", "3b77caf94bfc81fe", "NE"],
      ["BROAD_KEYWORD", "saas", "EQ"],
      ["BROAD_KEYWORD", "startup", "EQ"],
      ["LANGUAGE", "en", "EQ"],
      ["GENDER", "2", "EQ"],
      ["AGE", "AGE_25_TO_49", "EQ"],
    ]);
  });

  it("a new post is published promoted-only at approval and promoted with the campaign", async () => {
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "New ad", objective: "WEBSITE_CLICKS", daily_budget: 10,
      new_post_text: "Book a car in two taps. https://example.com/start", locations: [{ id: "96683cc9126741d1", name: "United States" }], rationale: "r",
    });
    const body = emitted[0].body as { new_post: unknown; tweet_ids: unknown; exact_change: { rows: Array<{ item: string; after: string }> } };
    expect(body.new_post).toEqual({ text: "Book a car in two taps. https://example.com/start" });
    expect(body.tweet_ids).toEqual([]);
    expect(body.exact_change.rows).toContainEqual({ item: "New post (promoted only)", before: "None", after: "Book a car in two taps. https://example.com/start" });
    expect(newPosts).toEqual([]);
    expect(await executeXCreateCampaign(human(body))).toMatchObject({ ok: true });
    expect(newPosts).toEqual([{ as_user_id: "1234567", text: "Book a car in two taps. https://example.com/start", nullcast: "true" }]);
    expect(promoted).toEqual([{ line_item_id: expect.any(String), tweet_ids: "1900000000000000001" }]);
  });

  it("without the compose permission a new post is refused before any card, and at approval before any object", async () => {
    const input = { account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "New ad", objective: "ENGAGEMENTS", daily_budget: 10, new_post_text: "Hello", locations: [], rationale: "r" };
    await xAdsProposeCreateCampaignTool.execute(ctx(), input);
    permissions = ["AD_MANAGER"];
    await expect(xAdsProposeCreateCampaignTool.execute(ctx(), input)).rejects.toMatchObject({ code: "x_ads_compose_denied" });
    expect(emitted).toHaveLength(1);
    expect(await executeXCreateCampaign(human(emitted[0].body))).toMatchObject({ ok: false, code: "x_ads_compose_denied" });
    expect(campaigns.size).toBe(0);
    expect(newPosts).toEqual([]);
  });

  it("a duration is turned into the end date when the campaign is created, not when it was proposed", async () => {
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "Two weeks", objective: "ENGAGEMENTS", daily_budget: 10, tweet_ids: ["1"],
      locations: [{ id: "96683cc9126741d1", name: "United States" }], duration_days: 14, rationale: "r",
    });
    const body = emitted[0].body as { duration_days: number; end_time: null; exact_change: { rows: Array<{ item: string; after: string }> } };
    expect(body).toMatchObject({ duration_days: 14, end_time: null });
    expect(body.exact_change.rows).toContainEqual({ item: "Ends", before: "None", after: "14 days after it is created" });
    const before = Date.now();
    expect(await executeXCreateCampaign(human(body))).toMatchObject({ ok: true });
    const end = Date.parse([...lineItems.values()][0].end_time!);
    expect(end - before).toBeGreaterThanOrEqual(14 * 86_400_000 - 1000);
    expect(end - before).toBeLessThan(14 * 86_400_000 + 5000);
    await expect(
      xAdsProposeCreateCampaignTool.execute(ctx(), { account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "x", objective: "ENGAGEMENTS", daily_budget: 10, tweet_ids: ["1"], duration_days: 7, end_time: "2099-01-01T00:00:00Z", rationale: "r" }),
    ).rejects.toMatchObject({ code: "x_ads_dates_invalid" });
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "Later", objective: "ENGAGEMENTS", daily_budget: 10, tweet_ids: ["1"],
      locations: [{ id: "96683cc9126741d1", name: "United States" }], start_time: "2099-01-01T00:00:00Z", duration_days: 7, rationale: "r",
    });
    const later = (emitted[1].body as { exact_change: { rows: Array<{ item: string; after: string }> } }).exact_change.rows;
    expect(later).toContainEqual({ item: "Starts", before: "None", after: "2099-01-01T00:00:00Z (or when approved, if later)" });
    expect(later).toContainEqual({ item: "Ends", before: "None", after: "7 days after it starts" });
  });

  it("a post's length counts a link as 23", async () => {
    const base = { account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "x", objective: "ENGAGEMENTS", daily_budget: 10, locations: [], rationale: "r" };
    const words = "w".repeat(250);
    await xAdsProposeCreateCampaignTool.execute(ctx(), { ...base, new_post_text: `${words} https://example.com/${"a".repeat(120)}` });
    expect(emitted).toHaveLength(1);
    await expect(xAdsProposeCreateCampaignTool.execute(ctx(), { ...base, new_post_text: "w".repeat(281) })).rejects.toThrow();
  });

  it("refuses a campaign with no post, a website clicks post without a link, and a video views new post", async () => {
    const base = { account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "x", daily_budget: 10, locations: [], rationale: "r" };
    await expect(xAdsProposeCreateCampaignTool.execute(ctx(), { ...base, objective: "ENGAGEMENTS" })).rejects.toMatchObject({ code: "x_ads_no_post" });
    await expect(xAdsProposeCreateCampaignTool.execute(ctx(), { ...base, objective: "WEBSITE_CLICKS", new_post_text: "No link here" })).rejects.toMatchObject({ code: "x_ads_post_no_link" });
    await expect(xAdsProposeCreateCampaignTool.execute(ctx(), { ...base, objective: "VIDEO_VIEWS", new_post_text: "Words only https://e.x" })).rejects.toMatchObject({ code: "x_ads_post_no_video" });
    await expect(xAdsProposeCreateCampaignTool.execute(ctx(), { ...base, objective: "FOLLOWERS", tweet_ids: ["1"] })).rejects.toMatchObject({ code: "x_ads_objective_unsupported" });
    expect(emitted).toHaveLength(0);
  });

  it("a place both targeted and excluded is refused before any card", async () => {
    const both = { id: "96683cc9126741d1", name: "United States" };
    await expect(
      xAdsProposeCreateCampaignTool.execute(ctx(), {
        account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "Both", objective: "ENGAGEMENTS", daily_budget: 10, tweet_ids: ["1"],
        locations: [both], excluded_locations: [both], rationale: "x",
      }),
    ).rejects.toMatchObject({ code: "x_ads_locations_overlap" });
    expect(emitted).toHaveLength(0);
  });

  it("a create approved as ACTIVE is switched on only after everything is built", async () => {
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "Live", objective: "ENGAGEMENTS", daily_budget: 10,
      tweet_ids: ["1"], launch: "ACTIVE", rationale: "asked for it live",
    });
    expect(await executeXCreateCampaign(human(emitted[0].body))).toMatchObject({ ok: true });
    const writes = calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.split("/").slice(-1)[0]}`);
    expect(writes[0]).toBe("POST campaigns");
    expect(writes.at(-1)).toMatch(/^PUT /);
    expect([...campaigns.values()][0].entity_status).toBe("ACTIVE");
  });
});

describe("the handlers refuse rather than write", () => {
  it("drift: a resume whose daily budget moved since the card", async () => {
    seed({ id: "c9", entity_status: "PAUSED" });
    await xAdsProposeResumeCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c9", rationale: "r" });
    campaigns.get("c9")!.daily_budget_amount_local_micro = 500_000_000;
    expect(await executeXSetStatus(human(emitted[0].body))).toMatchObject({ ok: false, code: "x_ads_campaign_drifted" });
    expect(campaigns.get("c9")?.entity_status).toBe("PAUSED");
  });

  it("drift: an update whose campaign changed since the card", async () => {
    seed({ id: "c9" });
    await xAdsProposeUpdateCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c9", daily_budget: 60, rationale: "r" });
    campaigns.get("c9")!.name = "Renamed by hand";
    expect(await executeXUpdateCampaign(human(emitted[0].body))).toMatchObject({ ok: false, code: "x_ads_campaign_drifted" });
  });

  it("a CGO approval may pause but never open spend", async () => {
    seed({ id: "c9", entity_status: "PAUSED" });
    await xAdsProposeResumeCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c9", rationale: "r" });
    expect(await executeXSetStatus({ tenant_id: "t1", body: emitted[0].body, approved_by_source: "cgo" })).toMatchObject({ ok: false, code: "x_ads_needs_person" });
    seed({ id: "c8" });
    await xAdsProposeUpdateCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c8", daily_budget: 90, rationale: "r" });
    expect(await executeXUpdateCampaign({ tenant_id: "t1", body: emitted[1].body, approved_by_source: "cgo" })).toMatchObject({ code: "x_ads_needs_person" });
    await xAdsProposePauseCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c8", rationale: "r" });
    expect(await executeXSetStatus({ tenant_id: "t1", body: emitted[2].body, approved_by_source: "cgo" })).toMatchObject({ ok: true });
  });

  it("the staff channel lock stops every change but a pause, and an unreadable lock refuses", async () => {
    seed({ id: "c9", entity_status: "PAUSED" });
    seed({ id: "c8" });
    await xAdsProposeResumeCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c9", rationale: "r" });
    await xAdsProposePauseCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c8", rationale: "r" });
    mocks.locked.mockResolvedValue(true);
    expect(await executeXSetStatus(human(emitted[0].body))).toMatchObject({ ok: false, code: "x_ads_write_disabled" });
    expect(await executeXSetStatus(human(emitted[1].body))).toMatchObject({ ok: true });
    mocks.locked.mockRejectedValue(new Error("down"));
    expect(await executeXSetStatus(human(emitted[0].body))).toMatchObject({ ok: false, code: "x_ads_write_disabled" });
    expect(campaigns.get("c9")?.entity_status).toBe("PAUSED");
  });

  it("only a pause passes a CGO approval, the staff lock or a plan without X Ads", async () => {
    seed({ id: "c8" });
    await xAdsProposeUpdateCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c8", name: "Renamed", rationale: "r" });
    await xAdsProposeUpdateCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c8", daily_budget: 10, rationale: "r" });
    await xAdsProposePauseCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c8", rationale: "r" });
    expect(await executeXUpdateCampaign({ tenant_id: "t1", body: emitted[0].body, approved_by_source: "cgo" })).toMatchObject({ code: "x_ads_needs_person" });
    mocks.locked.mockResolvedValue(true);
    expect(await executeXUpdateCampaign(human(emitted[1].body))).toMatchObject({ code: "x_ads_write_disabled" });
    mocks.locked.mockResolvedValue(false);
    mocks.plan.mockResolvedValue({ slug: "x_ads", required_tier: "pro" });
    expect(await executeXUpdateCampaign(human(emitted[1].body))).toMatchObject({ code: "plan_upgrade_required" });
    expect(campaigns.get("c8")).toMatchObject({ name: "Spring", daily_budget_amount_local_micro: 50_000_000 });
    expect(await executeXSetStatus(human(emitted[2].body))).toMatchObject({ ok: true });
    expect(campaigns.get("c8")?.entity_status).toBe("PAUSED");
  });

  it("a resume refuses a budget over Zavi's caps and a total budget that moved", async () => {
    seed({ id: "c9", entity_status: "PAUSED", daily_budget_amount_local_micro: 20_000 * 1_000_000 });
    seed({ id: "c7", entity_status: "PAUSED", total_budget_amount_local_micro: 500_000_000 });
    await xAdsProposeResumeCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c9", rationale: "r" });
    await xAdsProposeResumeCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c7", rationale: "r" });
    expect(await executeXSetStatus(human(emitted[0].body))).toMatchObject({ ok: false, code: "x_ads_budget_over_cap" });
    campaigns.get("c7")!.total_budget_amount_local_micro = 900_000_000;
    expect(await executeXSetStatus(human(emitted[1].body))).toMatchObject({ ok: false, code: "x_ads_campaign_drifted" });
    expect(campaigns.get("c9")?.entity_status).toBe("PAUSED");
    expect(campaigns.get("c7")?.entity_status).toBe("PAUSED");
  });

  it("a create whose outcome is unclear can never be approved again", async () => {
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "Lost", objective: "REACH", daily_budget: 5, tweet_ids: ["7"], launch: "ACTIVE", rationale: "r",
    });
    failNext = { method: "POST", pathEnds: "campaigns", status: 503 };
    expect(await executeXCreateCampaign(human(emitted[0].body))).toMatchObject({ ok: false, outcome_unknown: true, code: "exec_outcome_unknown" });
    throwNext = { method: "PUT" };
    expect(await executeXCreateCampaign(human(emitted[0].body))).toMatchObject({ ok: false, outcome_unknown: true, code: "exec_outcome_unknown" });    failNext = { method: "PUT", pathEnds: "c" + nextId, status: 400 };
    expect(await executeXCreateCampaign(human(emitted[0].body))).toMatchObject({ ok: false, code: "exec_partial" });
  });

  it("a resume refuses a campaign with no readable budget", async () => {
    seed({ id: "c6", entity_status: "PAUSED" });
    await xAdsProposeResumeCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c6", rationale: "r" });
    campaigns.get("c6")!.daily_budget_amount_local_micro = null as never;
    const body = { ...emitted[0].body, daily_budget: null };
    expect(await executeXSetStatus(human(body))).toMatchObject({ ok: false, code: "x_ads_budget_over_cap" });
    expect(campaigns.get("c6")?.entity_status).toBe("PAUSED");
  });

  it("an already-paused campaign is a success with no write", async () => {
    seed({ id: "c9" });
    await xAdsProposePauseCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c9", rationale: "r" });
    campaigns.get("c9")!.entity_status = "PAUSED";
    calls = [];
    expect(await executeXSetStatus(human(emitted[0].body))).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("budget ceilings hold in the handler even on an edited body", async () => {
    seed({ id: "c9" });
    const body = { account_id: ACCOUNT, campaign_id: "c9", name: "Spring", changes: { daily_budget: 1_000_000 }, before: { name: "Spring", daily_budget: 50, total_budget: null } };
    expect(await executeXUpdateCampaign(human(body))).toMatchObject({ ok: false, code: "x_ads_body_invalid" });
  });

  it("a lost write response is outcome_unknown, never a failure", async () => {
    seed({ id: "c9" });
    await xAdsProposePauseCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c9", rationale: "r" });
    throwNext = { method: "PUT" };
    expect(await executeXSetStatus(human(emitted[0].body))).toMatchObject({ ok: false, outcome_unknown: true });
    failNext = { method: "PUT", pathEnds: "c9", status: 503 };
    expect(await executeXSetStatus(human(emitted[0].body))).toMatchObject({ ok: false, outcome_unknown: true });
  });

  it("a half-built create is removed, and X's reason reaches the person", async () => {
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "Bad post", objective: "REACH", daily_budget: 5, tweet_ids: ["7"], rationale: "r",
    });
    failNext = { method: "POST", pathEnds: "promoted_tweets", status: 400 };
    const r = await executeXCreateCampaign(human(emitted[0].body));
    expect(r).toMatchObject({ ok: false, code: "exec_partial" });
    expect(r.error).toContain("INVALID_PARAMETER");
    expect([...campaigns.values()].every((c) => c.entity_status === "PAUSED" && !c.deleted)).toBe(true);
    expect(calls.some(c => c.method === "DELETE")).toBe(false);
  });

  it("not connected asks for a reconnect before any call", async () => {
    mocks.secret.mockResolvedValue(null);
    expect(await executeXSetStatus(human({ account_id: ACCOUNT, campaign_id: "c9", name: "x", status: "PAUSED", daily_budget: 1, currency: "USD", rationale: "r", summary: "s", exact_change: { rows: [] } }))).toMatchObject({ code: "x_ads_not_connected" });
    expect(calls).toHaveLength(0);
  });
});

describe("propose tools read live and refuse nonsense", () => {
  it("pause refuses a campaign that is not running; resume refuses one that is", async () => {
    seed({ id: "c1", entity_status: "PAUSED" });
    seed({ id: "c2", entity_status: "ACTIVE" });
    await expect(xAdsProposePauseCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c1", rationale: "r" })).rejects.toMatchObject({ code: "x_ads_campaign_already" });
    await expect(xAdsProposeResumeCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c2", rationale: "r" })).rejects.toMatchObject({ code: "x_ads_campaign_already" });
    expect(emitted).toHaveLength(0);
  });

  it("update refuses no-op and daily > total", async () => {
    seed({ id: "c1", total_budget_amount_local_micro: 100_000_000 });
    await expect(xAdsProposeUpdateCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c1", daily_budget: 50, rationale: "r" })).rejects.toMatchObject({ code: "x_ads_no_change" });
    await expect(xAdsProposeUpdateCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c1", daily_budget: 200, rationale: "r" })).rejects.toMatchObject({ code: "x_ads_budget_invalid" });
  });

  it("create refuses a funding instrument that is not on the account", async () => {
    await expect(
      xAdsProposeCreateCampaignTool.execute(ctx(), { account_id: ACCOUNT, funding_instrument_id: "zzz", name: "n", objective: "REACH", daily_budget: 5, tweet_ids: ["1"], rationale: "r" }),
    ).rejects.toMatchObject({ code: "x_ads_funding_not_found" });
  });

  it("with no sink at all, nothing is proposed", async () => {
    seed({ id: "c1" });
    await expect(xAdsProposePauseCampaignTool.execute(ctx({ emit_decision: undefined }), { account_id: ACCOUNT, campaign_id: "c1", rationale: "r" })).rejects.toMatchObject({ code: "x_ads_propose_unavailable" });
  });
});

describe("where a proposal lands", () => {
  it("an x_ads channel run files an executable card", async () => {
    mocks.switched.mockResolvedValue("x_ads");
    seed({ id: "c1" });
    const emit_decision = await resolveXAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: chatEmit });
    await xAdsProposePauseCampaignTool.execute(ctx({ emit_decision }), { account_id: ACCOUNT, campaign_id: "c1", rationale: "r" });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        execClass: "x_ads.set_status",
        actionType: "pause_ad",
        channelSlug: "x_ads",
        execPayload: expect.objectContaining({ campaign_id: "c1", status: "PAUSED" }),
        body: expect.objectContaining({ exact_change: { rows: [{ item: 'Campaign "Spring"', before: "Active", after: "Paused" }] } }),
      }),
    );
    expect(emitted).toHaveLength(0);
  });

  it("a chat turn keeps its own emit_decision (a decision)", async () => {
    mocks.switched.mockResolvedValue(null);
    expect(await resolveXAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: chatEmit })).toBe(chatEmit);
  });

  it("a chat decision gets an inline card in the thread", () => {
    const card = buildInlineDecisionBody({
      decision_id: "00000000-0000-4000-8000-000000000001",
      decision_class: "x_ads.set_status",
      body: { status: "PAUSED", campaign_id: "c1" },
    });
    expect(card).toMatchObject({ title: "X Ads: pause a campaign", subject: "c1" });
  });

  it("the MCP surface lists exactly the four reads and four proposals", async () => {
    expect(listXAdsTools().map((t) => `${t.tool_name}:${t.effect}`).sort()).toEqual([
      "verify_permissions:read",
      "read_ad_groups:read",
      "check_conversions:read",
      "propose_manage_objects:write",
      "list_accounts:read",
      "list_campaigns:read",
      "list_funding_instruments:read",
      "propose_create_campaign:write",
      "propose_pause_campaign:write",
      "propose_resume_campaign:write",
      "propose_update_campaign:write",
      "search_locations:read",
    ].sort());
    mocks.switched.mockResolvedValue(null);
    seed({ id: "c1" });
    const r = await callXAdsTool({ tenant_id: "t1", run_id: "r1", emit_decision: chatEmit }, "propose_pause_campaign", { account_id: ACCOUNT, campaign_id: "c1", rationale: "r" });
    expect(r.ok).toBe(true);
    expect(emitted[0].cls).toBe("x_ads.set_status");
  });
});

describe("stats", () => {
  it("splits a window into X's 7-day maximum", () => {
    expect(statsWindows("2026-09-01", "2026-09-30")).toEqual([
      { start: "2026-09-01T00:00:00Z", end: "2026-09-08T00:00:00Z" },
      { start: "2026-09-08T00:00:00Z", end: "2026-09-15T00:00:00Z" },
      { start: "2026-09-15T00:00:00Z", end: "2026-09-22T00:00:00Z" },
      { start: "2026-09-22T00:00:00Z", end: "2026-09-29T00:00:00Z" },
      { start: "2026-09-29T00:00:00Z", end: "2026-10-01T00:00:00Z" },
    ]);
  });

  it("sums spend, link clicks and conversions per campaign across windows", async () => {
    const m = await xCampaignStats({ key: "tk", secret: "ts" }, ACCOUNT, ["c1"], "2026-09-01", "2026-09-14");
    expect(m.get("c1")).toEqual({ spend: 20, impressions: 2000, clicks: 40, conversions: 2 });
  });

  it("list_campaigns returns budgets in units and the window's numbers", async () => {
    seed({ id: "c1", total_budget_amount_local_micro: 900_000_000 });
    const out = (await xAdsListCampaignsTool.execute(ctx(), { account_id: ACCOUNT, days: 7 })) as { campaigns: Array<Record<string, unknown>> };
    expect(out.campaigns[0]).toMatchObject({ campaign_id: "c1", daily_budget: 50, total_budget: 900, spend: 10, conversions: 1, cost_per_conversion: 10 });
  });
});

describe("conversions X will not report are unknown, not zero", () => {
  it("list_campaigns returns null conversions and says why", async () => {
    seed({ id: "c1" });
    failNext = { method: "GET", pathEnds: ACCOUNT, status: 400 };
    const out = (await xAdsListCampaignsTool.execute(ctx(), { account_id: ACCOUNT, days: 7 })) as { campaigns: Array<Record<string, unknown>>; conversions_note?: string };
    expect(out.campaigns[0]).toMatchObject({ spend: 10, conversions: null, cost_per_conversion: null });
    expect(out.conversions_note).toMatch(/unknown, not zero/);
  });
});

describe("the X Ads channel dashboard", () => {
  const read = async (tenantId: string) => {
    const { build } = await import("@/routes/agents/dashboards/x-ads");
    return (await build({ tenantId, rangeDays: 7, refresh: true, meteredRefresh: false } as never)) as import("@/routes/agents/dashboards/x-ads").XAdsPayload;
  };

  it("reads totals and every live campaign with its budget", async () => {
    seed({ id: "c1" });
    seed({ id: "c2", name: "Old", entity_status: "PAUSED", deleted: true });
    seed({ id: "c3", name: "Paused", entity_status: "PAUSED" });
    const p = await read("t-dash-1");
    expect(p).toMatchObject({ platform: "x_ads", connected: true, error_code: null });
    expect(p.account).toMatchObject({ name: "Main", campaign_count: 2, active_count: 1, currency: "USD" });
    expect(p.campaigns.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(p.campaigns[0]).toMatchObject({ daily_budget: 50, spend: 10, conversions: 1, cpa: 10 });
    expect(p.totals).toMatchObject({ spend: 20, conversions: 2, clicks: 40 });
  });

  it("not connected is an empty payload, not an error", async () => {
    mocks.secret.mockResolvedValue(null);
    expect(await read("t-dash-2")).toMatchObject({ connected: false, error_code: null, campaigns: [] });
  });

  it("a refused read surfaces its code", async () => {
    failNext = { method: "GET", pathEnds: "/accounts", status: 403 };
    expect(await read("t-dash-3")).toMatchObject({ connected: true, error_code: "x_ads_forbidden" });
  });
});

describe("spend authority and holds (review of #4030)", () => {
  const held = { status: "held", tenant_id: "t1", idem_key: "k", fresh: true };

  it("a member cannot approve a resume, a raise or a live create; a pause and a cut stay open", async () => {
    mocks.role.mockResolvedValue("member");
    seed({ id: "c8", entity_status: "PAUSED" });
    seed({ id: "c9" });
    await xAdsProposeResumeCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c8", rationale: "r" });
    await xAdsProposePauseCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c9", rationale: "r" });
    const resume = { ...human(emitted[0].body), decision_class: "x_ads.set_status" };
    expect(await executeXSetStatus(resume)).toMatchObject({ ok: false, code: "x_ads_admin_required" });
    expect(campaigns.get("c8")?.entity_status).toBe("PAUSED");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(await executeXSetStatus({ ...human(emitted[1].body), decision_class: "x_ads.set_status" })).toMatchObject({ ok: true });
    const raise = { account_id: ACCOUNT, campaign_id: "c9", name: "Spring", changes: { daily_budget: 60 }, before: { name: "Spring", daily_budget: 50, total_budget: null }, currency: "USD", rationale: "r", summary: "s", exact_change: { rows: [] } };
    expect(await executeXUpdateCampaign({ ...human(raise), decision_class: "x_ads.update_campaign" })).toMatchObject({ code: "x_ads_admin_required" });
    mocks.role.mockRejectedValue(new Error("db down"));
    expect(await executeXSetStatus(resume)).toMatchObject({ ok: false, code: "x_ads_role_unavailable" });
    mocks.role.mockResolvedValue("admin");
    expect(await executeXSetStatus(resume)).toMatchObject({ ok: true });
  });

  it("a failed read-back after a resume keeps the hold (the campaign may be spending)", async () => {
    mocks.reserve.mockResolvedValue(held);
    seed({ id: "c8", entity_status: "PAUSED" });
    await xAdsProposeResumeCampaignTool.execute(ctx(), { account_id: ACCOUNT, campaign_id: "c8", rationale: "r" });
    failReadAfterPut = 429;
    expect(await executeXSetStatus(human(emitted[0].body))).toMatchObject({ ok: false, outcome_unknown: true });
    expect(campaigns.get("c8")?.entity_status).toBe("ACTIVE");
    expect(mocks.drop).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("a live create: a refused switch-on gives the hold back, an unread one keeps it", async () => {
    mocks.reserve.mockResolvedValue(held);
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "Live", objective: "ENGAGEMENTS", daily_budget: 10, tweet_ids: ["1"], launch: "ACTIVE", rationale: "asked for it live",
    });
    failNext = { method: "PUT", pathEnds: "c" + nextId, status: 400 };
    expect(await executeXCreateCampaign(human(emitted[0].body))).toMatchObject({ ok: false, code: "exec_partial" });
    expect(mocks.drop).toHaveBeenCalledTimes(1);
    mocks.drop.mockClear();
    calls = [];
    failReadAfterPut = 429;
    expect(await executeXCreateCampaign(human(emitted[0].body))).toMatchObject({ ok: false, outcome_unknown: true, code: "exec_outcome_unknown" });
    expect(mocks.drop).not.toHaveBeenCalled();
  });
});

describe("a cgo test's X campaign carries the test's end", () => {
  const propose = async (extra: Record<string, unknown> = {}) => {
    await xAdsProposeCreateCampaignTool.execute(ctx(), {
      account_id: ACCOUNT, funding_instrument_id: "lygyi", name: "Live", objective: "ENGAGEMENTS", daily_budget: 10,
      tweet_ids: ["1"], launch: "ACTIVE", rationale: "test", ...extra,
    });
    return emitted.at(-1)!.body;
  };
  beforeEach(() => {
    testEndMock.end = { decision_id: "order-1", channel: "x_ads", ends_on: "2099-01-15" };
  });

  it("the line item gets the test's end and the campaign goes on only after X reads it back", async () => {
    const r = await executeXCreateCampaign({ ...human(await propose()), agent_run_id: "run-1" });
    expect(r).toMatchObject({ ok: true });
    expect([...lineItems.values()][0].end_time).toBe("2099-01-15T00:00:00Z");
    const getLi = calls.findIndex((c) => c.method === "GET" && /line_items\/li/.test(c.path));
    const on = calls.findIndex((c) => c.method === "PUT");
    expect(getLi).toBeGreaterThan(-1);
    expect(getLi).toBeLessThan(on);
    expect([...campaigns.values()][0].entity_status).toBe("ACTIVE");
  });

  it("a card's later end is cut to the test's; a sooner one is kept", async () => {
    await executeXCreateCampaign({ ...human(await propose({ end_time: "2099-03-01T00:00:00Z" })), agent_run_id: "run-1" });
    expect([...lineItems.values()].at(-1)!.end_time).toBe("2099-01-15T00:00:00Z");
    await executeXCreateCampaign({ ...human(await propose({ end_time: "2099-01-10T00:00:00Z" })), id: "action-2", agent_run_id: "run-1" });
    expect([...lineItems.values()].at(-1)!.end_time).toBe("2099-01-10T00:00:00Z");
  });

  it("X does not keep the end: the campaign stays paused and the card cannot run again", async () => {
    dropLineItemEnd = true;
    const r = await executeXCreateCampaign({ ...human(await propose()), agent_run_id: "run-1" });
    expect(r).toMatchObject({ ok: false, code: "exec_partial" });
    expect(String(r.error)).toMatch(/not switched on/);
    expect([...campaigns.values()][0].entity_status).toBe("PAUSED");
  });

  it("the test's end cannot be read: nothing is created", async () => {
    const { cgoTestEndForRun } = await import("@/services/growth/cgo-test-end");
    vi.mocked(cgoTestEndForRun).mockRejectedValueOnce(new Error("db down"));
    const r = await executeXCreateCampaign({ ...human(await propose()), agent_run_id: "run-1" });
    expect(r).toMatchObject({ ok: false, code: "x_ads_test_end_unreadable" });
    expect(campaigns.size).toBe(0);
  });
});
