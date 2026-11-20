
import { describe, it, expect } from "vitest";
import {
  scrubZaviArchitectureLeak,
  redactZaviArchitectureLeak,
  ARCHITECTURE_LEAK_FALLBACK,
} from "@/services/agents/brand-rewrite";

describe("INVARIANT — no Zavi self-architecture leak to a customer", () => {
  it("blocks the EXACT incident reply and substitutes the safe fallback", () => {
    const leaked =
      "Welcome to the team! I'm Zavi, an AI cofounder agent. Zavi is an AI " +
      "cofounder team that connects to your operating systems (Slack, GitHub, " +
      "Jira, Stripe, Google Ads, and more) and runs a fleet of 11 core " +
      "specialist agents — engineers, support leads, growth marketers, and more.";
    const out = scrubZaviArchitectureLeak(leaked);
    expect(out.blocked).toBe(true);
    expect(out.text).toBe(ARCHITECTURE_LEAK_FALLBACK);
    expect(out.text).not.toMatch(/fleet of 11/i);
    expect(out.text).not.toMatch(/cofounder/i);
  });

  it("blocks a reply that leaked internals via the raw agent-roster descriptions", () => {
    const rosterLeak =
      "Sure — I can hand that to the engineer agent via praxis__handoff, or " +
      "escalate through the staff visibility API.";
    const out = scrubZaviArchitectureLeak(rosterLeak);
    expect(out.blocked).toBe(true);
    expect(out.text).toBe(ARCHITECTURE_LEAK_FALLBACK);
  });

  it("blocks the connector-enumeration pitch (4+ connectors after a connect verb)", () => {
    const enumLeak =
      "Zavi connects to your operating systems (Slack, GitHub, Jira, Stripe, " +
      "and Google Ads) and works across them.";
    expect(scrubZaviArchitectureLeak(enumLeak).blocked).toBe(true);
  });

  it("does NOT block a legit help answer that lists a few connectors (<4)", () => {
    const legit = "You can integrate Slack, GitHub, and Jira from Settings.";
    const out = scrubZaviArchitectureLeak(legit);
    expect(out.blocked).toBe(false);
    expect(out.text).toBe(legit);
  });

  it.each([
    ["fleet-of-N agents", "We run a fleet of 8 agents for you."],
    ["N core agents", "There are 11 core agents available."],
    ["disabled agents", "Plus 22 additional agents on disk, disabled."],
    ["visibility API", "Toggle it via the staff visibility API."],
    ["row-flip", "Re-enable an agent with a single row-flip."],
    ["company brain", "That's stored in the company brain."],
    ["internal tool name", "Routed through praxis__remind."],
  ])("blocks architecture tell: %s", (_label, text) => {
    expect(scrubZaviArchitectureLeak(text).blocked).toBe(true);
  });

  it.each([
    [
      "single connector answer",
      "Your Stripe payouts last week totaled $4,210 across 18 charges. Pulled from your connected Stripe account.",
    ],
    [
      "two connectors, no pitch verb",
      "I checked your Slack and Stripe — the refund posted this morning.",
    ],
    [
      "marketplace fleet-of-N (cars, not agents)",
      "Your fleet of 8 cars had 31 bookings last month. Want the per-car breakdown?",
    ],
  ])("does NOT eat a legitimate reply: %s", (_label, legit) => {
    const out = scrubZaviArchitectureLeak(legit);
    expect(out.blocked).toBe(false);
    expect(out.text).toBe(legit);
  });

  it("redaction keeps a long specialist reply but removes the internal tell", () => {
    const reply =
      "I opened PR #482 to fix the payout bug and reran the suite. " +
      "It routed through the staff visibility API on our side. Ship when green.";
    const out = redactZaviArchitectureLeak(reply);
    expect(out.hits).toBeGreaterThan(0);
    expect(out.text).toContain("PR #482");
    expect(out.text).toContain("Ship when green");
    expect(out.text).not.toMatch(/staff visibility/i);
  });

  it("passes an ordinary teammate reply through untouched", () => {
    const ok = "Thanks for the intro! Glad to be here. Send anything my way.";
    const out = scrubZaviArchitectureLeak(ok);
    expect(out.blocked).toBe(false);
    expect(out.text).toBe(ok);
  });
});
