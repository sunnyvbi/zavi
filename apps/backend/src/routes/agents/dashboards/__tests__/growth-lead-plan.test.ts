
import { describe, it, expect, vi, beforeEach } from "vitest";
import { build } from "../growth-lead";
import type { DashboardContext } from "../_contract";

const mockGetBoolSetting = vi.fn();
vi.mock("@/services/settings", () => ({
  getBoolSetting: (...a: unknown[]) => mockGetBoolSetting(...a),
}));

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

type Row = Record<string, unknown> & { tenant_id: string };

function makeSb(tables: Record<string, Row[]>) {
  const s: {
    table: string;
    tenantEq: string | null;
    noteTypeEq: string | null;
    classIn: string[] | null;
    tagsContain: string[] | null;
    supersededNull: boolean;
  } = {
    table: "",
    tenantEq: null,
    noteTypeEq: null,
    classIn: null,
    tagsContain: null,
    supersededNull: false,
  };
  const chain: Record<string, unknown> = {
    from(t: string) {
      s.table = t;
      s.tenantEq = null;
      s.noteTypeEq = null;
      s.classIn = null;
      s.tagsContain = null;
      s.supersededNull = false;
      return chain;
    },
    select: () => chain,
    eq: (col: string, val: string) => {
      if (col === "tenant_id") s.tenantEq = val;
      if (col === "note_type") s.noteTypeEq = val;
      return chain;
    },
    in: (col: string, vals: string[]) => {
      if (col === "decision_class") s.classIn = vals;
      return chain;
    },
    contains: (col: string, vals: string[]) => {
      if (col === "tags") s.tagsContain = vals;
      return chain;
    },
    is: (col: string, val: unknown) => {
      if (col === "superseded_by" && val === null) s.supersededNull = true;
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
      let data = (tables[s.table] ?? []).slice();
      if (s.tenantEq !== null) data = data.filter((r) => r.tenant_id === s.tenantEq);
      if (s.noteTypeEq !== null)
        data = data.filter((r) => r.note_type === s.noteTypeEq);
      if (s.classIn !== null)
        data = data.filter((r) => s.classIn!.includes(r.decision_class as string));
      if (s.tagsContain !== null)
        data = data.filter(
          (r) =>
            Array.isArray(r.tags) &&
            s.tagsContain!.every((t) => (r.tags as string[]).includes(t)),
        );
      if (s.supersededNull) data = data.filter((r) => r.superseded_by == null);
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return chain;
}

function ctx(tenantId: string, tables: Record<string, Row[]>): DashboardContext {
  return {
    tenantId,
    accessToken: "tok",
    ctx: { tenant_id: tenantId } as unknown,
    sb: makeSb(tables),
  } as unknown as DashboardContext;
}

const planNoteA: Row = {
  id: "note-a",
  tenant_id: TENANT_A,
  note_type: "growth_priorities",
  tags: ["current-growth-plan", "stage:leaky_loop"],
  superseded_by: null,
  metadata: {
    kind: "current_growth_plan",
    injected_secret: "SHOULD-NOT-LEAK",
    plan: {
      stage: "leaky_loop",
      now: { action: "Fix the activation drop with a day-3 email", exec: "yes" },
      next: [
        { action: "Add onboarding checklist", exec: "manual" },
        { action: "Connect Stripe for cohort payback", exec: "needs-connector" },
      ],
      later: ["Referral loop", "Paid retargeting test"],
      updated_at: "2026-07-13T10:00:00Z",
      internal_debug: "raw model prose that could name a customer",
    },
  },
};

const planNoteB: Row = {
  id: "note-b",
  tenant_id: TENANT_B,
  note_type: "growth_priorities",
  tags: ["current-growth-plan", "stage:pre_loop"],
  superseded_by: null,
  metadata: {
    plan: {
      stage: "pre_loop",
      now: { action: "TENANT B SECRET PLAN — must never appear for A", exec: "yes" },
      next: [],
      later: [],
      updated_at: "2026-07-13T10:00:00Z",
    },
  },
};

beforeEach(() => {
  mockGetBoolSetting.mockReset();
  mockGetBoolSetting.mockResolvedValue(false);
});

describe("growth-lead dashboard — Current growth plan (slice 4)", () => {
  it("surfaces tenant A's plan only — tenant B's is excluded (cross-tenant floor)", async () => {
    const d = (await build(
      ctx(TENANT_A, { memory_note: [planNoteA, planNoteB], decisions: [] }),
    )) as Record<string, any>;
    expect(d.connected).toBe(true);
    expect(d.current_growth_plan.stage).toBe("leaky_loop");
    const flat = JSON.stringify(d);
    expect(flat).not.toContain("TENANT B SECRET PLAN");
    expect(flat).not.toContain("note-b");
  });

  it("keeps the panel alive on a plan note ALONE (no connectors, no bets)", async () => {
    const d = (await build(
      ctx(TENANT_A, { memory_note: [planNoteA], decisions: [] }),
    )) as Record<string, any>;
    expect(d.connected).toBe(true);
    expect(d.current_growth_plan).not.toBeNull();
  });

  it("whitelists the plan — raw metadata (kind / injected keys / debug) never leaks", async () => {
    const d = (await build(
      ctx(TENANT_A, { memory_note: [planNoteA], decisions: [] }),
    )) as Record<string, any>;
    const plan = d.current_growth_plan;
    expect(Object.keys(plan).sort()).toEqual(
      ["later", "next", "now", "stage", "updated_at"].sort(),
    );
    expect(plan.now).toEqual({
      action: "Fix the activation drop with a day-3 email",
      exec: "yes",
    });
    expect(plan.next).toHaveLength(2);
    expect(plan.next[1].exec).toBe("needs-connector");
    expect(plan.later).toEqual(["Referral loop", "Paid retargeting test"]);
    const flat = JSON.stringify(d);
    expect(flat).not.toContain("current_growth_plan\":{\"kind");
    expect(flat).not.toContain("injected_secret");
    expect(flat).not.toContain("SHOULD-NOT-LEAK");
    expect(flat).not.toContain("internal_debug");
    expect(flat).not.toContain("raw model prose");
  });

  it("empty/absent plan + no connectors + no bets → connect state, no throw", async () => {
    const d = (await build(
      ctx(TENANT_A, { memory_note: [], decisions: [] }),
    )) as Record<string, any>;
    expect(d.connected).toBe(false);
    expect(d.current_growth_plan).toBeUndefined();
  });

  it("a malformed plan (unknown stage) is treated as no plan (null / connect state)", async () => {
    const bad: Row = {
      id: "note-bad",
      tenant_id: TENANT_A,
      note_type: "growth_priorities",
      tags: ["current-growth-plan"],
      superseded_by: null,
      metadata: { plan: { stage: "totally_made_up", now: null } },
    };
    const d = (await build(
      ctx(TENANT_A, { memory_note: [bad], decisions: [] }),
    )) as Record<string, any>;
    expect(d.connected).toBe(false);
    expect(d.current_growth_plan).toBeUndefined();
  });
});
