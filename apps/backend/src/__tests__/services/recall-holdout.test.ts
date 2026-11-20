import { describe, it, expect } from "vitest";
import {
  runRecallHoldout,
  type RecallHoldoutCandidate,
  type RecallHoldoutDeps,
} from "@/services/memory/recall-holdout";
import type { Golden } from "@/services/memory/recall-eval";

const TENANT = "tenant-A";

function golden(id: string, query: string, expected: string[]): Golden {
  return { id, tenant_id: TENANT, query, expected_note_ids: expected };
}

function makeDeps(opts: {
  goldens: Golden[] | (() => Promise<Golden[]>);
  searchMap: Record<string, string[]>;
  owned?: string[];
  throwSearch?: boolean;
  onDemand?: Golden[] | (() => Promise<Golden[]>);
}): RecallHoldoutDeps {
  return {
    loadGoldens: typeof opts.goldens === "function"
      ? opts.goldens
      : async () => opts.goldens as Golden[],
    loadOnDemandGoldens: typeof opts.onDemand === "function"
      ? opts.onDemand
      : async () => (opts.onDemand as Golden[]) ?? [],
    search: async (_t, query) => {
      if (opts.throwSearch) throw new Error("boom-search");
      return (opts.searchMap[query] ?? []).map((note_id) => ({ note_id }));
    },
    verifyTenantNotes: async (_t, ids) => {
      if (!opts.owned) return new Set(ids);
      return new Set(ids.filter((id) => opts.owned!.includes(id)));
    },
  };
}

const keepOld = (newId: string, existingId: string): RecallHoldoutCandidate => ({
  verdict: "KEEP_OLD",
  new_note_id: newId,
  existing_note_id: existingId,
});
const keepNew = (newId: string, existingId: string): RecallHoldoutCandidate => ({
  verdict: "KEEP_NEW",
  new_note_id: newId,
  existing_note_id: existingId,
});

describe("runRecallHoldout", () => {
  it("(a) superseding an irrelevant note keeps recall → neutral", async () => {
    const deps = makeDeps({
      goldens: [golden("g1", "q1", ["n1"])],
      searchMap: { q1: ["n1", "n2"] },
    });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("n2", "x") }, deps);
    expect(r.eval_status).toBe("neutral");
    expect(r.recall_before).toBe(1);
    expect(r.recall_after).toBe(1);
    expect(r.top3_delta).toBe(0);
    expect(r.regressed_golden_count).toBe(0);
    expect(r.cross_tenant_hits).toBe(0);
    expect(r.n_goldens).toBe(1);
  });

  it("(b) superseding a still-expected note orphans the golden → regressed", async () => {
    const deps = makeDeps({
      goldens: [golden("g1", "q1", ["n1"])],
      searchMap: { q1: ["n1", "n2", "n3"] },
    });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("n1", "x") }, deps);
    expect(r.eval_status).toBe("regressed");
    expect(r.recall_before).toBe(1);
    expect(r.recall_after).toBe(0);
    expect(r.regressed_golden_count).toBe(1);
    expect(r.top3_delta).toBeLessThan(0);
  });

  it("(b2) KEEP_NEW hides the existing note", async () => {
    const deps = makeDeps({
      goldens: [golden("g1", "q1", ["nE"])],
      searchMap: { q1: ["nE", "nN"] },
    });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepNew("nN", "nE") }, deps);
    expect(r.eval_status).toBe("regressed");
    expect(r.regressed_golden_count).toBe(1);
  });

  it("(c) a returned foreign-tenant note → cross_tenant_hits>0 + regressed", async () => {
    const deps = makeDeps({
      goldens: [golden("g1", "q1", ["n1"])],
      searchMap: { q1: ["n1", "foreign1"] },
      owned: ["n1"],
    });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("nX", "x") }, deps);
    expect(r.cross_tenant_hits).toBeGreaterThan(0);
    expect(r.eval_status).toBe("regressed");
  });

  it("(d) a search dep failure → error, never a silent pass", async () => {
    const deps = makeDeps({
      goldens: [golden("g1", "q1", ["n1"])],
      searchMap: { q1: ["n1"] },
      throwSearch: true,
    });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("nX", "x") }, deps);
    expect(r.eval_status).toBe("error");
  });

  it("(e) a goldens load failure → error (distinct from no_goldens)", async () => {
    const deps = makeDeps({
      goldens: async () => {
        throw new Error("db down");
      },
      searchMap: {},
    });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("nX", "x") }, deps);
    expect(r.eval_status).toBe("error");
  });

  it("(f) zero goldens → no_goldens", async () => {
    const deps = makeDeps({ goldens: [], searchMap: {} });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("nX", "x") }, deps);
    expect(r.eval_status).toBe("no_goldens");
    expect(r.n_goldens).toBe(0);
  });

  it("(g) MERGE → unmeasured (cannot shadow-evaluate a non-existent survivor)", async () => {
    const deps = makeDeps({ goldens: [golden("g1", "q1", ["n1"])], searchMap: { q1: ["n1"] } });
    const merge: RecallHoldoutCandidate = { verdict: "MERGE", new_note_id: "n1", existing_note_id: "n2" };
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: merge }, deps);
    expect(r.eval_status).toBe("unmeasured");
    expect(r.recall_before).toBeNull();
  });

  it("(h) result is aggregate-only — no note IDs in the payload", async () => {
    const deps = makeDeps({
      goldens: [golden("g1", "q1", ["n1", "secretNote"])],
      searchMap: { q1: ["n1", "secretNote"] },
    });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("n1", "x") }, deps);
    const json = JSON.stringify(r);
    expect(json).not.toContain("secretNote");
    expect(json).not.toContain("n1");
    expect(Object.keys(r).sort()).toEqual(
      [
        "cross_tenant_hits",
        "eval_status",
        "n_goldens",
        "recall_after",
        "recall_before",
        "regressed_golden_count",
        "top3_delta",
      ].sort(),
    );
  });

  it("(i) reward-hack guard: the public first arg cannot carry goldens or a threshold", async () => {
    const deps = makeDeps({ goldens: [golden("g1", "q1", ["n1"])], searchMap: { q1: ["n1"] } });
    // @ts-expect-error — goldens is not an accepted field on the public signature
    await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("nX", "x"), goldens: [] }, deps);
    // @ts-expect-error — threshold is not an accepted field either
    await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("nX", "x"), threshold: 0 }, deps);
    expect(true).toBe(true);
  });

  it("(j) hand goldens WIN — on-demand is never consulted when hand goldens exist", async () => {
    let onDemandCalled = false;
    const deps = makeDeps({
      goldens: [golden("g1", "q1", ["n1"])],
      searchMap: { q1: ["n1"] },
      onDemand: async () => {
        onDemandCalled = true;
        return [golden("od", "qZ", ["n1"])];
      },
    });
    await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("n2", "x") }, deps);
    expect(onDemandCalled).toBe(false);
  });

  it("(k) no hand goldens → on-demand trace synthesizes a golden; hiding a load-bearing note → regressed", async () => {
    const deps = makeDeps({
      goldens: [],
      onDemand: [golden("ondemand:0", "qPast", ["n1"])],
      searchMap: { qPast: ["n1", "other"] },
    });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("n1", "x") }, deps);
    expect(r.eval_status).toBe("regressed");
    expect(r.regressed_golden_count).toBe(1);
    expect(r.n_goldens).toBe(1);
  });

  it("(l) on-demand: hiding a note that isn't top-3 for its query → neutral", async () => {
    const deps = makeDeps({
      goldens: [],
      onDemand: [golden("ondemand:0", "qPast", ["n1"])],
      searchMap: { qPast: ["a", "b", "c", "n1"] },
    });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("n1", "x") }, deps);
    expect(r.eval_status).toBe("neutral");
    expect(r.recall_before).toBe(0);
  });

  it("(m) on-demand loader failure → error (fail-closed, never a silent pass)", async () => {
    const deps = makeDeps({
      goldens: [],
      onDemand: async () => {
        throw new Error("eval_candidates db down");
      },
      searchMap: {},
    });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("nX", "x") }, deps);
    expect(r.eval_status).toBe("error");
  });

  it("(n) no hand goldens AND no on-demand traces → no_goldens", async () => {
    const deps = makeDeps({ goldens: [], onDemand: [], searchMap: {} });
    const r = await runRecallHoldout({ tenantId: TENANT, candidate: keepOld("nX", "x") }, deps);
    expect(r.eval_status).toBe("no_goldens");
    expect(r.n_goldens).toBe(0);
  });
});
