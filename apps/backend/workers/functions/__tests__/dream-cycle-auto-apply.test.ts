import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../client", () => ({
  inngest: { createFunction: (..._args: unknown[]) => ({ id: "dream-cycle" }) },
}));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/anthropic", () => ({ getAnthropic: vi.fn(), DEFAULT_MODEL: "test-model" }));
vi.mock("@/services/memory", () => ({ findNearestNeighbors: vi.fn(), writeNote: vi.fn() }));
vi.mock("@/services/memory/embed", () => ({ embedTexts: vi.fn() }));
vi.mock("@/services/memory/write-path", () => ({ recordWrites: vi.fn() }));
vi.mock("@/services/agents/prompt-injection", () => ({ renderUntrustedBlock: vi.fn(() => "") }));
vi.mock("@/services/memory/recall-holdout", () => ({ runRecallHoldout: vi.fn() }));
vi.mock("@/services/memory/conflict-resolution", () => ({ DEFAULT_TRUST_TIER: 2 }));

import { dreamVerdictDisposition, autoApplyDreamVerdict, lastFullyJudgedRow } from "../dream-cycle";

const TENANT = "00000000-0000-0000-0000-000000000001";
const NEW_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const OLD_ID = "bbbbbbbb-0000-0000-0000-000000000002";

function makeFakeSb(opts?: { rpcError?: string }) {
  const notes = new Map<string, { id: string; superseded_by: string | null }>([
    [NEW_ID, { id: NEW_ID, superseded_by: null }],
    [OLD_ID, { id: OLD_ID, superseded_by: null }],
  ]);
  const verdicts: Array<{ tenant_id: string; new_note_id: string; existing_note_id: string; verdict: string }> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const sb = {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (opts?.rpcError) return Promise.resolve({ error: { message: opts.rpcError } });
      if (fn === "apply_dream_verdict") {
        const nid = args.p_new_id as string;
        const eid = args.p_existing_id as string;
        const verdict = args.p_verdict as string;
        const nrow = notes.get(nid);
        const erow = notes.get(eid);
        if (nrow && erow && nrow.superseded_by === null && erow.superseded_by === null) {
          if (verdict === "KEEP_NEW") erow.superseded_by = nid;
          else if (verdict === "KEEP_OLD") nrow.superseded_by = eid;
        }
      }
      return Promise.resolve({ error: null });
    },
    from(_table: string) {
      return {
        insert(row: Record<string, unknown>) {
          const key = `${row.tenant_id}|${row.new_note_id}|${row.existing_note_id}`;
          if (!verdicts.some((v) => `${v.tenant_id}|${v.new_note_id}|${v.existing_note_id}` === key)) {
            verdicts.push({
              tenant_id: row.tenant_id as string,
              new_note_id: row.new_note_id as string,
              existing_note_id: row.existing_note_id as string,
              verdict: row.verdict as string,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  type SbParam = Parameters<typeof autoApplyDreamVerdict>[0];
  return { sb: sb as unknown as SbParam, notes, verdicts, rpcCalls };
}

describe("dreamVerdictDisposition (pure consolidation policy)", () => {
  const base = {
    cosine: 0.92,
    newTrustTier: 2,
    existingTrustTier: 2,
    hasMergeBody: false,
    autoApplyEnabled: true,
    keysMatch: true,
  };

  it("auto-applies a HIGH-CONFIDENCE KEEP_NEW (cosine clears bar, trust ok, same key)", () => {
    expect(dreamVerdictDisposition({ ...base, verdict: "KEEP_NEW" })).toBe("auto_apply");
  });

  it("auto-applies a HIGH-CONFIDENCE KEEP_OLD (new equal-or-lower trust than existing)", () => {
    expect(dreamVerdictDisposition({ ...base, verdict: "KEEP_OLD" })).toBe("auto_apply");
  });

  it("HOLDS a low-confidence decisive verdict (cosine below the bar)", () => {
    expect(dreamVerdictDisposition({ ...base, verdict: "KEEP_NEW", cosine: 0.80 })).toBe("hold");
  });

  it("HOLDS MERGE even at very high cosine (writes new content — founder only)", () => {
    expect(
      dreamVerdictDisposition({ ...base, verdict: "MERGE", cosine: 0.99, hasMergeBody: true }),
    ).toBe("hold");
  });

  it("HOLDS a trust-blocked KEEP_NEW (incoming would bury a HIGHER-trust note)", () => {
    expect(
      dreamVerdictDisposition({ ...base, verdict: "KEEP_NEW", existingTrustTier: 0, newTrustTier: 2 }),
    ).toBe("hold");
  });

  it("HOLDS a trust-blocked KEEP_OLD (new is HIGHER trust than surviving existing)", () => {
    expect(
      dreamVerdictDisposition({ ...base, verdict: "KEEP_OLD", newTrustTier: 0, existingTrustTier: 2 }),
    ).toBe("hold");
  });

  it("HOLDS a replacement (KEEP_NEW) without an exact subject + attribute match", () => {
    expect(dreamVerdictDisposition({ ...base, verdict: "KEEP_NEW", keysMatch: false })).toBe("hold");
  });

  it("still auto-applies a duplicate (KEEP_OLD) with no keys: it only marks a restatement", () => {
    expect(dreamVerdictDisposition({ ...base, verdict: "KEEP_OLD", keysMatch: false })).toBe("auto_apply");
  });

  it("HOLDS anything that touches an id / money / rate value", () => {
    expect(dreamVerdictDisposition({ ...base, verdict: "KEEP_OLD", protectedValue: true })).toBe("hold");
    expect(dreamVerdictDisposition({ ...base, verdict: "KEEP_NEW", protectedValue: true })).toBe("hold");
  });

  it("logs (no mutation) for NO_CONFLICT", () => {
    expect(dreamVerdictDisposition({ ...base, verdict: "NO_CONFLICT" })).toBe("log_only");
  });

  it("HOLDS everything actionable when the kill switch disables auto-apply", () => {
    expect(
      dreamVerdictDisposition({ ...base, verdict: "KEEP_NEW", autoApplyEnabled: false }),
    ).toBe("hold");
  });
});

describe("autoApplyDreamVerdict (executor — sets superseded_by, idempotent)", () => {
  it("KEEP_NEW supersedes the EXISTING note (sets superseded_by) + logs the verdict", async () => {
    const { sb, notes, verdicts, rpcCalls } = makeFakeSb();
    const applied = await autoApplyDreamVerdict(sb, {
      tenant_id: TENANT,
      new_note_id: NEW_ID,
      existing_note_id: OLD_ID,
      verdict: "KEEP_NEW",
      rationale: "newer count supersedes older",
      cost_tokens: 42,
    });
    expect(applied).toBe(true);
    expect(notes.get(OLD_ID)!.superseded_by).toBe(NEW_ID);
    expect(notes.get(NEW_ID)!.superseded_by).toBeNull();
    expect(rpcCalls).toEqual([
      {
        fn: "apply_dream_verdict",
        args: {
          p_tenant_id: TENANT,
          p_new_id: NEW_ID,
          p_existing_id: OLD_ID,
          p_verdict: "KEEP_NEW",
          p_rationale: "newer count supersedes older",
        },
      },
    ]);
    expect(verdicts).toHaveLength(1);
  });

  it("is IDEMPOTENT: a second auto-apply of the same pair is a no-op (no flip, no dup log)", async () => {
    const { sb, notes, verdicts } = makeFakeSb();
    const args = {
      tenant_id: TENANT,
      new_note_id: NEW_ID,
      existing_note_id: OLD_ID,
      verdict: "KEEP_NEW" as const,
      rationale: "r",
      cost_tokens: 1,
    };
    await autoApplyDreamVerdict(sb, args);
    await autoApplyDreamVerdict(sb, args);
    expect(notes.get(OLD_ID)!.superseded_by).toBe(NEW_ID);
    expect(verdicts).toHaveLength(1);
  });

  it("returns false on RPC error so the caller logs the pair as held (never drops it)", async () => {
    const { sb, notes, verdicts } = makeFakeSb({ rpcError: "row lock timeout" });
    const applied = await autoApplyDreamVerdict(sb, {
      tenant_id: TENANT,
      new_note_id: NEW_ID,
      existing_note_id: OLD_ID,
      verdict: "KEEP_NEW",
      rationale: "r",
      cost_tokens: 1,
    });
    expect(applied).toBe(false);
    expect(notes.get(OLD_ID)!.superseded_by).toBeNull();
    expect(verdicts).toHaveLength(0);
  });
});

describe("lastFullyJudgedRow (the cursor never skips an unjudged note)", () => {
  it("all candidates judged: the whole page is done", () => {
    expect(lastFullyJudgedRow(5, [0, 0, 3], 3)).toBe(4);
  });
  it("no candidates at all: the whole page is done", () => {
    expect(lastFullyJudgedRow(5, [], 0)).toBe(4);
  });
  it("stopped mid-page: done up to the row before the first unjudged candidate", () => {
    expect(lastFullyJudgedRow(5, [0, 0, 3, 3], 2)).toBe(2);
  });
  it("stopped before anything: nothing is done", () => {
    expect(lastFullyJudgedRow(5, [0, 1], 0)).toBe(-1);
  });
});
