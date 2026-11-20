import { describe, it, expect } from "vitest";
import { isRetryableMetaReadError } from "../_retryable";
import { ExpectedToolError } from "@/services/tools/types";

const q = (meta: Record<string, unknown>) => new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed", meta);

describe("isRetryableMetaReadError", () => {
  it.each([
    ["a Meta timeout", new ExpectedToolError("meta_ads_timeout", "15s")],
    ["a 500", q({ http_status: 500 })],
    ["a 503 gateway page", q({ http_status: 503 })],
    ["a 429", q({ http_status: 429 })],
    ["a 408 request timeout", q({ http_status: 408 })],
    ["Meta's is_transient flag on a 400", q({ http_status: 400, is_transient: true })],
    ["throttling code 4", q({ http_status: 400, graph_code: 4 })],
    ["throttling code 17", q({ http_status: 400, graph_code: 17 })],
    ["throttling code 613", q({ http_status: 400, graph_code: 613 })],
    ["a business-use-case limit (80004)", q({ http_status: 400, graph_code: 80004 })],
    ["a connection reset under fetch failed", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })],
    ["a DNS miss", Object.assign(new Error("getaddrinfo"), { code: "EAI_AGAIN" })],
    ["a raw TimeoutError", Object.assign(new Error("t"), { name: "TimeoutError" })],
  ])("%s is retryable", (_l, e) => expect(isRetryableMetaReadError(e)).toBe(true));

  it.each([
    ["a validation 400 (code 100)", q({ http_status: 400, graph_code: 100 })],
    ["a 400 with no code", q({ http_status: 400 })],
    ["a generic error with no facts", new ExpectedToolError("meta_ads_query_failed", "x")],
    ["an expired token", new ExpectedToolError("meta_ads_token_expired", "x")],
    ["a revoked permission", new ExpectedToolError("meta_ads_permission_revoked", "x")],
    ["a campaign not in the account", new ExpectedToolError("meta_ads_invalid_target", "x")],
    ["a bid conflict", new ExpectedToolError("meta_ads_bid_conflict", "x")],
    ["an incomplete page walk", new ExpectedToolError("meta_ads_pagination_incomplete", "x")],
    ["a plain bug", new TypeError("cannot read properties of undefined")],
    ["a non-error", "boom"],
  ])("%s is final", (_l, e) => expect(isRetryableMetaReadError(e)).toBe(false));
});
