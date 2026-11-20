
import { describe, it, expect } from "vitest";
import { redactContradictedClaims } from "@/services/agents/run-capabilities";

const LIVE = ["stripe", "github"];

describe("distill write-gate — excise DISPROVEN connector claims, keep the note", () => {
  it("cuts the claim that produced the incident", () => {
    const r = redactContradictedClaims(
      "The tenant's Stripe account is not connected to Praxis. Refunds are therefore manual.",
      LIVE,
    );
    expect(r.withheld).toEqual(["stripe"]);
    expect(r.text).not.toMatch(/Stripe account is not connected/i);
    expect(r.text).toContain("Refunds are therefore manual.");
  });

  it("cuts the GitHub claim that may be stalling engineer on 3 other tenants", () => {
    const r = redactContradictedClaims("GitHub connector not wired; 4 engineer dispatches blocked.", LIVE);
    expect(r.withheld).toEqual(["github"]);
  });

  it("PRESERVES a real business fact that only mentions the stale claim in passing", () => {
    const note =
      "Blended take-rate is 14.1% for the week ending 2026-05-16. " +
      "This is below the ~25% P2P benchmark, a deliberate strategic choice. " +
      "The figure is unverified because Stripe is not connected.";
    const r = redactContradictedClaims(note, LIVE);
    expect(r.text).toContain("14.1%");
    expect(r.text).toContain("below the ~25% P2P benchmark");
    expect(r.text).not.toMatch(/Stripe is not connected/i);
  });

  it("leaves a note about the tenant's OWN payouts product untouched (33 of ~60 prod candidates)", () => {
    const note = "Stripe Connect not wired — hosts cannot receive payouts.";
    expect(redactContradictedClaims(note, LIVE).text).toBe(note);
  });

  it("leaves a note about a connector the tenant genuinely LACKS untouched", () => {
    const note = "Linear is not connected, so tickets can't be filed.";
    expect(redactContradictedClaims(note, LIVE).text).toBe(note);
  });

  it("no-ops when the tenant's live-connector set is unknown (fail-open to today's behaviour)", () => {
    const note = "Stripe is not connected.";
    expect(redactContradictedClaims(note, []).text).toBe(note);
  });
});
