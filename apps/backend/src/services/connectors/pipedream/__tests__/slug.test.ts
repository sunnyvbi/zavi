import { describe, it, expect } from "vitest";
import {
  sanitizeAppSlug,
  serverIdForApp,
  isPipedreamServerId,
  isValidPipedreamServerId,
  connectorMetadataSlug,
  anthropicNameFits,
  MAX_PIPEDREAM_APP_SLUG_LEN,
} from "../slug";

describe("sanitizeAppSlug", () => {
  it("accepts lowercase slugs incl. underscores", () => {
    expect(sanitizeAppSlug("slack")).toBe("slack");
    expect(sanitizeAppSlug("google_sheets")).toBe("google_sheets");
    expect(sanitizeAppSlug("  Notion ")).toBe("notion");
  });
  it("rejects name-breaking chars (colon, dot, slash, space)", () => {
    expect(sanitizeAppSlug("evil:app")).toBeNull();
    expect(sanitizeAppSlug("a.b")).toBeNull();
    expect(sanitizeAppSlug("a/b")).toBeNull();
    expect(sanitizeAppSlug("a b")).toBeNull();
  });
  it("rejects empty + over-length", () => {
    expect(sanitizeAppSlug("")).toBeNull();
    expect(sanitizeAppSlug("x".repeat(MAX_PIPEDREAM_APP_SLUG_LEN + 1))).toBeNull();
  });
});

describe("server_id mapping (underscore) + the two-key split", () => {
  it("builds underscore server_id + dot metadata slug", () => {
    expect(serverIdForApp("google_sheets")).toBe("pipedream_google_sheets");
    expect(connectorMetadataSlug("google_sheets")).toBe("pipedream.google_sheets");
  });
  it("recognizes + validates the pipedream family", () => {
    expect(isPipedreamServerId("pipedream_slack")).toBe(true);
    expect(isPipedreamServerId("composio")).toBe(false);
    expect(isValidPipedreamServerId("pipedream_google_sheets")).toBe(true);
    expect(isValidPipedreamServerId("pipedream_BAD")).toBe(false);
    expect(isValidPipedreamServerId("pipedream_")).toBe(false);
  });
});

describe("anthropicNameFits — per-server 64-char budget", () => {
  it("passes a normal pipedream tool name", () => {
    expect(anthropicNameFits("pipedream_notion", "search_pages")).toBe(true);
  });
  it("rejects when server_id + __ + encoded exceeds 64", () => {
    const longTool = "x".repeat(60);
    expect(anthropicNameFits("pipedream_google_sheets", longTool)).toBe(false);
    expect(anthropicNameFits("pipedream_notion", "y".repeat(46))).toBe(true);
    expect(anthropicNameFits("pipedream_notion", "y".repeat(47))).toBe(false);
  });
});
