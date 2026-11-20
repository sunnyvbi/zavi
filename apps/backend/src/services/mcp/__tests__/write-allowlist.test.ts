import { describe, it, expect } from "vitest";
import {
  isAllowedWriteTool,
  isReadFallbackTool,
  isRemoteToolAllowed,
  isRemoteCallExecAllowed,
  hasWriteAllowlist,
} from "../write-allowlist";

describe("write-allowlist — server-scoped, fail-closed", () => {
  it("advertise gate: read-only tools always pass (any server)", () => {
    expect(isRemoteToolAllowed("composio", "GITHUB_GET_ISSUE", true)).toBe(true);
    expect(isRemoteToolAllowed("higgsfield", "balance", true)).toBe(true);
  });

  it("advertise gate: a Composio WRITE stays filtered (no allowlist entry)", () => {
    expect(isRemoteToolAllowed("composio", "GITHUB_CREATE_ISSUE", false)).toBe(false);
    expect(isRemoteToolAllowed("composio", "GITHUB_CREATE_ISSUE", undefined)).toBe(false);
  });

  it("advertise gate: a Higgsfield allowlisted write passes even without a read hint", () => {
    expect(isRemoteToolAllowed("higgsfield", "generate_video", false)).toBe(true);
    expect(isRemoteToolAllowed("higgsfield", "generate_image", undefined)).toBe(true);
  });

  it("advertise gate: a Higgsfield read-fallback passes when the hint is absent", () => {
    expect(isRemoteToolAllowed("higgsfield", "list_workspaces", undefined)).toBe(true);
    expect(isRemoteToolAllowed("higgsfield", "job_display", undefined)).toBe(true);
  });

  it("advertise gate: an un-listed Higgsfield tool is denied (default-deny)", () => {
    expect(isRemoteToolAllowed("higgsfield", "delete_everything", false)).toBe(false);
    expect(isRemoteToolAllowed("higgsfield", "delete_everything", undefined)).toBe(false);
  });

  it("advertise gate: an unknown server is read-only-by-hint only", () => {
    expect(isRemoteToolAllowed("evilserver", "generate_video", false)).toBe(false);
    expect(isRemoteToolAllowed("evilserver", "anything", true)).toBe(true);
  });

  it("primitives: isAllowedWriteTool / isReadFallbackTool are server-scoped", () => {
    expect(isAllowedWriteTool("higgsfield", "generate_video")).toBe(true);
    expect(isAllowedWriteTool("composio", "generate_video")).toBe(false);
    expect(isReadFallbackTool("higgsfield", "balance")).toBe(true);
    expect(isReadFallbackTool("composio", "balance")).toBe(false);
  });

  it("hasWriteAllowlist marks only servers with an entry", () => {
    expect(hasWriteAllowlist("higgsfield")).toBe(true);
    expect(hasWriteAllowlist("composio")).toBe(false);
  });
});

describe("execution gate — independent of discovery", () => {
  it("Higgsfield: only allowlisted writes + read fallbacks may execute", () => {
    expect(isRemoteCallExecAllowed("higgsfield", "generate_video")).toBe(true);
    expect(isRemoteCallExecAllowed("higgsfield", "balance")).toBe(true);
    expect(isRemoteCallExecAllowed("higgsfield", "delete_everything")).toBe(false);
    expect(isRemoteCallExecAllowed("higgsfield", "some_unadvertised_write")).toBe(false);
  });

  it("Composio (no write-allowlist): exec re-check is a no-op (prior behavior)", () => {
    expect(isRemoteCallExecAllowed("composio", "GITHUB_GET_ISSUE")).toBe(true);
    expect(isRemoteCallExecAllowed("composio", "GITHUB_CREATE_ISSUE")).toBe(true);
  });
});

describe("composio — dynamic-vendor write distrust (measured, not hypothetical)", () => {
  it("drops LINEAR_RUN_QUERY_OR_MUTATION even though Composio calls it read-only", () => {
    expect(isRemoteToolAllowed("composio", "LINEAR_RUN_QUERY_OR_MUTATION", true)).toBe(false);
  });

  it("still trusts a genuinely read-shaped Composio tool", () => {
    expect(isRemoteToolAllowed("composio", "HUBSPOT_GET_DEAL", true)).toBe(true);
    expect(isRemoteToolAllowed("composio", "HUBSPOT_GET_CAMPAIGN_METRICS", true)).toBe(true);
  });

  it("drops a write-shaped Composio tool that lies about being read-only", () => {
    for (const name of [
      "GMAIL_SEND_EMAIL",
      "NOTION_DELETE_PAGE",
      "SALESFORCE_UPDATE_RECORD",
      "LINEAR_CREATE_ISSUE",
    ]) {
      expect(isRemoteToolAllowed("composio", name, true), name).toBe(false);
    }
  });

  it("keeps Composio writes denied when the hint is honest (unchanged)", () => {
    expect(isRemoteToolAllowed("composio", "GMAIL_SEND_EMAIL", false)).toBe(false);
    expect(isRemoteToolAllowed("composio", "GMAIL_SEND_EMAIL", undefined)).toBe(false);
  });

  it("applies the same distrust to pipedream (no regression)", () => {
    expect(isRemoteToolAllowed("pipedream_stripe", "create_refund", true)).toBe(false);
    expect(isRemoteToolAllowed("pipedream_posthog", "get_insight", true)).toBe(true);
  });

  it("does NOT distrust names on a static, hand-audited server", () => {
    expect(isRemoteToolAllowed("higgsfield", "generate_video", undefined)).toBe(true);
  });
});
