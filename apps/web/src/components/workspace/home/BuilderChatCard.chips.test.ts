import { describe, expect, it } from "vitest";
import { buildChipsPath } from "./BuilderChatCard";

describe("BuilderChatCard suggestion request", () => {
  it("scopes chips to the current root build session", () => {
    expect(buildChipsPath("11111111-1111-4111-8111-111111111111")).toBe(
      "/api/workspace/autopilot/chips?session_id=11111111-1111-4111-8111-111111111111",
    );
  });

  it("waits for a build session instead of calling the rejected legacy route", () => {
    expect(buildChipsPath(null)).toBeNull();
    expect(buildChipsPath("   ")).toBeNull();
  });
});
