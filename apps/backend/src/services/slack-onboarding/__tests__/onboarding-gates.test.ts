
import { describe, it, expect } from "vitest";
import { evaluateIdentity } from "../identity";
import { buildPitches, type PitchCandidate } from "../pitches";

describe("evaluateIdentity — abstains on the trap cases", () => {
  it("abstains for a free mailbox even with a confident resolved domain", () => {
    const v = evaluateIdentity({
      installerEmail: "jdoe@gmail.com",
      resolved: { domain: "apple.com", confidence: 0.99, via: "tavily" },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("free_mailbox");
  });

  it('abstains on the "Apple Rentals"->apple.com FP when the installer email does not match', () => {
    const v = evaluateIdentity({
      installerEmail: "owner@applerentals.example",
      resolved: { domain: "apple.com", confidence: 0.9, via: "tavily" },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("email_domain_mismatch");
  });

  it("abstains when no email is resolvable", () => {
    const v = evaluateIdentity({
      installerEmail: null,
      resolved: { domain: "acme.com", confidence: 1, via: "override" },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("no_email");
  });

  it("abstains below the confidence floor", () => {
    const v = evaluateIdentity({
      installerEmail: "ceo@acme.com",
      resolved: { domain: "acme.com", confidence: 0.7, via: "tavily" },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("low_confidence");
  });

  it("passes for a real corporate email matching a confident domain (incl. subdomain)", () => {
    expect(
      evaluateIdentity({
        installerEmail: "ceo@acme.com",
        resolved: { domain: "acme.com", confidence: 0.95, via: "tavily" },
      }).ok,
    ).toBe(true);
    expect(
      evaluateIdentity({
        installerEmail: "ceo@mail.acme.com",
        resolved: { domain: "acme.com", confidence: 0.95, via: "tavily" },
      }).ok,
    ).toBe(true);
  });
});

describe("buildPitches — connector honesty", () => {
  const candidates: PitchCandidate[] = [
    {
      agent_slug: "research",
      title: "Market intel",
      opportunity: "o",
      what_id_do: "d",
      what_youd_get: "g",
      source: { kind: "public_web" },
    },
    {
      agent_slug: "performance-marketer",
      title: "Paid acq",
      opportunity: "o",
      what_id_do: "d",
      what_youd_get: "g",
      source: { kind: "connector", connector_slug: "google_ads" },
    },
    {
      agent_slug: "operator",
      title: "Analyst",
      opportunity: "o",
      what_id_do: "d",
      what_youd_get: "g",
      source: { kind: "connector", connector_slug: "operator_db" },
    },
  ];
  const visible = new Set(["research", "performance-marketer", "operator", "growth-lead"]);

  it('never says "start now" for a pitch whose connector is NOT connected', () => {
    const pitches = buildPitches({
      candidates,
      connectedSlugs: new Set(["slack"]),
      visibleSlugs: visible,
    });
    const ads = pitches.find((p) => p.agent_slug === "performance-marketer");
    expect(ads?.cta).toBe("connect");
    expect(ads?.needs_connector).toBe("google_ads");
    expect(pitches.find((p) => p.agent_slug === "research")?.cta).toBe("start_now");
    expect(pitches.every((p) => p.source_label.length > 0)).toBe(true);
  });

  it('says "start now" ONLY once the named connector is connected', () => {
    const pitches = buildPitches({
      candidates,
      connectedSlugs: new Set(["slack", "google_ads", "operator_db"]),
      visibleSlugs: visible,
    });
    expect(pitches.find((p) => p.agent_slug === "performance-marketer")?.cta).toBe(
      "start_now",
    );
    expect(pitches.find((p) => p.agent_slug === "operator")?.cta).toBe("start_now");
  });

  it("drops agents the tenant cannot see (no hidden/disabled agent is ever pitched)", () => {
    const pitches = buildPitches({
      candidates,
      connectedSlugs: new Set(["slack"]),
      visibleSlugs: new Set(["research"]),
    });
    expect(pitches.map((p) => p.agent_slug)).toEqual(["research"]);
  });
});
