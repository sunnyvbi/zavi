import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), proxy: vi.fn() }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: mocks.exec, composioProxy: mocks.proxy }));
import { createImagePost, createObject, patchObject, writeFailure } from "./writes";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
const account = { tenant_id: "tenant_1", toolkit: "reddit_ads", connected_account_id: "sealed", auth_config_id: "config" } as OwnedComposioAccount;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.exec.mockResolvedValue({ ok: true, status: 200, data: { data: { id: "created" } } });
  mocks.proxy.mockResolvedValue({ ok: true, status: 200, json: { data: { id: "created" } } });
});
describe("Reddit write transport", () => {
  it("uses authenticated fixed POST endpoints and exact image content fields", async () => {
    const data = { type: "IMAGE", headline: "A real headline", content: [{ media_url: "https://example.com/image.jpg", destination_url: "https://example.com" }] };
    await createImagePost(account, "t2_profile", data);
    expect(mocks.proxy).toHaveBeenCalledWith({ account, method: "POST", endpoint: "https://ads-api.reddit.com/api/v3/profiles/t2_profile/posts", body: { data } }, expect.any(AbortSignal));
    await createObject(account, "account_1", "ad", { ad_group_id: "g1", post_id: "t3_post", configured_status: "PAUSED" });
    expect(mocks.proxy).toHaveBeenLastCalledWith(expect.objectContaining({ method: "POST", endpoint: "https://ads-api.reddit.com/api/v3/ad_accounts/account_1/ads", body: { data: { ad_group_id: "g1", post_id: "t3_post", configured_status: "PAUSED" } } }), expect.any(AbortSignal));
  });
  it("uses native campaign tools and PATCH for missing group/ad tools", async () => {
    await patchObject(account, "campaign", "c1", { configured_status: "PAUSED" });
    expect(mocks.exec).toHaveBeenCalledWith(expect.objectContaining({ tool_slug: "REDDIT_ADS_UPDATE_CAMPAIGN", user_id: "tenant_1", connected_account_id: "sealed", arguments: { campaign_id: "c1", data: { configured_status: "PAUSED" } } }), expect.any(AbortSignal));
    await patchObject(account, "ad_group", "g1", { goal_value: 5000000 });
    expect(mocks.proxy).toHaveBeenLastCalledWith({ account, method: "PATCH", endpoint: "https://ads-api.reddit.com/api/v3/ad_groups/g1", body: { data: { goal_value: 5000000 } } }, expect.any(AbortSignal));
  });
  it("treats a successful create with no ID as unknown and never retries writes", async () => {
    mocks.proxy.mockResolvedValue({ ok: false, status: 503, json: {} });
    await expect(createObject(account, "account_1", "ad", {})).rejects.toMatchObject({ code: "reddit_ads_outcome_unknown" });
    expect(mocks.proxy).toHaveBeenCalledTimes(1);
    mocks.proxy.mockResolvedValue({ ok: true, status: 200, json: {} });
    await expect(createImagePost(account, "profile", {})).rejects.toMatchObject({ code: "reddit_ads_outcome_unknown" });
    mocks.exec.mockResolvedValue({ ok: false, status: 0, error: "transport", outcome_unknown: true });
    await expect(createObject(account, "account_1", "campaign", {})).rejects.toMatchObject({ code: "reddit_ads_outcome_unknown" });
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(writeFailure(200, "Reddit 403 forbidden").code).toBe("reddit_ads_permission_denied");
    expect(writeFailure(429, "slow down").code).toBe("reddit_ads_rate_limited");
  });
  it("treats a Reddit 400 as a definite, unretried rejection and names the fields to correct", async () => {
    mocks.exec.mockResolvedValue({ ok: false, status: 200, error: 'Error: 400 Client Error: Bad Request {\\"error\\": {\\"code\\": 400, \\"message\\": \\"Bad request.\\", \\"fields\\": [{\\"field\\": \\"start_time\\", \\"message\\": \\"must be a valid datetime\\"}]}}', outcome_unknown: false });
    await expect(createObject(account, "account_1", "ad_group", {})).rejects.toMatchObject({ code: "reddit_ads_invalid_request", message: "Reddit rejected the request: start_time: must be a valid datetime.", meta: { outcome_unknown: false } });
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    mocks.proxy.mockResolvedValue({ ok: false, status: 400, json: { error: { code: 400, message: "Bad request.", fields: [{ message: "Invalid value.", field: "click_url" }] } } });
    await expect(createObject(account, "account_1", "ad", {})).rejects.toMatchObject({ code: "reddit_ads_invalid_request", message: "Reddit rejected the request: click_url: Invalid value." });
    expect(mocks.proxy).toHaveBeenCalledTimes(1);
    expect(writeFailure(400, { error: { code: 400, message: "Spend cap too low" } }).message).toBe("Reddit rejected the request: Spend cap too low.");
  });
  it("reads a wrapped 422 from its status field, and never reads a bare number in a wrapped error as a rejection", async () => {
    mocks.exec.mockResolvedValue({ ok: false, status: 200, data: { error: "spend_cap: Input should be greater than or equal to 100000000", status_code: 422 }, error: "spend_cap: Input should be greater than or equal to 100000000", outcome_unknown: false });
    await expect(createObject(account, "account_1", "campaign", {})).rejects.toMatchObject({ code: "reddit_ads_invalid_request" });
    expect(writeFailure(200, "Error: 422 Client Error: Unprocessable Entity").code).toBe("reddit_ads_invalid_request");
    expect(writeFailure(200, "upstream error, retry in 400 ms").code).toBe("reddit_ads_request_failed");
    expect(writeFailure(200, "Request failed with status code 422").code).toBe("reddit_ads_invalid_request");
    expect(writeFailure(200, "HTTP 400").code).toBe("reddit_ads_invalid_request");
    expect(writeFailure(200, "Bad Request", true).code).toBe("reddit_ads_outcome_unknown");
  });
});
