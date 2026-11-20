import { describe, it, expect, vi } from "vitest";

vi.mock("../write-allowlist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../write-allowlist")>();
  return {
    ...actual,
    isAllowedWriteTool: (server_id: string, tool_name: string) =>
      actual.isAllowedWriteTool(server_id, tool_name) ||
      (server_id === "higgsfield" && tool_name === "generate_music"),
  };
});

import { isMeteredWriteTool } from "../higgsfield-meter";

describe("#12 higgsfield isMeteredWriteTool — fail-closed-metered default", () => {
  it("(d) keeps the known metered writes metered", () => {
    expect(isMeteredWriteTool("higgsfield", "generate_video")).toBe(true);
    expect(isMeteredWriteTool("higgsfield", "generate_image")).toBe(true);
  });

  it("keeps generate_audio EXEMPT (TTS sub-step, not a per-day generation)", () => {
    expect(isMeteredWriteTool("higgsfield", "generate_audio")).toBe(false);
  });

  it("(b) meters a NEW allowlisted billable write by default (fail-closed)", () => {
    expect(isMeteredWriteTool("higgsfield", "generate_music")).toBe(true);
  });

  it("does NOT meter a proven read (not an allowlisted write)", () => {
    expect(isMeteredWriteTool("higgsfield", "balance")).toBe(false);
  });

  it("does NOT route a non-metered-server tool through the higgsfield cap", () => {
    expect(isMeteredWriteTool("composio", "LINEAR_CREATE_ISSUE")).toBe(false);
    expect(isMeteredWriteTool("pipedream_stripe", "create_charge")).toBe(false);
  });
});
