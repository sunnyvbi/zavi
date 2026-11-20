import { describe, it, expect } from "vitest";
import { isRemoteToolAllowed, looksLikeWriteToolName } from "../write-allowlist";

describe("pipedream read-only robustness (plan P1 #11)", () => {
  it("advertises a genuinely read-only pipedream tool", () => {
    expect(isRemoteToolAllowed("pipedream_notion", "search_pages", true)).toBe(true);
    expect(isRemoteToolAllowed("pipedream_slack", "list_channels", true)).toBe(true);
  });

  it("DROPS a write-shaped tool even if the vendor self-reports readOnlyHint=true", () => {
    expect(isRemoteToolAllowed("pipedream_notion", "create_page", true)).toBe(false);
    expect(isRemoteToolAllowed("pipedream_slack", "send_message", true)).toBe(false);
    expect(isRemoteToolAllowed("pipedream_stripe", "refund_charge", true)).toBe(false);
  });

  it("default-denies pipedream tools with no read-only hint", () => {
    expect(isRemoteToolAllowed("pipedream_notion", "search_pages", undefined)).toBe(false);
    expect(isRemoteToolAllowed("pipedream_notion", "search_pages", false)).toBe(false);
  });

  it("APPLIES the write-verb distrust to composio too (it is a dynamic vendor)", () => {
    expect(isRemoteToolAllowed("composio", "create_issue", true)).toBe(false);
    expect(isRemoteToolAllowed("composio", "LINEAR_RUN_QUERY_OR_MUTATION", true)).toBe(false);
    expect(isRemoteToolAllowed("composio", "HUBSPOT_GET_DEAL", true)).toBe(true);
  });

  it("looksLikeWriteToolName flags common mutation verbs only", () => {
    expect(looksLikeWriteToolName("create_doc")).toBe(true);
    expect(looksLikeWriteToolName("delete_row")).toBe(true);
    expect(looksLikeWriteToolName("send_email")).toBe(true);
    expect(looksLikeWriteToolName("get_doc")).toBe(false);
    expect(looksLikeWriteToolName("list_rows")).toBe(false);
    expect(looksLikeWriteToolName("search")).toBe(false);
  });
});
