
import { describe, it, expect } from "vitest";
import {
  assertsUnverifiedShipClaim,
  attributeShipClaim,
  SHIP_CLAIM_ATTRIBUTION,
  UNVERIFIED_SHIP_CLAIM_TAG,
} from "../distill";

const art = (over: Partial<Parameters<typeof attributeShipClaim>[0]> = {}) =>
  ({
    note_type: "tenant_project",
    title: "Split payment feature with co-traveler",
    body_markdown:
      "Guests can now split payment with a co-traveler before booking. The " +
      "co-traveler receives an email link to pay their share. Feature is " +
      "shipped and ready for QA test case validation.",
    tags: ["payments"],
    ...over,
  }) as Parameters<typeof attributeShipClaim>[0];

describe("the exact note that caused the incident", () => {
  it("is detected as an unattributed ship claim", () => {
    expect(assertsUnverifiedShipClaim(art())).toBe(true);
  });

  it("gets the provenance line prepended, original text preserved below", () => {
    const out = attributeShipClaim(art());
    expect(out.body_markdown.startsWith(SHIP_CLAIM_ATTRIBUTION)).toBe(true);
    expect(out.body_markdown).toContain("Guests can now split payment");
    expect(out.body_markdown).toContain("Feature is shipped");
  });

  it("gets the audit tag, keeping the original tags", () => {
    const out = attributeShipClaim(art());
    expect(out.tags).toContain(UNVERIFIED_SHIP_CLAIM_TAG);
    expect(out.tags).toContain("payments");
  });

  it("does not change note_type or title", () => {
    const out = attributeShipClaim(art());
    expect(out.note_type).toBe("tenant_project");
    expect(out.title).toBe("Split payment feature with co-traveler");
  });
});

describe("ship-claim phrasings", () => {
  const FIRES = [
    "We just shipped bulk refunds.",
    "Instant booking launched last week.",
    "Co-traveler billing went live.",
    "The new payout flow is live.",
    "We rolled out split payments.",
    "Guests can now pay in two parts.",
    "The feature is released and in production.",
    "Hosts now support multi-car listings.",
  ];
  for (const body of FIRES) {
    it(`fires on: ${body}`, () => {
      expect(assertsUnverifiedShipClaim(art({ body_markdown: body }))).toBe(true);
    });
  }
});

describe("already-attributed prose is left alone (idempotence)", () => {
  const SKIP = [
    "The operator reported that split payment shipped in June.",
    "Per the operator, instant booking is live.",
    "The operator stated the payout flow went live last week.",
    "Operator-reported: bulk refunds launched.",
  ];
  for (const body of SKIP) {
    it(`does not double-attribute: ${body.slice(0, 44)}`, () => {
      expect(assertsUnverifiedShipClaim(art({ body_markdown: body }))).toBe(false);
      expect(attributeShipClaim(art({ body_markdown: body })).body_markdown).toBe(body);
    });
  }

  it("re-running the transform is a no-op (no stacked banners)", () => {
    const once = attributeShipClaim(art());
    const twice = attributeShipClaim(once);
    expect(twice).toBe(once);
    expect(twice.body_markdown.split(SHIP_CLAIM_ATTRIBUTION).length - 1).toBe(1);
  });
});

describe("scope — only durable note types", () => {
  it("leaves operator_preference untouched", () => {
    const a = art({ note_type: "operator_preference" });
    expect(assertsUnverifiedShipClaim(a)).toBe(false);
    expect(attributeShipClaim(a)).toBe(a);
  });

  it("leaves agent_feedback untouched", () => {
    const a = art({ note_type: "agent_feedback" });
    expect(assertsUnverifiedShipClaim(a)).toBe(false);
  });

  it("leaves a durable note with no ship claim untouched", () => {
    const a = art({
      title: "Host payout cadence",
      body_markdown: "Hosts are paid out every Tuesday for trips completed the prior week.",
    });
    expect(assertsUnverifiedShipClaim(a)).toBe(false);
    expect(attributeShipClaim(a)).toBe(a);
  });

  it("does not fire on an ABSENCE claim (that is the other guard's job)", () => {
    const a = art({
      body_markdown: "Split payment has not shipped and is not implemented in the backend.",
    });
    expect(assertsUnverifiedShipClaim(a)).toBe(false);
  });
});

describe("false positives codex enumerated — must stay inert", () => {
  const INERT = [
    "Security deposits are released 24 hours after checkout.",
    "Refunds are processed by the payments team within 5 business days.",
  ];
  for (const body of INERT) {
    it(`stays inert on: ${body.slice(0, 50)}`, () => {
      expect(assertsUnverifiedShipClaim(art({ body_markdown: body }))).toBe(false);
    });
  }
});

describe("the attribution detector must not be fooled by the NOUN 'claims'", () => {
  it("still fires on 'Damage claims are now available'", () => {
    const a = art({
      title: "Damage claims",
      body_markdown: "Damage claims are now available to hosts in the app.",
    });
    expect(assertsUnverifiedShipClaim(a)).toBe(true);
  });
});

describe("banner wording is source-neutral", () => {
  it("does not assert the claim came from the operator", () => {
    expect(SHIP_CLAIM_ATTRIBUTION.toLowerCase()).not.toContain("operator-reported");
    expect(SHIP_CLAIM_ATTRIBUTION).toMatch(/not verified against the codebase/);
  });
});

describe("negation — the opposite claim must not be banner-wrapped", () => {
  const NEGATED = [
    "Split payment has not shipped.",
    "Instant booking never launched.",
    "The payout flow is not live.",
    "Bulk refunds have not gone live.",
    "Co-traveler billing is no longer live.",
    "Multi-car listings are not yet in production.",
  ];
  for (const body of NEGATED) {
    it(`stays inert on: ${body}`, () => {
      expect(assertsUnverifiedShipClaim(art({ body_markdown: body }))).toBe(false);
      expect(attributeShipClaim(art({ body_markdown: body })).body_markdown).toBe(body);
    });
  }

  it("still fires when a mixed note carries one AFFIRMATIVE claim", () => {
    const a = art({
      body_markdown:
        "Instant booking has not shipped. Split payment is live for all guests.",
    });
    expect(assertsUnverifiedShipClaim(a)).toBe(true);
  });
});
