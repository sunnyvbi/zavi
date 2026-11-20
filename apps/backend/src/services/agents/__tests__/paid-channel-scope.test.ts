import { describe, expect, it } from "vitest";
import { isOutsidePaidChannel, isOutsidePaidChannelTool, ownActionClassScopes, paidChannelScopePrompt } from "../paid-channel-scope";
import { getLatestSnapshotTool } from "@/services/tools/paid-acquisition/get_latest_snapshot";

describe("paid channel identity", () => {
  it("allows the owned platform and shared research tools", () => {
    for (const server of ["chatgpt_ads", "growth", "memory", "web_fetch", "report"]) {
      expect(isOutsidePaidChannel("chatgpt_ads", server)).toBe(false);
    }
  });
  it("scopes other paid specialists too, without limiting generalists", () => {
    expect(isOutsidePaidChannel("meta_ads", "chatgpt_ads")).toBe(true);
    expect(isOutsidePaidChannel("meta_ads", "meta_ads")).toBe(false);
    for (const agent of ["operator", "cgo", "performance-marketer", undefined]) {
      expect(isOutsidePaidChannel(agent, "google_ads")).toBe(false);
    }
  });
  it("keeps shared-provider channels working and excludes platforms without a channel tile", () => {
    expect(isOutsidePaidChannel("youtube_ads", "google_ads")).toBe(false);
    expect(isOutsidePaidChannel("youtube_ads", "meta_ads")).toBe(true);
    expect(isOutsidePaidChannel("chatgpt_ads", "microsoft_ads")).toBe(true);
    expect(isOutsidePaidChannel("chatgpt_ads", "apple_ads")).toBe(true);
  });
  it("grants a shared provider only the tools the channel declares", () => {
    expect(isOutsidePaidChannelTool("youtube_ads", "google_ads", "list_video_campaigns")).toBe(false);
    expect(isOutsidePaidChannelTool("youtube_ads", "google_ads", "propose_budget_change")).toBe(false);
    expect(isOutsidePaidChannelTool("youtube_ads", "google_ads", "propose_keywords")).toBe(true);
    expect(isOutsidePaidChannelTool("youtube_ads", "google_ads", "propose_new_campaign")).toBe(true);
    expect(isOutsidePaidChannelTool("google_ads", "google_ads", "propose_keywords")).toBe(false);
  });
  it("scopes Composio-rail ad toolkits by the channel their slug names", () => {
    expect(isOutsidePaidChannelTool("chatgpt_ads", "composio", "REDDIT_ADS_LIST_CAMPAIGNS")).toBe(true);
    expect(isOutsidePaidChannelTool("meta_ads", "composio", "TIKTOK_ADS_GET_REPORT")).toBe(true);
    expect(isOutsidePaidChannelTool("tiktok_ads", "composio", "TIKTOK_ADS_GET_REPORT")).toBe(false);
    expect(isOutsidePaidChannelTool("chatgpt_ads", "composio", "GOOGLESHEETS_GET_VALUES")).toBe(false);
    expect(isOutsidePaidChannelTool("operator", "composio", "REDDIT_ADS_LIST_CAMPAIGNS")).toBe(false);
  });
  it("does not add channel instructions to generalist runs", () => {
    expect(paidChannelScopePrompt("operator")).toBe("");
  });
  it("narrows outcome scopes to the caller's own channel", () => {
    const paid = ["meta_ads.%", "google_ads.%"];
    expect(ownActionClassScopes("operator", paid)).toEqual(paid);
    expect(ownActionClassScopes("chatgpt_ads", paid)).toEqual(["chatgpt_ads.%"]);
    expect(ownActionClassScopes("youtube_ads", paid)).toEqual(["youtube_ads.%", "google_ads.%"]);
  });
  it("refuses another platform's pasted snapshot before reading it", async () => {
    const ctx = { tenant_id: "T1", agent_slug: "chatgpt_ads", log: () => {} };
    await expect(getLatestSnapshotTool.execute(ctx, { provider: "meta_ads" })).rejects.toMatchObject({
      code: "channel_scope_mismatch",
    });
  });
});
