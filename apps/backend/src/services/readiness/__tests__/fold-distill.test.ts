import { describe, it, expect } from "vitest";
import { proposeFoldCandidates, type FoldSourceEvent } from "../fold-distill";
import type { TenantIdentity } from "../fold-guards";

const acme: TenantIdentity = {
  tenant_id: "t-acme",
  slug: "acme-rentals",
  display_name: "Acme Rentals",
  company_shape: "marketplace",
  product_host: "acmerentals.com",
};
const globex: TenantIdentity = {
  tenant_id: "t-globex",
  slug: "globex-saas",
  display_name: "Globex",
  company_shape: "saas",
  product_host: "globex.io",
};
const zenith: TenantIdentity = {
  tenant_id: "t-zenith",
  slug: "zenith-rentals",
  display_name: "Zenith Rentals",
  company_shape: "marketplace",
  product_host: "zenithrentals.com",
};

const TENANTS = new Map([
  [acme.tenant_id, acme],
  [globex.tenant_id, globex],
  [zenith.tenant_id, zenith],
]);

function ev(over: Partial<FoldSourceEvent> & { id: string; tenant_id: string }): FoldSourceEvent {
  return {
    gap_dimension: "connectors",
    action_kind: "connector_nudge",
    agent_training_hint: null,
    before_score: 30,
    after_score: 55,
    ...over,
  };
}

describe("proposeFoldCandidates", () => {
  it("proposes a lesson seen across two different businesses", () => {
    const { candidates } = proposeFoldCandidates(
      [
        ev({
          id: "e1",
          tenant_id: "t-acme",
          agent_training_hint: "When connectors are absent, ship a connector-free deliverable first.",
        }),
        ev({
          id: "e2",
          tenant_id: "t-globex",
          agent_training_hint: "Do not re-run discovery when only human-gated gaps remain.",
        }),
      ],
      TENANTS,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].source_tenant_count).toBe(2);
    expect(candidates[0].source_event_ids).toEqual(["e1", "e2"]);
    expect(candidates[0].tenant_fact_check).toBe("clean");
    expect(candidates[0].pattern_summary).toContain("connector-free deliverable");
    expect(candidates[0].pattern_summary).toContain("human-gated gaps");
  });

  it("REFUSES to fold a lesson seen on only ONE tenant — that is an anecdote", () => {
    const { candidates, rejections } = proposeFoldCandidates(
      [ev({ id: "e1", tenant_id: "t-acme", agent_training_hint: "Wire Stripe before anything else." })],
      TENANTS,
    );

    expect(candidates).toHaveLength(0);
    expect(rejections[0].reason).toBe("single_tenant");
    expect(rejections[0].detail).toMatch(/anecdote/i);
  });

  it("REFUSES to fold a lesson that still names a customer", () => {
    const { candidates, rejections } = proposeFoldCandidates(
      [
        ev({ id: "e1", tenant_id: "t-acme", agent_training_hint: "Acme Rentals never connects Stripe." }),
        ev({ id: "e2", tenant_id: "t-globex", agent_training_hint: "Same thing happened again." }),
      ],
      TENANTS,
    );

    expect(candidates).toHaveLength(0);
    expect(rejections[0].reason).toBe("contains_tenant_fact");
  });

  it("FLAGS (does not silently fold) a lesson learned from two possible competitors", () => {
    const { candidates } = proposeFoldCandidates(
      [
        ev({ id: "e1", tenant_id: "t-acme", agent_training_hint: "Produce a first deliverable before asking for connectors." }),
        ev({ id: "e2", tenant_id: "t-zenith", agent_training_hint: "Lead with an artifact, not a checklist." }),
      ],
      TENANTS,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].conflict_of_interest).toBe(true);
    expect(candidates[0].conflict_detail).toMatch(/competitors/i);
  });

  it("rejects a group where the FDE wrote no hint — there is nothing to teach", () => {
    const { candidates, rejections } = proposeFoldCandidates(
      [
        ev({ id: "e1", tenant_id: "t-acme", agent_training_hint: null }),
        ev({ id: "e2", tenant_id: "t-globex", agent_training_hint: "   " }),
      ],
      TENANTS,
    );

    expect(candidates).toHaveLength(0);
    expect(rejections[0].reason).toBe("no_hint");
  });

  it("groups by the SHAPE of the move, so unrelated rescues never merge into one lesson", () => {
    const { candidates } = proposeFoldCandidates(
      [
        ev({ id: "e1", tenant_id: "t-acme", gap_dimension: "connectors", action_kind: "connector_nudge", agent_training_hint: "Ask why the connector is missing." }),
        ev({ id: "e2", tenant_id: "t-globex", gap_dimension: "connectors", action_kind: "connector_nudge", agent_training_hint: "Offer to do it live on a call." }),
        ev({ id: "e3", tenant_id: "t-acme", gap_dimension: "verified_brain", action_kind: "brain_correct", agent_training_hint: "Ground the brain in the site before inferring." }),
        ev({ id: "e4", tenant_id: "t-globex", gap_dimension: "verified_brain", action_kind: "brain_correct", agent_training_hint: "Never infer geography from a name." }),
      ],
      TENANTS,
    );

    expect(candidates).toHaveLength(2);
    const gaps = candidates.map((c) => c.gap_dimension).sort();
    expect(gaps).toEqual(["connectors", "verified_brain"]);
    const brain = candidates.find((c) => c.gap_dimension === "verified_brain")!;
    expect(brain.pattern_summary).not.toContain("connector");
  });

  it("dedupes identical hints so a repeated rescue does not become a repeated sentence", () => {
    const { candidates } = proposeFoldCandidates(
      [
        ev({ id: "e1", tenant_id: "t-acme", agent_training_hint: "Ship an artifact first." }),
        ev({ id: "e2", tenant_id: "t-globex", agent_training_hint: "ship an artifact first." }),
      ],
      TENANTS,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].pattern_summary).toBe("Ship an artifact first.");
  });
});
