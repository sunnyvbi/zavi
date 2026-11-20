import { describe, it, expect, vi } from "vitest";
import { cardWhyWithoutWorkClaim } from "../goal-owner";

const ctx = { tenant_id: "t1", run_id: "cgo-run", channel_slug: "instagram_organic" };

describe("cardWhyWithoutWorkClaim", () => {
  it("removes the live-status sentence and the one leaning on it, nothing else", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const [why, after] of [
      ["The Instagram specialist is now trying to read both handles from the post links. If it finds them first, you can skip this.", ""],
      ["The TikTok agent is looking into the captions now.", ""],
      ["Our engineer is on it.", ""],
      ["Spend is capped at $40. The Instagram specialist is trying to read @acme and @acme.hq.", "Spend is capped at $40."],
      ["The engineer is working on it because the API key is missing.", "The API key is missing."],
      ["Spend is capped at $40 because the Instagram specialist is still working on the creative.", "Spend is capped at $40."],
    ]) {
      expect(cardWhyWithoutWorkClaim(why, ctx)).toBe(after);
    }
    expect(info).toHaveBeenCalledWith(expect.stringContaining("event=card_work_claim_dropped"));
    info.mockRestore();
  });

  it("keeps a why with no work claim, and an empty one", () => {
    for (const why of [
      "Only you can confirm the handles, so this one is yours.",
      "The Instagram specialist tried yesterday and could not open the posts.",
      "If the Instagram specialist is checking them, wait for it.",
      "",
    ]) {
      expect(cardWhyWithoutWorkClaim(why, ctx)).toBe(why);
    }
  });
});
