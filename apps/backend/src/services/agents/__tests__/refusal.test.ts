
import { describe, expect, it } from "vitest";

import { refusalFor, refusalText, type RefusalInput } from "../refusal";
import { notePlanWallMap } from "../entitlement";
import { DEFAULT_TIER_AGENT_MIN, DEFAULT_TIER_ALWAYS_PRO } from "@/services/billing/tiers";

const ALL: RefusalInput[] = [
  { kind: "credits" },
  { kind: "out_of_credits" },
  { kind: "credits_for_build" },
  { kind: "credits_for_build", required_credits: 1200, remaining_credits: 40 },
  { kind: "credits_for_build", required_credits: 6500, remaining_credits: 1000, free_plan: true },
  { kind: "build_credits_exhausted" },
  { kind: "budget_exceeded" },
  { kind: "channel_budget_exhausted" },
  { kind: "cap_reached" },
  { kind: "daily_build_limit_reached" },
  { kind: "budget_exhausted" },
  { kind: "provision_budget_exceeded" },
  { kind: "plan_upgrade", slug: "engineer", required_tier: "pro" },
];

const CAPS: RefusalInput[] = [
  { kind: "budget_exceeded" },
  { kind: "channel_budget_exhausted" },
  { kind: "cap_reached" },
  { kind: "daily_build_limit_reached" },
  { kind: "budget_exhausted" },
];

const WALLETS: RefusalInput[] = [
  { kind: "credits" },
  { kind: "out_of_credits" },
  { kind: "credits_for_build" },
  { kind: "build_credits_exhausted" },
];

describe("refusalFor — the codes clients already switch on", () => {
  it("keeps every code byte-identical to what the doors emit today", () => {
    expect(refusalFor({ kind: "credits" }).code).toBe("insufficient_credits");
    expect(refusalFor({ kind: "out_of_credits" }).code).toBe("out_of_credits");
    expect(refusalFor({ kind: "credits_for_build" }).code).toBe(
      "insufficient_credits_for_build",
    );
    expect(refusalFor({ kind: "budget_exhausted" }).code).toBe("budget_exhausted");
    expect(refusalFor({ kind: "budget_exceeded" }).code).toBe("budget_exceeded");
    expect(refusalFor({ kind: "channel_budget_exhausted" }).code).toBe(
      "channel_budget_exhausted",
    );
    expect(refusalFor({ kind: "cap_reached" }).code).toBe("cap_reached");
    expect(refusalFor({ kind: "daily_build_limit_reached" }).code).toBe(
      "daily_build_limit_reached",
    );
    expect(refusalFor({ kind: "build_credits_exhausted" }).code).toBe(
      "build_credits_exhausted",
    );
    expect(refusalFor({ kind: "provision_budget_exceeded" }).code).toBe(
      "provision_budget_exceeded",
    );
    expect(
      refusalFor({ kind: "plan_upgrade", slug: "engineer", required_tier: "pro" }).code,
    ).toBe("plan_upgrade_required");
  });
});

describe("refusalFor — the action is what the person can actually do", () => {
  it("out of credits says the daily credits come back, then offers top up or upgrade", () => {
    for (const kind of ["credits", "out_of_credits"] as const) {
      const m = refusalFor({ kind }).message;
      expect(m, kind).toContain("daily credits come back at midnight UTC");
      expect(m.indexOf("midnight UTC"), kind).toBeLessThan(m.indexOf("top up"));
      expect(m, kind).toContain("upgrade");
    }
  });

  it("a plan wall names the plan and lists what Free can do", () => {
    notePlanWallMap(DEFAULT_TIER_AGENT_MIN, DEFAULT_TIER_ALWAYS_PRO);
    const m = refusalFor({ kind: "plan_upgrade", slug: "meta_ads", required_tier: "pro" }).message;
    expect(m).toContain("Meta Ads needs the Pro plan");
    expect(m).toContain("Free included");
  });

  it("says top up when money is the fix", () => {
    expect(refusalFor({ kind: "credits" }).action).toBe("top_up");
    expect(refusalFor({ kind: "out_of_credits" }).action).toBe("top_up");
    expect(refusalFor({ kind: "credits_for_build" }).action).toBe("top_up");
  });

  it("says upgrade, not top up, when the plan is the wall", () => {
    const r = refusalFor({ kind: "plan_upgrade", slug: "engineer", required_tier: "pro" });
    expect(r.action).toBe("upgrade");
    expect(r.message.toLowerCase()).not.toContain("top up");
  });

  it("says top up for every wallet, where paying is genuinely the fix", () => {
    for (const input of WALLETS) {
      expect(refusalFor(input).action, JSON.stringify(input)).toBe("top_up");
    }
  });

  it("says wait for EVERY cap, and none of them sells a top-up", () => {
    for (const input of CAPS) {
      const r = refusalFor(input);
      const where = JSON.stringify(input);
      expect(r.action, where).toBe("wait");
      expect(r.message.toLowerCase(), where).not.toContain("top up");
      expect(r.message.toLowerCase(), where).not.toContain("billing");
      expect(r.message.toLowerCase(), where).not.toContain("buy");
    }
  });
});

describe("refusalFor — what a customer must never read", () => {
  it("never ships developer copy", () => {
    for (const input of ALL) {
      const { message } = refusalFor(input);
      expect(message).not.toMatch(/rejected:/i);
      expect(message).not.toMatch(/\bagent "/i);
      expect(message).not.toMatch(/\b(null|undefined|NaN)\b/);
    }
  });

  it("is a finished sentence in every case", () => {
    for (const input of ALL) {
      const { message } = refusalFor(input);
      expect(message.length).toBeGreaterThan(20);
      expect(message.trim()).toBe(message);
      expect(message).toMatch(/[.!]$/);
    }
  });
});

describe("refusalFor — the build shortfall", () => {
  it("states the numbers when the caller has them", () => {
    const r = refusalFor({
      kind: "credits_for_build",
      required_credits: 1200,
      remaining_credits: 40,
    });
    expect(r.message).toContain("1,200");
    expect(r.message).toContain("40");
  });

  it("falls back to the plain sentence when either number is missing", () => {
    const partial = refusalFor({ kind: "credits_for_build", required_credits: 1200 });
    expect(partial.message).not.toContain("1,200");
    expect(partial.message).not.toContain("undefined");
    expect(refusalFor({ kind: "credits_for_build" }).message).not.toContain("undefined");
  });
});

describe("refusalText — for a surface that can only post words", () => {
  it("is exactly the sentence, with nothing a chat window cannot render", () => {
    const text = refusalText({ kind: "credits" });
    expect(text).toBe(refusalFor({ kind: "credits" }).message);
    expect(text).not.toContain("<");
    expect(text).not.toContain("{");
  });
});

describe("refusalFor — a free tenant's build refusal", () => {
  it("does not quote a build size the free plan can never reach", () => {
    const r = refusalFor({
      kind: "credits_for_build",
      required_credits: 6500,
      remaining_credits: 1000,
      free_plan: true,
    });
    expect(r.code).toBe("insufficient_credits_for_build");
    expect(r.action).toBe("top_up");
    expect(r.message).toBe(
      "The free plan's daily credits don't cover this build. Top up or pick a plan in Billing to start it.",
    );
    expect(r.message).not.toMatch(/6,?500/);
  });

  it("keeps the shortfall sentence for a paid tenant", () => {
    const r = refusalFor({
      kind: "credits_for_build",
      required_credits: 6500,
      remaining_credits: 1000,
      free_plan: false,
    });
    expect(r.message).toBe(
      "This build needs about 6,500 credits and you have 1,000. Top up in Billing and start it again.",
    );
  });
});

describe("refusalFor — a change (refine) and the free-edit wall", () => {
  it("names the change, not a build, with the shortfall and both ways out", () => {
    const r = refusalFor({ kind: "credits_for_build", required_credits: 2000, remaining_credits: 300, scope: "change" });
    expect(r.code).toBe("insufficient_credits_for_build");
    expect(r.message).toBe(
      "This change needs about 2,000 credits and you have 300. Top up or upgrade in Billing, then send it again.",
    );
    expect(r.message).not.toMatch(/build|partway/i);
  });

  it("free_edits_used names both ways out: upgrade or buy credits", () => {
    const message = "You've used your 2 free edits. Editing your app needs Starter ($20/mo), or buy credits.";
    const r = refusalFor({ kind: "free_edits_used", message });
    expect(r).toEqual({ code: "free_edits_used", message, action: "upgrade" });
    expect(r.message).toMatch(/buy credits/i);
  });
});
