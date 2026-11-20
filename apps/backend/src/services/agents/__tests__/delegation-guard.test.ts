
import { describe, it, expect, vi, beforeEach } from "vitest";

type Term = { data?: unknown; error?: unknown };
const rpcResults: Term[] = [];
const insertResults: Term[] = [];
let lastInsertedRow: Record<string, unknown> | null = null;
let lastRpcArgs: { fn: string; args: unknown } | null = null;

function makeClient() {
  return {
    rpc(fn: string, args: unknown) {
      rpcCallCount++;
      lastRpcArgs = { fn, args };
      return Promise.resolve(rpcResults.shift() ?? { data: null, error: null });
    },
    from(_t: string) {
      return {
        insert(row: Record<string, unknown>) {
          lastInsertedRow = row;
          return Promise.resolve(insertResults.shift() ?? { error: null });
        },
      };
    },
  };
}
vi.mock("@/services/supabase", () => ({
  serviceClient: () => makeClient(),
}));
const logEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (...a: unknown[]) => logEvent(...a),
}));

import {
  decideDelegation,
  checkDelegationAllowed,
  checkFanoutDelegationsAllowed,
  recordDelegation,
  readLineageContext,
  buildChildLineagePayload,
  MAX_DELEGATION_DEPTH,
  LINEAGE_COST_CEILING_USD,
  LINEAGE_ID_KEY,
  LINEAGE_DEPTH_KEY,
  type DelegationDecisionInput,
} from "../delegation-guard";

let rpcCallCount = 0;

beforeEach(() => {
  rpcResults.length = 0;
  insertResults.length = 0;
  lastInsertedRow = null;
  lastRpcArgs = null;
  rpcCallCount = 0;
  logEvent.mockClear();
});

function mkInput(over: Partial<DelegationDecisionInput> = {}): DelegationDecisionInput {
  return {
    parentDepth: over.parentDepth ?? 0,
    targetSlug: over.targetSlug ?? "engineer",
    lineageSlugs: over.lineageSlugs ?? [],
    cumulativeCost: over.cumulativeCost ?? 0,
  };
}

describe("decideDelegation: constants are generous (dormant at current scale)", () => {
  it("MAX_DELEGATION_DEPTH is 8", () => {
    expect(MAX_DELEGATION_DEPTH).toBe(8);
  });
  it("LINEAGE_COST_CEILING_USD is 25", () => {
    expect(LINEAGE_COST_CEILING_USD).toBe(25);
  });
});

describe("decideDelegation: normal shallow delegation passes (the common case)", () => {
  it("root operator turn (depth 0) → child depth 1, allowed", () => {
    const d = decideDelegation(mkInput({ parentDepth: 0 }));
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.childDepth).toBe(1);
  });

  it("depth 1 → child depth 2, allowed (operator→specialist→peer, post-Gap-4)", () => {
    const d = decideDelegation(mkInput({ parentDepth: 1 }));
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.childDepth).toBe(2);
  });

  it("a ≤5 fan-out off a root tree ($0, depth 0) — each sibling passes", () => {
    const siblings = ["engineer", "qa", "performance-marketer", "support-lead", "pm"];
    for (const slug of siblings) {
      const d = decideDelegation(
        mkInput({ parentDepth: 0, targetSlug: slug, cumulativeCost: 0, lineageSlugs: [] }),
      );
      expect(d.allow).toBe(true);
    }
  });

  it("a tree at $5 (≤5 × ~$1) is still well under the $25 ceiling", () => {
    const d = decideDelegation(mkInput({ parentDepth: 1, cumulativeCost: 5 }));
    expect(d.allow).toBe(true);
  });
});

describe("decideDelegation: DEPTH gate", () => {
  it("at the boundary — parentDepth makes childDepth === MAX → allowed", () => {
    const d = decideDelegation(mkInput({ parentDepth: MAX_DELEGATION_DEPTH - 1 }));
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.childDepth).toBe(MAX_DELEGATION_DEPTH);
  });

  it("one past the boundary — childDepth === MAX+1 → refused depth_exceeded", () => {
    const d = decideDelegation(mkInput({ parentDepth: MAX_DELEGATION_DEPTH }));
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("depth_exceeded");
      expect(d.escalate).toBe(false);
      expect(d.detail.childDepth).toBe(MAX_DELEGATION_DEPTH + 1);
      expect(d.detail.maxDepth).toBe(MAX_DELEGATION_DEPTH);
    }
  });

  it("far past the boundary → refused", () => {
    const d = decideDelegation(mkInput({ parentDepth: 50 }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("depth_exceeded");
  });

  it("FAIL-CLOSED: NaN parentDepth → refused depth_exceeded (not a slip-through)", () => {
    const d = decideDelegation(mkInput({ parentDepth: NaN }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("depth_exceeded");
  });

  it("FAIL-CLOSED: negative parentDepth → refused", () => {
    const d = decideDelegation(mkInput({ parentDepth: -1 }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("depth_exceeded");
  });

  it("FAIL-CLOSED: Infinity parentDepth → refused", () => {
    const d = decideDelegation(mkInput({ parentDepth: Number.POSITIVE_INFINITY }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("depth_exceeded");
  });
});

describe("decideDelegation: CYCLE gate", () => {
  it("target already in the lineage → refused cycle_detected", () => {
    const d = decideDelegation(
      mkInput({
        parentDepth: 2,
        targetSlug: "engineer",
        lineageSlugs: ["engineer", "qa"],
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("cycle_detected");
      expect(d.escalate).toBe(false);
      expect(d.detail.targetSlug).toBe("engineer");
    }
  });

  it("target NOT in the lineage → not a cycle (allowed)", () => {
    const d = decideDelegation(
      mkInput({ parentDepth: 1, targetSlug: "performance-marketer", lineageSlugs: ["engineer"] }),
    );
    expect(d.allow).toBe(true);
  });

  it("A→B→A: re-delegating to the very first hop is a cycle", () => {
    const d = decideDelegation(
      mkInput({ parentDepth: 2, targetSlug: "A", lineageSlugs: ["A", "B"] }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("cycle_detected");
  });

  it("depth gate WINS over cycle when both trip (depth checked first)", () => {
    const d = decideDelegation(
      mkInput({
        parentDepth: MAX_DELEGATION_DEPTH + 1,
        targetSlug: "engineer",
        lineageSlugs: ["engineer"],
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("depth_exceeded");
  });
});

describe("decideDelegation: COST gate (money-path backstop — escalates)", () => {
  it("under ceiling → allowed", () => {
    const d = decideDelegation(mkInput({ cumulativeCost: LINEAGE_COST_CEILING_USD - 0.01 }));
    expect(d.allow).toBe(true);
  });

  it("AT the ceiling → refused cost_ceiling_exceeded + escalate", () => {
    const d = decideDelegation(mkInput({ cumulativeCost: LINEAGE_COST_CEILING_USD }));
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("cost_ceiling_exceeded");
      expect(d.escalate).toBe(true);
    }
  });

  it("over the ceiling → refused + escalate", () => {
    const d = decideDelegation(mkInput({ cumulativeCost: 1000 }));
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("cost_ceiling_exceeded");
      expect(d.escalate).toBe(true);
    }
  });

  it("FAIL-CLOSED: NaN cumulativeCost → refused + escalate", () => {
    const d = decideDelegation(mkInput({ cumulativeCost: NaN }));
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("cost_ceiling_exceeded");
      expect(d.escalate).toBe(true);
    }
  });

  it("FAIL-CLOSED: negative cumulativeCost → refused", () => {
    const d = decideDelegation(mkInput({ cumulativeCost: -5 }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("cost_ceiling_exceeded");
  });

  it("depth gate WINS over cost when both trip (depth checked first)", () => {
    const d = decideDelegation(
      mkInput({ parentDepth: 99, cumulativeCost: 9999 }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("depth_exceeded");
  });

  it("cycle gate WINS over cost when both trip (cycle checked before cost)", () => {
    const d = decideDelegation(
      mkInput({ parentDepth: 1, targetSlug: "X", lineageSlugs: ["X"], cumulativeCost: 9999 }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("cycle_detected");
  });
});

describe("decideDelegation: full depth × cost × cycle cross-product matrix", () => {
  const depthOk = 1;
  const depthOver = MAX_DELEGATION_DEPTH;
  const costOk = 1;
  const costOver = LINEAGE_COST_CEILING_USD + 1;

  type Case = {
    parentDepth: number;
    cumulativeCost: number;
    lineageSlugs: string[];
    expect: "ok" | "depth_exceeded" | "cycle_detected" | "cost_ceiling_exceeded";
  };
  const target = "engineer";
  const cases: Case[] = [
    { parentDepth: depthOk, cumulativeCost: costOk, lineageSlugs: [], expect: "ok" },
    { parentDepth: depthOk, cumulativeCost: costOk, lineageSlugs: [target], expect: "cycle_detected" },
    { parentDepth: depthOk, cumulativeCost: costOver, lineageSlugs: [], expect: "cost_ceiling_exceeded" },
    { parentDepth: depthOk, cumulativeCost: costOver, lineageSlugs: [target], expect: "cycle_detected" },
    { parentDepth: depthOver, cumulativeCost: costOk, lineageSlugs: [], expect: "depth_exceeded" },
    { parentDepth: depthOver, cumulativeCost: costOk, lineageSlugs: [target], expect: "depth_exceeded" },
    { parentDepth: depthOver, cumulativeCost: costOver, lineageSlugs: [], expect: "depth_exceeded" },
    { parentDepth: depthOver, cumulativeCost: costOver, lineageSlugs: [target], expect: "depth_exceeded" },
  ];

  for (const c of cases) {
    it(`depth=${c.parentDepth} cost=${c.cumulativeCost} cycle=${c.lineageSlugs.length > 0} → ${c.expect}`, () => {
      const d = decideDelegation({
        parentDepth: c.parentDepth,
        targetSlug: target,
        lineageSlugs: c.lineageSlugs,
        cumulativeCost: c.cumulativeCost,
      });
      if (c.expect === "ok") {
        expect(d.allow).toBe(true);
      } else {
        expect(d.allow).toBe(false);
        if (!d.allow) expect(d.reason).toBe(c.expect);
      }
    });
  }
});

describe("readLineageContext", () => {
  it("null/undefined payload → root {null, 0}", () => {
    expect(readLineageContext(null)).toEqual({ lineage_id: null, depth: 0 });
    expect(readLineageContext(undefined)).toEqual({ lineage_id: null, depth: 0 });
  });

  it("payload with NEITHER key → root {null, 0} (user-initiated operator turn)", () => {
    expect(readLineageContext({ intent: "do x" })).toEqual({ lineage_id: null, depth: 0 });
  });

  it("payload with both keys → that context (delegated child)", () => {
    const ctx = readLineageContext({ [LINEAGE_ID_KEY]: "lin-1", [LINEAGE_DEPTH_KEY]: 3 });
    expect(ctx).toEqual({ lineage_id: "lin-1", depth: 3 });
  });

  it("malformed values degrade to root-safe (empty id → null, non-numeric depth → 0)", () => {
    expect(readLineageContext({ [LINEAGE_ID_KEY]: "", [LINEAGE_DEPTH_KEY]: "x" })).toEqual({
      lineage_id: null,
      depth: 0,
    });
    expect(readLineageContext({ [LINEAGE_ID_KEY]: 42, [LINEAGE_DEPTH_KEY]: -1 })).toEqual({
      lineage_id: null,
      depth: 0,
    });
  });

  it("floors a fractional depth", () => {
    expect(readLineageContext({ [LINEAGE_ID_KEY]: "l", [LINEAGE_DEPTH_KEY]: 2.9 }).depth).toBe(2);
  });
});

describe("buildChildLineagePayload", () => {
  it("merges the reserved keys without mutating the base", () => {
    const base = { intent: "x", user_id: "u1" };
    const out = buildChildLineagePayload(base, { lineage_id: "lin-9", childDepth: 4 });
    expect(out).toEqual({
      intent: "x",
      user_id: "u1",
      [LINEAGE_ID_KEY]: "lin-9",
      [LINEAGE_DEPTH_KEY]: 4,
    });
    expect(base).toEqual({ intent: "x", user_id: "u1" });
  });

  it("round-trips through readLineageContext", () => {
    const out = buildChildLineagePayload({}, { lineage_id: "lin-rt", childDepth: 2 });
    expect(readLineageContext(out)).toEqual({ lineage_id: "lin-rt", depth: 2 });
  });
});

const baseGuardInput = {
  tenant_id: "t1",
  source_agent_slug: "operator",
  target_agent_slug: "engineer",
};

describe("checkDelegationAllowed: ROOT operator turn (no inbound lineage)", () => {
  it("mints a fresh lineage, child depth 1, NO RPC read (empty tree fast path)", async () => {
    const r = await checkDelegationAllowed(
      { ...baseGuardInput, parentLineage: { lineage_id: null, depth: 0 } },
      () => "minted-lineage-1",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lineage_id).toBe("minted-lineage-1");
      expect(r.childDepth).toBe(1);
    }
    expect(lastRpcArgs).toBeNull();
  });
});

describe("checkDelegationAllowed: deeper hop reads the ledger", () => {
  it("under all limits → allowed, continues the existing lineage", async () => {
    rpcResults.push({
      data: [{ max_depth: 1, target_slugs: ["engineer"], cumulative_cost: 3 }],
      error: null,
    });
    const r = await checkDelegationAllowed({
      ...baseGuardInput,
      source_agent_slug: "engineer",
      target_agent_slug: "qa",
      parentLineage: { lineage_id: "lin-existing", depth: 1 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lineage_id).toBe("lin-existing");
      expect(r.childDepth).toBe(2);
    }
    expect(lastRpcArgs?.fn).toBe("lineage_tree_stats");
  });

  it("DEPTH over → refused depth_exceeded (logged)", async () => {
    rpcResults.push({
      data: [{ max_depth: MAX_DELEGATION_DEPTH, target_slugs: [], cumulative_cost: 0 }],
      error: null,
    });
    const r = await checkDelegationAllowed({
      ...baseGuardInput,
      parentLineage: { lineage_id: "lin-deep", depth: MAX_DELEGATION_DEPTH },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("depth_exceeded");
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "delegation_guard.depth_exceeded" }),
    );
  });

  it("CYCLE → refused cycle_detected (target already in the tree)", async () => {
    rpcResults.push({
      data: [{ max_depth: 2, target_slugs: ["engineer", "qa"], cumulative_cost: 2 }],
      error: null,
    });
    const r = await checkDelegationAllowed({
      ...baseGuardInput,
      source_agent_slug: "qa",
      target_agent_slug: "engineer",
      parentLineage: { lineage_id: "lin-cyc", depth: 2 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cycle_detected");
  });

  it("COST over → refused cost_ceiling_exceeded + escalate", async () => {
    rpcResults.push({
      data: [{ max_depth: 1, target_slugs: ["qa"], cumulative_cost: 30 }],
      error: null,
    });
    const r = await checkDelegationAllowed({
      ...baseGuardInput,
      target_agent_slug: "performance-marketer",
      parentLineage: { lineage_id: "lin-rich", depth: 1 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("cost_ceiling_exceeded");
      expect(r.escalate).toBe(true);
    }
  });
});

describe("checkDelegationAllowed: FAIL-CLOSED on lookup error", () => {
  it("RPC error → refused lookup_failed + escalate (logged)", async () => {
    rpcResults.push({ data: null, error: { message: "db down" } });
    const r = await checkDelegationAllowed({
      ...baseGuardInput,
      parentLineage: { lineage_id: "lin-x", depth: 2 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("lookup_failed");
      expect(r.escalate).toBe(true);
    }
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "delegation_guard.lookup_failed" }),
    );
  });

  it("RPC returns no row → refused lookup_failed", async () => {
    rpcResults.push({ data: [], error: null });
    const r = await checkDelegationAllowed({
      ...baseGuardInput,
      parentLineage: { lineage_id: "lin-x", depth: 2 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("lookup_failed");
  });

  it("RPC returns non-finite numbers → refused lookup_failed (boundary guard)", async () => {
    rpcResults.push({
      data: [{ max_depth: NaN, target_slugs: [], cumulative_cost: 5 }],
      error: null,
    });
    const r = await checkDelegationAllowed({
      ...baseGuardInput,
      parentLineage: { lineage_id: "lin-x", depth: 2 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("lookup_failed");
  });

  it("RPC throws → caught → refused lookup_failed (never propagates)", async () => {
    rpcResults.push({
      get data(): never {
        throw new Error("kaboom");
      },
    } as unknown as Term);
    const r = await checkDelegationAllowed({
      ...baseGuardInput,
      parentLineage: { lineage_id: "lin-x", depth: 2 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("lookup_failed");
  });

  it("single-object (non-array) RPC return is also supported", async () => {
    rpcResults.push({
      data: { max_depth: 1, target_slugs: ["qa"], cumulative_cost: 1 },
      error: null,
    });
    const r = await checkDelegationAllowed({
      ...baseGuardInput,
      target_agent_slug: "performance-marketer",
      parentLineage: { lineage_id: "lin-obj", depth: 1 },
    });
    expect(r.ok).toBe(true);
  });
});

describe("recordDelegation", () => {
  const edge = {
    tenant_id: "t1",
    lineage_id: "lin-1",
    depth: 1,
    parent_run_id: "run-parent",
    child_run_id: "run-child",
    source_agent_slug: "operator",
    target_agent_slug: "engineer",
  };

  it("inserts the edge row and returns true on success", async () => {
    const ok = await recordDelegation(edge);
    expect(ok).toBe(true);
    expect(lastInsertedRow).toMatchObject({
      tenant_id: "t1",
      lineage_id: "lin-1",
      depth: 1,
      parent_run_id: "run-parent",
      child_run_id: "run-child",
      source_agent_slug: "operator",
      target_agent_slug: "engineer",
    });
  });

  it("NON-FATAL on insert error → returns false, logs at ERROR, never throws", async () => {
    insertResults.push({ error: { message: "constraint blip" } });
    const ok = await recordDelegation(edge);
    expect(ok).toBe(false);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", code: "delegation.lineage_write_failed" }),
    );
  });

  it("supports a null parent (root delegation edge)", async () => {
    const ok = await recordDelegation({ ...edge, parent_run_id: null });
    expect(ok).toBe(true);
    expect(lastInsertedRow).toMatchObject({ parent_run_id: null });
  });
});

describe("telemetry is C14-safe", () => {
  it("guard refusal log meta carries only the target agent_slug (allowlisted key)", async () => {
    rpcResults.push({
      data: [{ max_depth: MAX_DELEGATION_DEPTH, target_slugs: [], cumulative_cost: 0 }],
      error: null,
    });
    await checkDelegationAllowed({
      ...baseGuardInput,
      target_agent_slug: "engineer",
      parentLineage: { lineage_id: "lin-deep", depth: MAX_DELEGATION_DEPTH },
    });
    const call = logEvent.mock.calls.find(
      (c) => (c[0] as { code?: string }).code === "delegation_guard.depth_exceeded",
    );
    expect(call).toBeDefined();
    const arg = call![0] as { meta?: Record<string, unknown> };
    expect(Object.keys(arg.meta ?? {})).toEqual(["agent_slug"]);
    expect(arg.meta?.agent_slug).toBe("engineer");
  });
});

const fanBase = {
  tenant_id: "t1",
  source_agent_slug: "operator",
  parentLineage: { lineage_id: null, depth: 0 } as const,
};

describe("checkFanoutDelegationsAllowed", () => {
  it("ROOT ≤5 fan-out: all pass, one minted lineage at depth 1, ZERO RPC reads", async () => {
    const r = await checkFanoutDelegationsAllowed(
      fanBase,
      ["engineer", "qa", "performance-marketer", "support-lead", "pm"],
      () => "fan-lineage-1",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lineage_id).toBe("fan-lineage-1");
      expect(r.childDepth).toBe(1);
    }
    expect(rpcCallCount).toBe(0);
  });

  it("CONTINUING fan-out reads the ledger EXACTLY ONCE (not once-per-sibling)", async () => {
    rpcResults.push({
      data: [{ max_depth: 1, target_slugs: ["engineer"], cumulative_cost: 2 }],
      error: null,
    });
    const r = await checkFanoutDelegationsAllowed(
      { ...fanBase, parentLineage: { lineage_id: "lin-cont", depth: 1 } },
      ["qa", "performance-marketer", "pm"],
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lineage_id).toBe("lin-cont");
      expect(r.childDepth).toBe(2);
    }
    expect(rpcCallCount).toBe(1);
  });

  it("ALL-OR-NOTHING: a cycle in ONE sibling refuses the whole fan-out", async () => {
    rpcResults.push({
      data: [{ max_depth: 1, target_slugs: ["engineer"], cumulative_cost: 1 }],
      error: null,
    });
    const r = await checkFanoutDelegationsAllowed(
      { ...fanBase, parentLineage: { lineage_id: "lin-cyc", depth: 1 } },
      ["qa", "engineer"],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cycle_detected");
  });

  it("FAIL-CLOSED: stats lookup error refuses the whole fan-out + escalates", async () => {
    rpcResults.push({ data: null, error: { message: "db down" } });
    const r = await checkFanoutDelegationsAllowed(
      { ...fanBase, parentLineage: { lineage_id: "lin-x", depth: 1 } },
      ["qa", "performance-marketer"],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("lookup_failed");
      expect(r.escalate).toBe(true);
    }
  });

  it("DEPTH-exceeded fan-out: refused (all siblings share the over-depth)", async () => {
    rpcResults.push({
      data: [{ max_depth: MAX_DELEGATION_DEPTH, target_slugs: [], cumulative_cost: 1 }],
      error: null,
    });
    const r = await checkFanoutDelegationsAllowed(
      { ...fanBase, parentLineage: { lineage_id: "lin-deep", depth: MAX_DELEGATION_DEPTH } },
      ["qa", "performance-marketer"],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("depth_exceeded");
  });

  it("empty target list → refused defensively (caller validates non-empty)", async () => {
    const r = await checkFanoutDelegationsAllowed(fanBase, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("lookup_failed");
  });
});
