import { describe, expect, it } from "vitest";
import { classifyAdReadError, isRetryableAdReadKind } from "../read-error-kind";
import { ExpectedToolError } from "@/services/tools/types";

const timeoutErr = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const META_17_BODY =
  '{"error":{"message":"User request limit reached","type":"OAuthException","is_transient":true,"code":17,"error_subcode":2446079,"fbtrace_id":"A1"}}';

const cases: Array<[string, unknown, ReturnType<typeof classifyAdReadError>]> = [
  ["Meta code 17 (structured)", new ExpectedToolError("meta_ads_query_failed", `Meta Ads request failed: 400 ${META_17_BODY}`, { http_status: 400, graph_code: 17, graph_subcode: 2446079, is_transient: true }), "rate_limited"],
  ["Meta code 17 (text only)", new Error(`Meta Ads request failed: 400 ${META_17_BODY}`), "rate_limited"],
  ["Meta code 613", new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed: 400 {}", { http_status: 400, graph_code: 613 }), "rate_limited"],
  ["Meta code 80004", new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed: 400 {}", { http_status: 400, graph_code: 80004 }), "rate_limited"],
  ["Meta code 190", new Error('Meta Ads request failed: 400 {"error":{"message":"Error validating access token","type":"OAuthException","code":190}}'), "auth"],
  ["Meta token expired", new ExpectedToolError("meta_ads_token_expired", "Meta Ads needs to be reconnected"), "auth"],
  ["Meta permission revoked", new ExpectedToolError("meta_ads_permission_revoked", "no longer has the required permission"), "auth"],
  ["Meta 500", new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed: 500 x", { http_status: 500 }), "vendor_error"],
  ["Meta transient code 2", new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed: 400 x", { http_status: 400, graph_code: 2 }), "vendor_error"],
  ["Meta timeout", new ExpectedToolError("meta_ads_timeout", "Meta Graph API did not respond within 15s"), "timeout"],
  ["Meta list cut", new ExpectedToolError("meta_ads_pagination_incomplete", "Meta act_1/adsets: more than 100 pages"), "unknown"],
  ["Google timeout", new ExpectedToolError("google_ads_timeout", "Google Ads API did not respond within 15s"), "timeout"],
  ["Google timeout (text)", new Error("Google Ads API did not respond within 15s"), "timeout"],
  ["Google 401", new ExpectedToolError("google_ads_unauthenticated", "Google Ads search failed: 401 {}"), "auth"],
  ["Google revoked", new ExpectedToolError("google_ads_token_revoked", "Google Ads authorization has expired or been revoked: 400 invalid_grant"), "auth"],
  ["Google OAuth refresh 503 is not auth", new ExpectedToolError("google_ads_oauth_refresh_failed", "Google OAuth refresh failed: 503 Service Unavailable"), "vendor_error"],
  ["Google UNAVAILABLE", new ExpectedToolError("google_ads_query_failed", 'Google Ads search failed: 503 {"error":{"code":503,"status":"UNAVAILABLE"}}'), "vendor_error"],
  ["Google INTERNAL", new Error('Google Ads search failed: 500 {"error":{"status":"INTERNAL"}}'), "vendor_error"],
  ["Google RESOURCE_EXHAUSTED", new Error('Google Ads search failed: 400 {"error":{"status":"RESOURCE_EXHAUSTED"}}'), "rate_limited"],
  ["Google DEADLINE_EXCEEDED", new Error('Google Ads search failed: 400 {"error":{"status":"DEADLINE_EXCEEDED"}}'), "timeout"],
  ["Google list cut", new ExpectedToolError("google_ads_query_truncated", "Google Ads search returned more than 10 pages"), "unknown"],
  ["TikTok HTTP 500", new ExpectedToolError("tiktok_ads_read_failed", "TikTok read failed (HTTP 500)."), "vendor_error"],
  ["TikTok HTTP 500 (text)", new Error("TikTok read failed (HTTP 500)."), "vendor_error"],
  ["TikTok HTTP 401", new ExpectedToolError("tiktok_ads_token_revoked", "TikTok read failed (HTTP 401)."), "auth"],
  ["TikTok 40100", new ExpectedToolError("tiktok_ads_rate_limited", "TikTok answered code 40100: Too many requests"), "rate_limited"],
  ["TikTok 40100 (text)", new Error("TikTok answered code 40100: request limit"), "rate_limited"],
  ["TikTok 50000", new ExpectedToolError("tiktok_ads_error", "TikTok answered code 50000: system error"), "vendor_error"],
  ["Composio list 500", new Error("composio list HTTP 500"), "vendor_error"],
  ["Meta cooldown refusal", new ExpectedToolError("meta_ads_busy", "Meta is busy for 4 min; try again after 16:20 UTC"), "rate_limited"],
  ["TikTok bad response", new ExpectedToolError("tiktok_ads_bad_response", "TikTok returned an invalid report response. Try again later."), "vendor_error"],
  ["Reddit UNAUTHORIZED", new Error('Reddit Ads read failed: {"reason":"UNAUTHORIZED"}'), "auth"],
  ["Reddit cannot be verified", new Error("Reddit Ads connection cannot be verified; spend is unknown. Reconnect Reddit Ads."), "auth"],
  ["Reddit revoked", new ExpectedToolError("reddit_ads_token_revoked", "Reddit Ads stopped accepting Zavi's access. Reconnect it."), "auth"],
  ["Reddit rate limited", new ExpectedToolError("reddit_ads_rate_limited", "Reddit Ads is limiting requests. Try again in a minute."), "rate_limited"],
  ["Reddit 429 (text)", new Error("Reddit Ads read failed: HTTP 429"), "rate_limited"],
  ["LinkedIn 401", new Error("LinkedIn Ads API HTTP 401. Reconnect LinkedIn Ads."), "auth"],
  ["LinkedIn 401 write", new ExpectedToolError("linkedin_ads_token_revoked", "LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu.", { status: 401 }), "auth"],
  ["LinkedIn 401 (text)", new Error("LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu."), "auth"],
  ["LinkedIn 403", new ExpectedToolError("linkedin_ads_forbidden", "LinkedIn Ads API HTTP 403. Check Advertising API approval"), "auth"],
  ["LinkedIn 502", new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads API HTTP 502."), "vendor_error"],
  ["LinkedIn 429", new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads API HTTP 429."), "rate_limited"],
  ["LinkedIn 429 founder copy", new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads is busy right now. Try again in a few minutes.", { http_status: 429 }), "rate_limited"],
  ["LinkedIn 503 founder copy", new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads is not responding right now. Try again in a few minutes.", { http_status: 503 }), "vendor_error"],
  ["fetch TimeoutError", timeoutErr, "timeout"],
  ["a status field", Object.assign(new Error("boom"), { status: 503 }), "vendor_error"],
  ["non-USD account", new Error("Shared ad budgets require USD TikTok Ads accounts."), "unknown"],
  ["a page count is not a status", new Error("TikTok returned more than 500 report pages."), "unknown"],
];

describe("classifyAdReadError", () => {
  it.each(cases)("%s", (_name, err, kind) => {
    expect(classifyAdReadError(err)).toBe(kind);
  });

  it("retries only busy, down or slow platforms", () => {
    expect(isRetryableAdReadKind("rate_limited")).toBe(true);
    expect(isRetryableAdReadKind("vendor_error")).toBe(true);
    expect(isRetryableAdReadKind("timeout")).toBe(true);
    expect(isRetryableAdReadKind("auth")).toBe(false);
    expect(isRetryableAdReadKind("unknown")).toBe(false);
  });
});
