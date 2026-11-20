import { describe, expect, it } from "vitest";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import { channelSummaryMetrics } from "./channelSummaryMetrics";

const metric = (key: string, value: number): ChannelMetric => ({ key, value, unit: null, window_kind: null, day: "2026-10-21", grounded: true, prev_value: null, prev_day: null });

describe("dashboard metric source", () => {
  const stored = [metric("old_campaign_spend", 0)];
  const live = [metric("spend", 50)];
  it("uses current TikTok report totals even when older agent metrics exist", () => {
    expect(channelSummaryMetrics(stored, live, false, true)).toEqual(live);
  });
  it("does not substitute old agent metrics when the TikTok report is unavailable", () => {
    expect(channelSummaryMetrics(stored, [], false, true)).toEqual([]);
  });
  it("keeps the existing source preference for other channels", () => {
    expect(channelSummaryMetrics(stored, live, false)).toEqual(stored);
  });
  it("hides the old report while the selected date window changes", () => {
    expect(channelSummaryMetrics(stored, live, true, true)).toEqual([]);
  });
});
