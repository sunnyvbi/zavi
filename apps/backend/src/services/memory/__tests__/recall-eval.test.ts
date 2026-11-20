import { describe, it, expect } from "vitest";
import {
  runMemoryRecallEval,
  orderHolds,
  ALERT_TOP3_RECALL_THRESHOLD,
  type Golden,
  type RecallEvalDeps,
} from "../recall-eval";

const TENANT = "11111111-1111-1111-1111-111111111111";

function golden(id: string, query: string, expected: string[]): Golden {
  return { id, tenant_id: TENANT, query, expected_note_ids: expected };
}

function deps(
  searchMap: Record<string, string[]>,
  foreign: Set<string> = new Set(),
): RecallEvalDeps {
  return {
    search: async (_t, query) => (searchMap[query] ?? []).map((note_id) => ({ note_id })),
    verifyTenantNotes: async (_t, note_ids) =>
      new Set(note_ids.filter((id) => !foreign.has(id))),
  };
}

describe("runMemoryRecallEval", () => {
  it("all expected notes in top-3 → recall 1.0, not alarmed", async () => {
    const goldens = [golden("g1", "weekend payout", ["n1"]), golden("g2", "refund sla", ["n2"])];
    const r = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "eval", goldens },
      deps({ "weekend payout": ["n1", "nx"], "refund sla": ["n2", "ny"] }),
    );
    expect(r.top3_recall).toBe(1);
    expect(r.cross_tenant_hits).toBe(0);
    expect(r.alarmed).toBe(false);
    expect(r.failures).toHaveLength(0);
  });

  it("expected note absent from top-3 → counts as miss, alarmed below threshold", async () => {
    const goldens = [golden("g1", "q1", ["n1"]), golden("g2", "q2", ["n2"])];
    const r = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "eval", goldens },
      deps({ q1: ["n1"], q2: ["zz", "yy", "xx", "n2"] }),
    );
    expect(r.top3_recall).toBe(0.5);
    expect(r.alarmed).toBe(true);
    expect(r.failures.map((f) => f.golden_id)).toEqual(["g2"]);
  });

  it("MRR reflects rank of first expected hit", async () => {
    const goldens = [golden("g1", "q1", ["n1"])];
    const r = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "eval", goldens },
      deps({ q1: ["other", "n1"] }),
    );
    expect(r.mrr).toBe(0.5);
    expect(r.top3_recall).toBe(1);
  });

  it("cross-tenant leak → cross_tenant_hits>0 AND alarmed even with perfect recall", async () => {
    const goldens = [golden("g1", "q1", ["n1"])];
    const r = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "eval", goldens },
      deps({ q1: ["n1", "foreign1"] }, new Set(["foreign1"])),
    );
    expect(r.top3_recall).toBe(1);
    expect(r.cross_tenant_hits).toBe(1);
    expect(r.alarmed).toBe(true);
  });

  it("empty golden set → recall 0, NOT alarmed (no signal)", async () => {
    const r = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "canary", goldens: [] },
      deps({}),
    );
    expect(r.queries_run).toBe(0);
    expect(r.top3_recall).toBe(0);
    expect(r.alarmed).toBe(false);
  });

  it("search throwing is treated as a miss, not a crash", async () => {
    const goldens = [golden("g1", "q1", ["n1"])];
    const throwingDeps: RecallEvalDeps = {
      search: async () => {
        throw new Error("voyage down");
      },
      verifyTenantNotes: async () => new Set(),
    };
    const r = await runMemoryRecallEval({ tenant_id: TENANT, mode: "canary", goldens }, throwingDeps);
    expect(r.top3_recall).toBe(0);
    expect(r.cross_tenant_hits).toBe(0);
    expect(r.alarmed).toBe(true);
  });

  it("custom (canary catastrophe) threshold: a fine-grained dip below 0.85 does NOT alarm at 0.5", async () => {
    const goldens = [golden("g1", "q1", ["n1"]), golden("g2", "q2", ["n2"]), golden("g3", "q3", ["n3"])];
    const map = { q1: ["n1"], q2: ["n2"], q3: ["miss"] };
    const def = await runMemoryRecallEval({ tenant_id: TENANT, mode: "eval", goldens }, deps(map));
    expect(def.top3_recall).toBeCloseTo(0.667, 2);
    expect(def.alarmed).toBe(true);

    const canary = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "canary", goldens, threshold: 0.5 },
      deps(map),
    );
    expect(canary.top3_recall).toBeCloseTo(0.667, 2);
    expect(canary.alarmed).toBe(false);
  });

  it("custom (loose canary) threshold still alarms on a real catastrophe", async () => {
    const goldens = [golden("g1", "q1", ["n1"]), golden("g2", "q2", ["n2"]), golden("g3", "q3", ["n3"])];
    const r = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "canary", goldens, threshold: 0.5 },
      deps({ q1: ["n1"], q2: ["x"], q3: ["y"] }),
    );
    expect(r.alarmed).toBe(true);
  });

  it("threshold boundary: exactly at threshold is not alarmed", async () => {
    const goldens = Array.from({ length: 10 }, (_, i) =>
      golden(`g${i}`, `q${i}`, [`n${i}`]),
    );
    const map: Record<string, string[]> = {};
    goldens.forEach((g, i) => {
      map[g.query] = i < 9 ? [`n${i}`] : ["miss"];
    });
    const r = await runMemoryRecallEval({ tenant_id: TENANT, mode: "eval", goldens }, deps(map));
    expect(r.top3_recall).toBe(0.9);
    expect(r.top3_recall).toBeGreaterThanOrEqual(ALERT_TOP3_RECALL_THRESHOLD);
    expect(r.alarmed).toBe(false);
  });

  it("negative golden (empty expected) PASSES when the floor drops all hits", async () => {
    const goldens = [golden("g1", "weekend payout", ["n1"]), golden("neg1", "quantum chromodynamics", [])];
    const r = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "eval", goldens },
      deps({ "weekend payout": ["n1"], "quantum chromodynamics": [] }),
    );
    expect(r.top3_recall).toBe(1);
    expect(r.alarmed).toBe(false);
    expect(r.failures).toHaveLength(0);
  });

  it("negative golden FAILS + alarms when the floor regresses (off-topic returns hits)", async () => {
    const goldens = [golden("g1", "weekend payout", ["n1"]), golden("neg1", "quantum chromodynamics", [])];
    const r = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "eval", goldens },
      deps({ "weekend payout": ["n1"], "quantum chromodynamics": ["junk1", "junk2"] }),
    );
    expect(r.top3_recall).toBe(0.5);
    expect(r.alarmed).toBe(true);
    expect(r.failures.map((f) => f.golden_id)).toEqual(["neg1"]);
  });

  it("negative golden does not pollute MRR", async () => {
    const goldens = [golden("neg1", "off topic", [])];
    const r = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "eval", goldens },
      deps({ "off topic": [] }),
    );
    expect(r.mrr).toBe(0);
    expect(r.top3_recall).toBe(1);
  });
});

describe("orderHolds (precedence proof helper)", () => {
  it("true when ids appear in the given relative order", () => {
    expect(orderHolds(["fact", "epi", "x"], ["fact", "epi"])).toBe(true);
    expect(orderHolds(["fact", "y", "epi"], ["fact", "epi"])).toBe(true);
  });
  it("false when order is reversed", () => {
    expect(orderHolds(["epi", "fact"], ["fact", "epi"])).toBe(false);
  });
  it("false when an expected id is missing", () => {
    expect(orderHolds(["fact"], ["fact", "epi"])).toBe(false);
  });
});

describe("runMemoryRecallEval — order goldens (the clamp's falsifiable test)", () => {
  const orderGolden = (id: string, query: string, order: string[]): Golden => ({
    id,
    tenant_id: TENANT,
    query,
    expected_note_ids: [],
    expected_order: order,
  });

  it("passes when tier-0 fact ranks above tier-2 episodic", async () => {
    const r = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "eval", goldens: [orderGolden("o1", "pause campaign", ["fact", "epi"])] },
      deps({ "pause campaign": ["fact", "epi"] }),
    );
    expect(r.top3_recall).toBe(1);
    expect(r.alarmed).toBe(false);
  });

  it("FAILS (alarms) when episodic outranks the company fact", async () => {
    const r = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "eval", goldens: [orderGolden("o1", "pause campaign", ["fact", "epi"])] },
      deps({ "pause campaign": ["epi", "fact"] }),
    );
    expect(r.top3_recall).toBe(0);
    expect(r.alarmed).toBe(true);
  });
});

describe("runMemoryRecallEval — agent_slug threading (Slice 3/4)", () => {
  it("passes the golden's agent_slug into the search dep", async () => {
    const seen: Array<string | null | undefined> = [];
    const recordingDeps: RecallEvalDeps = {
      search: async (_t, _q, _k, agent_slug) => {
        seen.push(agent_slug);
        return [{ note_id: "n1" }];
      },
      verifyTenantNotes: async (_t, ids) => new Set(ids),
    };
    const g: Golden = { id: "g1", tenant_id: TENANT, query: "q", expected_note_ids: ["n1"], agent_slug: "performance-marketer" };
    await runMemoryRecallEval({ tenant_id: TENANT, mode: "eval", goldens: [g] }, recordingDeps);
    expect(seen).toEqual(["performance-marketer"]);
  });
});
