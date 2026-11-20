import { describe, it, expect } from "vitest";
import {
  applyTrustTierPrecedence,
  precedenceBucket,
  applyRelevanceFloor,
} from "../precedence";

describe("precedenceBucket", () => {
  it("tier 0 and 1 are company-fact bucket regardless of note_type", () => {
    expect(precedenceBucket({ trust_tier: 0, note_type: "agent_experience" })).toBe(0);
    expect(precedenceBucket({ trust_tier: 1, note_type: "agent_experience" })).toBe(0);
  });
  it("tier 2 agent_experience is episodic bucket", () => {
    expect(precedenceBucket({ trust_tier: 2, note_type: "agent_experience" })).toBe(1);
  });
  it("declarative note_type is company-fact even at tier 2", () => {
    expect(precedenceBucket({ trust_tier: 2, note_type: "operator_preference" })).toBe(0);
    expect(precedenceBucket({ trust_tier: 2, note_type: "anchor" })).toBe(0);
  });
  it("null/unknown tier is treated as agent-inferred (bucket 1)", () => {
    expect(precedenceBucket({ note_type: "untyped" })).toBe(1);
    expect(precedenceBucket({ trust_tier: null, note_type: "untyped" })).toBe(1);
  });
});

describe("applyTrustTierPrecedence", () => {
  it("THE CLAMP: a tier-0 operator fact ranks above a higher-score tier-2 episodic", () => {
    const hits = [
      { note_id: "episodic", score: 0.95, trust_tier: 2, note_type: "agent_experience" },
      { note_id: "operator_fact", score: 0.40, trust_tier: 0, note_type: "operator_preference" },
    ];
    applyTrustTierPrecedence(hits);
    expect(hits[0].note_id).toBe("operator_fact");
    expect(hits[1].note_id).toBe("episodic");
  });

  it("preserves within-bucket order (stable) — score order kept inside each bucket", () => {
    const hits = [
      { note_id: "fact_hi", score: 0.9, trust_tier: 0 },
      { note_id: "epi_hi", score: 0.8, trust_tier: 2 },
      { note_id: "fact_lo", score: 0.7, trust_tier: 1 },
      { note_id: "epi_lo", score: 0.6, trust_tier: 2 },
    ];
    applyTrustTierPrecedence(hits);
    expect(hits.map((h) => h.note_id)).toEqual(["fact_hi", "fact_lo", "epi_hi", "epi_lo"]);
  });

  it("is a no-op ordering when all hits are the same bucket", () => {
    const hits = [
      { note_id: "a", score: 0.9, trust_tier: 2 },
      { note_id: "b", score: 0.8, trust_tier: 2 },
    ];
    applyTrustTierPrecedence(hits);
    expect(hits.map((h) => h.note_id)).toEqual(["a", "b"]);
  });
});

describe("applyRelevanceFloor (precedence-aware floor)", () => {
  it("REGRESSION: a low-score tier-0 company fact survives the floor that just clamped it to the top", () => {
    const hits = [
      { note_id: "operator_fact", score: 0.4, trust_tier: 0, note_type: "operator_preference" },
      { note_id: "episodic", score: 0.95, trust_tier: 2, note_type: "agent_experience" },
    ];
    const kept = applyRelevanceFloor(hits, 0.45);
    expect(kept.map((h) => h.note_id)).toEqual(["operator_fact", "episodic"]);
  });

  it("still drops a below-floor tier-2 episodic / off-topic hit (floor's real job preserved)", () => {
    const hits = [
      { note_id: "on_topic", score: 0.8, trust_tier: 2, note_type: "agent_experience" },
      { note_id: "off_topic", score: 0.2, trust_tier: 2, note_type: "agent_experience" },
    ];
    const kept = applyRelevanceFloor(hits, 0.45);
    expect(kept.map((h) => h.note_id)).toEqual(["on_topic"]);
  });

  it("exempts operator-authored declaratives even at tier 2 (anchor / operator_preference / correction)", () => {
    const hits = [
      { note_id: "anchor", score: 0.1, trust_tier: 2, note_type: "anchor" },
      { note_id: "op_pref", score: 0.1, trust_tier: 2, note_type: "operator_preference" },
      { note_id: "correction", score: 0.1, trust_tier: 2, note_type: "correction" },
      { note_id: "untyped_noise", score: 0.1, trust_tier: 2, note_type: "untyped" },
    ];
    const kept = applyRelevanceFloor(hits, 0.45);
    expect(kept.map((h) => h.note_id)).toEqual(["anchor", "op_pref", "correction"]);
  });

  it("REGRESSION (brain-stress FINDING-1, 2026-05-24): tier-2 agent-DISTILLED tenant_reference / tenant_project below the floor is DROPPED (not exempt)", () => {
    const hits = [
      { note_id: "ref", score: 0.19, trust_tier: 2, note_type: "tenant_reference" },
      { note_id: "proj", score: 0.19, trust_tier: 2, note_type: "tenant_project" },
    ];
    const kept = applyRelevanceFloor(hits, 0.35);
    expect(kept).toEqual([]);
  });

  it("exempts tier-0 / tier-1 facts regardless of note_type (operator-stated / connector-observed)", () => {
    const hits = [
      { note_id: "tier0_ref", score: 0.1, trust_tier: 0, note_type: "tenant_reference" },
      { note_id: "tier1_proj", score: 0.1, trust_tier: 1, note_type: "tenant_project" },
      { note_id: "tier1_episodic", score: 0.1, trust_tier: 1, note_type: "agent_experience" },
    ];
    const kept = applyRelevanceFloor(hits, 0.45);
    expect(kept.map((h) => h.note_id)).toEqual([
      "tier0_ref",
      "tier1_proj",
      "tier1_episodic",
    ]);
  });

  it("drops a below-floor null/unknown-tier hit (treated as agent-inferred, not protected)", () => {
    const hits = [
      { note_id: "unknown_low", score: 0.1, trust_tier: null, note_type: "untyped" },
    ];
    expect(applyRelevanceFloor(hits, 0.45)).toEqual([]);
  });

  it("floor <= 0 is a no-op (returns input unchanged)", () => {
    const hits = [
      { note_id: "a", score: 0.1, trust_tier: 2 },
      { note_id: "b", score: 0.9, trust_tier: 2 },
    ];
    expect(applyRelevanceFloor(hits, 0)).toBe(hits);
    expect(applyRelevanceFloor(hits, -1)).toBe(hits);
  });

  it("does not mutate the input array (returns a new filtered array)", () => {
    const hits = [
      { note_id: "keep", score: 0.9, trust_tier: 2 },
      { note_id: "drop", score: 0.1, trust_tier: 2 },
    ];
    const kept = applyRelevanceFloor(hits, 0.45);
    expect(hits).toHaveLength(2);
    expect(kept).toHaveLength(1);
  });
});

describe("precedence ranks (memory write path F: trust before type)", () => {
  it("a tier-3 fetched/connector fact never outranks a user-stated fact, whatever its type", () => {
    const hits = [
      { note_id: "fetched_ref", score: 0.99, trust_tier: 3, note_type: "tenant_reference" },
      { note_id: "user_said", score: 0.3, trust_tier: 0, note_type: "tenant_reference" },
      { note_id: "agent_ref", score: 0.9, trust_tier: 2, note_type: "tenant_reference" },
    ];
    applyTrustTierPrecedence(hits);
    expect(hits.map((h) => h.note_id)).toEqual(["user_said", "agent_ref", "fetched_ref"]);
  });

  it("ranks operator-authored, then connector signal, then agent-distilled, then episodic", () => {
    const hits = [
      { note_id: "episodic", score: 0.9, trust_tier: 2, note_type: "agent_experience" },
      { note_id: "agent_ref", score: 0.9, trust_tier: 2, note_type: "tenant_reference" },
      { note_id: "connector", score: 0.9, trust_tier: 1, note_type: "tenant_reference" },
      { note_id: "op_pref", score: 0.1, trust_tier: 2, note_type: "operator_preference" },
    ];
    applyTrustTierPrecedence(hits);
    expect(hits.map((h) => h.note_id)).toEqual(["op_pref", "connector", "agent_ref", "episodic"]);
  });

  it("a tier-3 declarative is no longer in the company-fact bucket", () => {
    expect(precedenceBucket({ trust_tier: 3, note_type: "tenant_reference" })).toBe(1);
  });
});
