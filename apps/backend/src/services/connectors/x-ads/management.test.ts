import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  secret: vi.fn(),
  lock: vi.fn(),
  plan: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  role: vi.fn(),
}));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: mocks.role }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: mocks.secret }));
vi.mock("@/services/channels/lock", async (orig) => ({
  ...(await orig<object>()),
  isChannelLockedStrict: mocks.lock,
}));
vi.mock("@/services/growth/preview-plan", async (orig) => ({
  ...(await orig<object>()),
  channelPlanLock: mocks.plan,
}));
vi.mock("@/services/decisions/ad-budget", async (orig) => ({
  ...(await orig<object>()),
  reserveAdSpend: mocks.reserve,
  releaseAdSpendForObject: mocks.release,
}));
import { readXManagementSnapshot, executeXManageObjects } from "./management";
import { xAdsProposeManageObjectsTool } from "@/services/tools/x-ads/manage_objects";
import { buildXExecCardBody } from "@/services/tools/x-ads/_exec-action";
import type { XManagementInput } from "./management-schema";

let campaignVersion: string;
let groupCampaign: string;
let groupVersion: string;
let writes: Array<{
  path: string;
  method: string;
  params: Record<string, string>;
}>;
let failWrite: boolean;
const emit = vi.fn();
const campaign = () => ({
  id: "c1",
  name: "Campaign",
  entity_status: "ACTIVE",
  daily_budget_amount_local_micro: 10000000,
  total_budget_amount_local_micro: 100000000,
  currency: "USD",
  updated_at: campaignVersion,
});
const group = () => ({
  id: "li1",
  name: "Group",
  campaign_id: groupCampaign,
  objective: "WEBSITE_CLICKS",
  product_type: "PROMOTED_TWEETS",
  entity_status: "PAUSED",
  start_time: "2099-01-01T00:00:00Z",
  end_time: "2099-02-01T00:00:00Z",
  bid_strategy: "AUTO",
  bid_amount_local_micro: null,
  currency: "USD",
  updated_at: groupVersion,
});
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.secret.mockResolvedValue("test");
  mocks.lock.mockResolvedValue(false);
  mocks.role.mockResolvedValue("owner");
  mocks.plan.mockResolvedValue(null);
  mocks.reserve.mockResolvedValue({
    status: "refused",
    error: "cap_refuse: daily_limit",
  });
  emit.mockResolvedValue("proposal");
  process.env.X_ADS_CONSUMER_KEY = "test";
  process.env.X_ADS_CONSUMER_SECRET = "test";
  campaignVersion = "2026-10-09T00:00:00Z";
  groupVersion = campaignVersion;
  groupCampaign = "c1";
  writes = [];
  failWrite = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname;
      const method = init.method ?? "GET";
      const params = Object.fromEntries(url.searchParams);
      if (method !== "GET") {
        writes.push({ path, method, params });
        if (failWrite) throw new Error("socket lost");
        return reply({
          data: {
            id: method === "DELETE" ? path.split("/").at(-1) : "new1",
            deleted: method === "DELETE",
            entity_status: params.entity_status,
          },
        });
      }
      if (path.endsWith("authenticated_user_access"))
        return reply({ data: { user_id: "1", permissions: ["AD_MANAGER"] } });
      if (path.endsWith("campaigns/c1")) return reply({ data: campaign() });
      if (path.endsWith("line_items/li1")) return reply({ data: group() });
      if (path.endsWith("line_items")) return reply({ data: [group()] });
      if (path.endsWith("promoted_tweets/p1"))
        return reply({
          data: {
            id: "p1",
            line_item_id: "li1",
            tweet_id: "123",
            updated_at: groupVersion,
          },
        });
      if (path.endsWith("targeting_criteria/t1"))
        return reply({
          data: {
            id: "t1",
            line_item_id: "li1",
            targeting_type: "LOCATION",
            targeting_value: "abc",
            operator_type: "EQ",
            updated_at: groupVersion,
          },
        });
      return reply({ errors: [{ code: "NOT_FOUND", message: path }] }, 404);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const propose = (request: XManagementInput) =>
  xAdsProposeManageObjectsTool.execute(
    { tenant_id: "tenant", log: () => {}, emit_decision: emit },
    { request, rationale: "Reviewed live campaign and performance." },
  );
const approved = () => ({
  id: "action1",
  tenant_id: "tenant",
  body: emit.mock.calls[0][1],
  approved_by: "u1",
  approved_by_source: "founder",
});

describe("X Ads management approval lifecycle", () => {
  it("deletion proposes without writing, requires a person, and refuses version drift", async () => {
    await propose({
      account_id: "a1",
      campaign_id: "c1",
      operation: "delete_campaign",
    });
    expect(writes).toEqual([]);
    const card = buildXExecCardBody("x_ads.manage_objects", emit.mock.calls[0][1]);
    expect(card.title).toMatch(/delete campaign/);
    expect(card.card.link).toBe("https://ads.x.com/campaign_manager/a1/campaigns");
    expect(
      await executeXManageObjects({ ...approved(), approved_by_source: "cgo" }),
    ).toMatchObject({ ok: false, code: "x_ads_needs_person" });
    campaignVersion = "2026-10-09T01:00:00Z";
    expect(await executeXManageObjects(approved())).toMatchObject({
      ok: false,
      code: "x_ads_object_drifted",
    });
    expect(writes).toEqual([]);
    campaignVersion = "2026-10-09T00:00:00Z";
    expect(await executeXManageObjects(approved())).toMatchObject({ ok: true });
    expect(writes).toEqual([
      { method: "DELETE", path: "/12/accounts/a1/campaigns/c1", params: {} },
    ]);
  });
  it("rejects an ad group from another campaign", async () => {
    groupCampaign = "c2";
    await expect(
      readXManagementSnapshot("tenant", {
        account_id: "a1",
        campaign_id: "c1",
        line_item_id: "li1",
        operation: "delete_ad_group",
      }),
    ).rejects.toMatchObject({ code: "x_ads_parent_mismatch" });
    expect(writes).toEqual([]);
  });
  it("creates an ad group paused and obeys the campaign objective", async () => {
    const request = {
      account_id: "a1",
      campaign_id: "c1",
      operation: "create_ad_group" as const,
      objective: "WEBSITE_CLICKS" as const,
      name: "Paused group",
      start_time: "2099-01-01T00:00:00Z",
      end_time: "2099-01-07T00:00:00Z",
    };
    await propose(request);
    expect(await executeXManageObjects(approved())).toMatchObject({ ok: true });
    expect(writes[0]).toMatchObject({
      method: "POST",
      path: "/12/accounts/a1/line_items",
      params: {
        entity_status: "PAUSED",
        campaign_id: "c1",
        product_type: "PROMOTED_TWEETS",
      },
    });
    await expect(
      propose({ ...request, objective: "REACH" }),
    ).rejects.toMatchObject({ code: "x_ads_ad_group_incompatible" });
  });
  it("removes the promoted association id rather than deleting the original post", async () => {
    await propose({
      account_id: "a1",
      campaign_id: "c1",
      line_item_id: "li1",
      operation: "remove_promoted_ad",
      promoted_tweet_id: "p1",
    });
    expect(await executeXManageObjects(approved())).toMatchObject({ ok: true });
    expect(writes[0].path).toBe("/12/accounts/a1/promoted_tweets/p1");
  });
  it("adds documented targeting and changes bids and schedule through line items", async () => {
    await propose({
      account_id: "a1",
      campaign_id: "c1",
      line_item_id: "li1",
      operation: "add_target",
      targeting_type: "EXACT_KEYWORD",
      targeting_value: "software",
      operator_type: "NE",
    });
    expect(await executeXManageObjects(approved())).toMatchObject({ ok: true });
    expect(writes[0]).toMatchObject({
      path: "/12/accounts/a1/targeting_criteria",
      params: {
        line_item_id: "li1",
        targeting_type: "EXACT_KEYWORD",
        operator_type: "NE",
        targeting_value: "software",
      },
    });
  });
  it("a cap refusal prevents activation", async () => {
    await propose({
      account_id: "a1",
      campaign_id: "c1",
      line_item_id: "li1",
      operation: "update_ad_group",
      changes: { entity_status: "ACTIVE" },
    });
    expect(await executeXManageObjects(approved())).toMatchObject({
      ok: false,
      code: "x_ads_budget_refused",
    });
    expect(writes).toEqual([]);
  });
  it("uncertain child creation blocks automatic retry", async () => {
    await propose({
      account_id: "a1",
      campaign_id: "c1",
      operation: "create_ad_group",
      objective: "WEBSITE_CLICKS",
      name: "Paused",
      start_time: "2099-01-01T00:00:00Z",
      end_time: "2099-01-07T00:00:00Z",
    });
    failWrite = true;
    expect(await executeXManageObjects(approved())).toMatchObject({
      ok: false,
      code: "exec_outcome_unknown",
      outcome_unknown: true,
    });
  });
});
