
import { describe, it, expect } from "vitest";
import {
  classifyMissing,
  describeMissing,
} from "./SlackReconnectBanner";

describe("classifyMissing — high iff im:* or mpim:* in the missing set", () => {
  it("returns 'info' when only v1→v2 scopes are missing", () => {
    expect(
      classifyMissing([
        "channels:join",
        "pins:read",
        "files:read",
        "usergroups:read",
        "team:read",
      ]),
    ).toBe("info");
  });

  it("returns 'high' when any im:* scope is missing (W2 DM-content)", () => {
    expect(classifyMissing(["im:history"])).toBe("high");
    expect(classifyMissing(["channels:join", "im:read"])).toBe("high");
  });

  it("returns 'high' when any mpim:* scope is missing", () => {
    expect(classifyMissing(["mpim:history"])).toBe("high");
    expect(classifyMissing(["mpim:read", "mpim:write"])).toBe("high");
  });

  it("returns 'info' for an empty set (banner won't render anyway)", () => {
    expect(classifyMissing([])).toBe("info");
  });
});

describe("describeMissing — copy stable + preserves backend order", () => {
  it("returns '' for an empty set", () => {
    expect(describeMissing([])).toBe("");
  });

  it("uses singular form for exactly one missing scope", () => {
    expect(describeMissing(["channels:join"])).toBe(
      "Missing scope: channels:join.",
    );
  });

  it("uses plural form with count + comma-joined list", () => {
    expect(
      describeMissing(["channels:join", "pins:read", "team:read"]),
    ).toBe("Missing 3 scopes: channels:join, pins:read, team:read.");
  });

  it("preserves the input order (i.e. backend BOT_SCOPES order)", () => {
    const input = ["team:read", "channels:join"];
    expect(describeMissing(input)).toBe(
      "Missing 2 scopes: team:read, channels:join.",
    );
  });
});

