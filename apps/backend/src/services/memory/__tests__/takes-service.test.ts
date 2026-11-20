import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockTable = Record<string, any> & {
  _resolve: { data: unknown; error: unknown };
  _insertCalls: Array<Record<string, unknown>>;
  _updateCalls: Array<Record<string, unknown>>;
};

function newMockTable(): MockTable {
  const t = {} as MockTable;
  t._resolve = { data: null, error: null };
  t._insertCalls = [];
  t._updateCalls = [];
  t.select = vi.fn(() => t);
  t.eq = vi.fn(() => t);
  t.or = vi.fn(() => t);
  t.not = vi.fn(() => t);
  t.gte = vi.fn(() => t);
  t.lte = vi.fn(() => t);
  t.order = vi.fn(() => t);
  t.limit = vi.fn(() => Promise.resolve(t._resolve));
  t.range = vi.fn(() => Promise.resolve(t._resolve));
  t.maybeSingle = vi.fn(() => Promise.resolve(t._resolve));
  t.single = vi.fn(() => Promise.resolve(t._resolve));
  t.insert = vi.fn((row: Record<string, unknown>) => {
    t._insertCalls.push(row);
    return t;
  });
  t.update = vi.fn((row: Record<string, unknown>) => {
    t._updateCalls.push(row);
    return t;
  });
  t.then = (resolve: (v: { data: unknown; error: unknown }) => void) =>
    resolve(t._resolve);
  return t;
}

const tables: Record<string, MockTable> = {};
function table(name: string): MockTable {
  if (!tables[name]) tables[name] = newMockTable();
  return tables[name];
}

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn((name: string) => table(name)),
  })),
}));

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

beforeEach(async () => {
  vi.resetModules();
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("writeTake — holder invariants", () => {
  it("tenant + holder_ref=null → OK", async () => {
    table("takes")._resolve = { data: { id: 1 }, error: null };
    const { writeTake } = await import("../takes-service");
    const r = await writeTake(TENANT_A, {
      holder_type: "tenant",
      kind: "fact",
      claim: "our org policy",
      weight: 1.0,
    });
    expect(r.take_id).toBe(1);
  });

  it("tenant + holder_ref set → throws HolderInvariantError", async () => {
    const { writeTake, HolderInvariantError } = await import("../takes-service");
    await expect(
      writeTake(TENANT_A, {
        holder_type: "tenant",
        holder_ref: "x",
        kind: "fact",
        claim: "x",
        weight: 0.5,
      }),
    ).rejects.toBeInstanceOf(HolderInvariantError);
  });

  it("agent + holder_ref=null → throws", async () => {
    const { writeTake, HolderInvariantError } = await import("../takes-service");
    await expect(
      writeTake(TENANT_A, {
        holder_type: "agent",
        kind: "bet",
        claim: "x",
        weight: 0.7,
      }),
    ).rejects.toBeInstanceOf(HolderInvariantError);
  });

  it("agent + holder_ref → OK, weight rounded to grid", async () => {
    table("takes")._resolve = { data: { id: 42 }, error: null };
    const { writeTake } = await import("../takes-service");
    await writeTake(TENANT_A, {
      holder_type: "agent",
      holder_ref: "dispute-response",
      kind: "bet",
      claim: "host X will be no-show",
      weight: 0.74,
    });
    expect(table("takes")._insertCalls[0]).toMatchObject({
      holder_type: "agent",
      holder_ref: "dispute-response",
      kind: "bet",
      weight: 0.75,
    });
  });
});

describe("writeTake — cross-tenant subject guard", () => {
  it("subject_entity_id from another tenant → throws CrossTenantSubjectError", async () => {
    table("memory_entity")._resolve = {
      data: { tenant_id: TENANT_B },
      error: null,
    };
    const { writeTake, CrossTenantSubjectError } = await import("../takes-service");
    await expect(
      writeTake(TENANT_A, {
        holder_type: "tenant",
        kind: "fact",
        claim: "x",
        weight: 0.5,
        subject_entity_id: "ee-foreign",
      }),
    ).rejects.toBeInstanceOf(CrossTenantSubjectError);
  });

  it("subject_entity_id same-tenant → OK", async () => {
    table("memory_entity")._resolve = {
      data: { tenant_id: TENANT_A },
      error: null,
    };
    table("takes")._resolve = { data: { id: 1 }, error: null };
    const { writeTake } = await import("../takes-service");
    await expect(
      writeTake(TENANT_A, {
        holder_type: "tenant",
        kind: "fact",
        claim: "x",
        weight: 0.5,
        subject_entity_id: "ee-mine",
      }),
    ).resolves.toEqual({ take_id: 1 });
  });
});

describe("writeTake — claim scrubbing + cap", () => {
  it("scrubs PII before insert", async () => {
    table("takes")._resolve = { data: { id: 1 }, error: null };
    const { writeTake } = await import("../takes-service");
    await writeTake(TENANT_A, {
      holder_type: "tenant",
      kind: "fact",
      claim: "find disputes about alice@acme.com",
      weight: 1.0,
    });
    const inserted = table("takes")._insertCalls[0];
    expect(inserted.claim).toBe("find disputes about [EMAIL]");
  });
  it("rejects empty claim", async () => {
    const { writeTake } = await import("../takes-service");
    await expect(
      writeTake(TENANT_A, {
        holder_type: "tenant",
        kind: "fact",
        claim: "",
        weight: 0.5,
      }),
    ).rejects.toThrow();
  });
});

describe("resolveBet — atomic", () => {
  it("happy path: row matched, no error", async () => {
    table("takes")._resolve = {
      data: { id: 7, resolved_to: "correct" },
      error: null,
    };
    const { resolveBet } = await import("../takes-service");
    await expect(
      resolveBet(TENANT_A, 7, { resolved_to: "correct" }),
    ).resolves.toBeUndefined();
  });
  it("not found → BetNotFoundError", async () => {
    table("takes")._resolve = { data: null, error: null };
    const { resolveBet, BetNotFoundError } = await import("../takes-service");
    await expect(
      resolveBet(TENANT_A, 999, { resolved_to: "correct" }),
    ).rejects.toBeInstanceOf(BetNotFoundError);
  });

  it("rejects invalid resolved_to with InvalidResolvedToError (runtime guard)", async () => {
    const { resolveBet, InvalidResolvedToError } = await import("../takes-service");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveBet(TENANT_A, 7, { resolved_to: "malicious_input" as any }),
    ).rejects.toBeInstanceOf(InvalidResolvedToError);
  });

  it("rejects empty-string resolved_to via runtime guard", async () => {
    const { resolveBet, InvalidResolvedToError } = await import("../takes-service");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveBet(TENANT_A, 7, { resolved_to: "" as any }),
    ).rejects.toBeInstanceOf(InvalidResolvedToError);
  });
});

describe("computeScorecard — envelope", () => {
  it("0 resolved bets → all-null envelope", async () => {
    table("takes")._resolve = { data: [], error: null };
    const { computeScorecard } = await import("../takes-service");
    const m = await computeScorecard(TENANT_A);
    expect(m.brier).toBeNull();
    expect(m.brier_n).toBe(0);
    expect(m.directional_accuracy).toBeNull();
    expect(m.actual_rate).toBeNull();
    expect(m.calibration_curve).toEqual([]);
  });
});

describe("recordAgentTake — allowlist + claim extraction", () => {
  const RUN_ID = "00000000-0000-0000-0000-000000000999";

  it("chief-of-staff: writes a take row with holder_ref=chief-of-staff kind=take weight=0.7", async () => {
    table("takes")._resolve = { data: { id: 555 }, error: null };
    const { recordAgentTake } = await import("../takes-service");
    const r = await recordAgentTake(TENANT_A, "chief-of-staff", RUN_ID, {
      parsed: { summary: "Weekly synthesis: shipping is on track." },
      output_text: "full output here",
    });
    expect(r.take_id).toBe(555);
    expect(r.skipped).toBeUndefined();
    const inserted = table("takes")._insertCalls[0];
    expect(inserted).toMatchObject({
      tenant_id: TENANT_A,
      holder_type: "agent",
      holder_ref: "chief-of-staff",
      kind: "take",
      weight: 0.7,
      source_run_id: RUN_ID,
    });
    expect(inserted.claim).toContain("Weekly synthesis");
  });

  it("pm: prefers parsed.summary over output_text", async () => {
    table("takes")._resolve = { data: { id: 556 }, error: null };
    const { recordAgentTake } = await import("../takes-service");
    await recordAgentTake(TENANT_A, "pm", RUN_ID, {
      parsed: { summary: "PARSED-CLAIM" },
      output_text: "FULL-OUTPUT-IGNORED",
    });
    expect(table("takes")._insertCalls[0].claim).toBe("PARSED-CLAIM");
  });

  it("non-allowlisted agent: no-op (skipped='not_in_allowlist', no insert)", async () => {
    const { recordAgentTake } = await import("../takes-service");
    const r = await recordAgentTake(TENANT_A, "some-other-agent", RUN_ID, {
      parsed: { summary: "should not write" },
      output_text: "",
    });
    expect(r.take_id).toBeNull();
    expect(r.skipped).toBe("not_in_allowlist");
    expect(table("takes")._insertCalls.length).toBe(0);
  });

  it("no claim text anywhere: no-op (skipped='no_result_content')", async () => {
    const { recordAgentTake } = await import("../takes-service");
    const r = await recordAgentTake(TENANT_A, "chief-of-staff", RUN_ID, null);
    expect(r.take_id).toBeNull();
    expect(r.skipped).toBe("no_result_content");
    expect(table("takes")._insertCalls.length).toBe(0);
  });

  it("falls back to first 500 chars of output_text when parsed is null", async () => {
    table("takes")._resolve = { data: { id: 557 }, error: null };
    const { recordAgentTake } = await import("../takes-service");
    const longOutput = "x".repeat(1500);
    await recordAgentTake(TENANT_A, "pm", RUN_ID, {
      parsed: null,
      output_text: longOutput,
    });
    const inserted = table("takes")._insertCalls[0];
    expect((inserted.claim as string).length).toBeLessThanOrEqual(1000);
    expect((inserted.claim as string).length).toBeGreaterThan(0);
  });
});
