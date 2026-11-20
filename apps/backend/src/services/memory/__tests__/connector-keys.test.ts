import { describe, it, expect } from "vitest";
import {
  connectorKey,
  normalizeConnectorKeys,
  toPrefilterArg,
  connectorKeysFromRouting,
} from "../connector-keys";

describe("connectorKey", () => {
  it("builds <kind>:<id> for a non-empty id", () => {
    expect(connectorKey("slack_channel", "C123")).toBe("slack_channel:C123");
    expect(connectorKey("stripe_customer", "cus_X")).toBe("stripe_customer:cus_X");
    expect(connectorKey("github_repo", "owner/name")).toBe("github_repo:owner/name");
  });
  it("returns null for blank/null/undefined ids", () => {
    expect(connectorKey("slack_channel", "")).toBeNull();
    expect(connectorKey("slack_channel", "   ")).toBeNull();
    expect(connectorKey("slack_channel", null)).toBeNull();
    expect(connectorKey("slack_channel", undefined)).toBeNull();
  });
  it("trims surrounding whitespace on the id", () => {
    expect(connectorKey("slack_channel", "  C123  ")).toBe("slack_channel:C123");
  });
});

describe("normalizeConnectorKeys", () => {
  it("drops null/blank, dedups, preserves order", () => {
    expect(
      normalizeConnectorKeys(["a:1", null, "a:1", "  ", "b:2", undefined]),
    ).toEqual(["a:1", "b:2"]);
  });
  it("returns [] for an all-empty list", () => {
    expect(normalizeConnectorKeys([])).toEqual([]);
    expect(normalizeConnectorKeys([null, undefined, "  "])).toEqual([]);
  });
  it("caps the array at 16 keys", () => {
    const many = Array.from({ length: 30 }, (_, i) => `k:${i}`);
    expect(normalizeConnectorKeys(many).length).toBe(16);
  });
});

describe("toPrefilterArg", () => {
  it("converts [] / null / undefined to null (no prefilter)", () => {
    expect(toPrefilterArg([])).toBeNull();
    expect(toPrefilterArg(null)).toBeNull();
    expect(toPrefilterArg(undefined)).toBeNull();
  });
  it("passes a non-empty array through unchanged", () => {
    expect(toPrefilterArg(["a:1"])).toEqual(["a:1"]);
  });
});

describe("connectorKeysFromRouting", () => {
  it("builds keys from slack + email routing", () => {
    expect(
      connectorKeysFromRouting({ slackChannelId: "C1", emailThreadId: "T1" }),
    ).toEqual(["slack_channel:C1", "email_thread:T1"]);
  });
  it("returns [] when no routing is present (chat/manual/scheduled run)", () => {
    expect(connectorKeysFromRouting({})).toEqual([]);
    expect(
      connectorKeysFromRouting({ slackChannelId: null, emailThreadId: null }),
    ).toEqual([]);
  });
  it("includes only the present routing object", () => {
    expect(connectorKeysFromRouting({ slackChannelId: "C1" })).toEqual([
      "slack_channel:C1",
    ]);
  });
});
