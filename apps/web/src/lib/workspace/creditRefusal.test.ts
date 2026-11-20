import { describe, expect, it } from "vitest";
import { creditRefusalFrom } from "./creditRefusal";

describe("creditRefusalFrom", () => {
  it("states the shortfall from the typed fields on a build refusal", () => {
    const r = creditRefusalFrom(
      {
        error: {
          code: "insufficient_credits_for_build",
          required_credits: 6500,
          remaining_credits: 492,
        },
      },
      "build",
    );
    expect(r).toEqual({
      headline: "Not enough credits for this build.",
      detail: " Top up to start it.",
      subline: "Needs about 6,500 credits · you have 492",
    });
  });

  it("tells a free tenant the plan does not cover the build, without the build size", () => {
    const r = creditRefusalFrom(
      {
        error: {
          code: "insufficient_credits_for_build",
          required_credits: 6500,
          remaining_credits: 1000,
          free_plan: true,
        },
      },
      "build",
    );
    expect(r).toEqual({
      headline: "Not enough credits for this build.",
      detail: " The free plan's daily credits don't cover it.",
      subline: "Top up or pick a plan to start it.",
    });
  });

  it("keeps the shortfall for a free tenant outside the build screen", () => {
    const r = creditRefusalFrom(
      { error: { code: "insufficient_credits_for_build", required_credits: 6500, remaining_credits: 1000, free_plan: true } },
      "change",
    );
    expect(r?.headline).toBe("Not enough credits for this change.");
  });

  it("shows no numbers when the server sent none, never a half-filled sentence", () => {
    const r = creditRefusalFrom({ error: { code: "insufficient_credits" } }, "channel");
    expect(r?.subline).toBeNull();
    expect(r?.headline).toBe("Out of credits.");
  });

  it("covers every wallet code", () => {
    for (const code of [
      "insufficient_credits",
      "insufficient_credits_for_build",
      "out_of_credits",
      "build_credits_exhausted",
    ]) {
      expect(creditRefusalFrom({ error: { code } }, "scan")).not.toBeNull();
    }
  });

  it("does not sell a top-up for a cap that frees itself", () => {
    for (const code of [
      "provision_budget_exceeded",
      "daily_build_limit_reached",
      "budget_exceeded",
      "channel_budget_exhausted",
      "plan_upgrade_required",
    ]) {
      expect(creditRefusalFrom({ error: { code } }, "build")).toBeNull();
    }
    expect(creditRefusalFrom(null, "build")).toBeNull();
  });
});

describe("creditRefusalFrom: the free-edit wall", () => {
  it("uses the server's sentence (the card then offers Upgrade Plan and Buy Credits)", () => {
    const message = "You've used your 2 free edits. Editing your app needs Starter ($20/mo), or buy credits.";
    expect(creditRefusalFrom({ error: { code: "free_edits_used", message } }, "change")).toEqual({
      headline: message,
      detail: "",
      subline: null,
    });
  });

  it("falls back to the fixed sentence when the server sent none", () => {
    const r = creditRefusalFrom({ error: { code: "free_edits_used" } }, "change");
    expect(r?.headline).toBe("You've used your 2 free edits. Editing your app needs Starter ($20/mo), or buy credits.");
    expect(r?.subline).toBeNull();
  });

  it("a Free wallet refusal on a change names upgrade, not only a top-up", () => {
    const r = creditRefusalFrom({ error: { code: "insufficient_credits_for_build", free_plan: true } }, "change");
    expect(r?.subline).toBe("Upgrade or top up to make it.");
  });
});

describe("creditRefusalFrom on a video refused because other videos are still being made", () => {
  const body = (extra: Record<string, unknown>) => ({
    error: { code: "insufficient_credits", message: "server words", required_credits: 450, ...extra },
  });

  it("says the videos already being made use up the credits, with both numbers", () => {
    const r = creditRefusalFrom(body({ reason: "videos_ahead", ahead_credits: 900 }), "video");
    expect(r).toEqual({
      headline: "Not enough credits for this video while your other videos are still being made.",
      detail: " Top up to make it.",
      subline: "This one needs about 450 credits · videos being made need about 900",
    });
  });

  it("still names the videos being made when the numbers are missing", () => {
    const r = creditRefusalFrom({ error: { code: "insufficient_credits", reason: "videos_ahead" } }, "video");
    expect(r?.headline).toMatch(/other videos are still being made/);
    expect(r?.subline).toBe("The videos already being made use up the credits you have.");
  });

  it("keeps the plain video line when the server gives no videos-ahead reason", () => {
    const r = creditRefusalFrom(body({}), "video");
    expect(r).toEqual({ headline: "Not enough credits for this video.", detail: " Top up to make it.", subline: null });
  });

  it("does not use the videos-ahead words on another screen", () => {
    const r = creditRefusalFrom(body({ reason: "videos_ahead", ahead_credits: 900 }), "photo");
    expect(r?.headline).toBe("Not enough credits for this photo.");
  });
});
