import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: () => { throw new Error("tests pass their own db"); }, globalClient: () => { throw new Error("tests pass their own db"); } }));

import { logEvent } from "@/services/logging/logEvent";
import { isFlatJobPricingOn, isRunFlatBilled, recordBilledCredits, recordBilledCreditsForRun } from "../flat-pricing";

function fakeSb(
  blob: Record<string, unknown> | null,
  opts: { failRead?: boolean; failWrites?: number; run?: Record<string, unknown> | null; failRunRead?: boolean } = {},
) {
  const writes: Array<{ id: string; tenant: string; billed_credits: number }> = [];
  const guards: string[] = [];
  let failsLeft = opts.failWrites ?? 0;
  return {
    writes,
    guards,
    config: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            opts.failRead ? { data: null, error: { message: "x" } } : { data: blob === null ? null : { blob }, error: null },
        }),
      }),
    }),
    runs: (tenant: string) => {
      const read = async () =>
        opts.failRunRead ? { data: null, error: { message: "read" } } : { data: opts.run ?? null, error: null };
      return {
      select: () => ({
        eq: () => ({
          maybeSingle: read,
          eq: (_c: string, v: unknown) => {
            guards.push(`read ${_c}=${String(v)}`);
            return { maybeSingle: read };
          },
        }),
      }),
      update: (row: { billed_credits: number }) => ({
        eq: (_c: string, id: string) => ({
          eq: (sc: string, sv: unknown) => {
            guards.push(`${sc}=${String(sv)}`);
            return {
          is: async (col: string, v: unknown) => {
            guards.push(`${col}=${String(v)}`);
            if (failsLeft > 0) {
              failsLeft--;
              return { error: { message: "boom" } };
            }
            writes.push({ id, tenant, billed_credits: row.billed_credits });
            return { error: null };
          },
            };
          },
        }),
      }),
      };
    },
  };
}

describe("flat pricing off switch", () => {
  it("is on when unset, off only on an explicit false", async () => {
    expect(await isFlatJobPricingOn(fakeSb({}) as never)).toBe(true);
    expect(await isFlatJobPricingOn(fakeSb({ flat_job_pricing: true }) as never)).toBe(true);
    expect(await isFlatJobPricingOn(fakeSb({ flat_job_pricing: false }) as never)).toBe(false);
    expect(await isFlatJobPricingOn(fakeSb({ flat_job_pricing: "false" }) as never)).toBe(false);
  });
  it("a failed read keeps the default (on)", async () => {
    expect(await isFlatJobPricingOn(fakeSb(null, { failRead: true }) as never)).toBe(true);
  });
});

describe("recordBilledCredits", () => {
  it("writes the job's flat price on the run, tenant-scoped, only if unset", async () => {
    const sb = fakeSb({});
    const r = await recordBilledCredits(
      { runId: "r1", tenantId: "t1", agentSlug: "cgo", trigger: "a2a", payload: { stage: "own_goals", note_kind: "alarm" } },
      sb as never,
    );
    expect(r).toEqual({ jobId: "cgo-goal-review-alarm", credits: 450 });
    expect(sb.writes).toEqual([{ id: "r1", tenant: "t1", billed_credits: 450 }]);
    expect(sb.guards).toEqual(["status=running", "billed_credits=null"]);
  });
  it("writes nothing for a job with no price row (real cost applies)", async () => {
    const sb = fakeSb({});
    expect(await recordBilledCredits({ runId: "r2", tenantId: "t1", agentSlug: "brand-new-agent", trigger: "chat" }, sb as never)).toBeNull();
    expect(sb.writes).toEqual([]);
  });
  it("retries a failed write once", async () => {
    const sb = fakeSb({}, { failWrites: 1 });
    expect(await recordBilledCredits({ runId: "r3", tenantId: "t1", agentSlug: "operator", trigger: "chat" }, sb as never)).toEqual({
      jobId: "operator-chat",
      credits: 110,
    });
    expect(sb.writes).toHaveLength(1);
  });
  it("never throws when both writes fail, and logs an error", async () => {
    const sb = fakeSb({}, { failWrites: 2 });
    expect(await recordBilledCredits({ runId: "r4", tenantId: "t1", agentSlug: "operator", trigger: "chat" }, sb as never)).toBeNull();
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "billed_credits_write_failed", run_id: "r4" }));
  });
});

describe("isRunFlatBilled", () => {
  it("true when the settled run still carries its price", async () => {
    expect(await isRunFlatBilled("t1", "r1", fakeSb({}, { run: { billed_credits: 450 } }) as never)).toBe(true);
  });
  it("false when the run has no price (or settle cleared it)", async () => {
    expect(await isRunFlatBilled("t1", "r1", fakeSb({}, { run: { billed_credits: null } }) as never)).toBe(false);
  });
  it("ignores the current switch: the settled row is the truth", async () => {
    expect(await isRunFlatBilled("t1", "r1", fakeSb({ flat_job_pricing: false }, { run: { billed_credits: 450 } }) as never)).toBe(true);
  });
  it("throws on a read error so the caller retries instead of refunding", async () => {
    await expect(isRunFlatBilled("t1", "r1", fakeSb({}, { failRunRead: true }) as never)).rejects.toThrow();
  });
});

describe("recordBilledCreditsForRun (local lane)", () => {
  it("reads the started run and writes its flat price", async () => {
    const sb = fakeSb({}, { run: { agent_slug: "operator", payload: null, cron_dedupe_key: null } });
    await recordBilledCreditsForRun("r9", "t1", "cron", sb as never);
    expect(sb.writes).toEqual([{ id: "r9", tenant: "t1", billed_credits: 260 }]);
    expect(sb.guards).toContain("read status=running");
  });
  it("prices from the server-derived trigger it is given", async () => {
    const sb = fakeSb({}, { run: { agent_slug: "engineer", payload: { stage: "scaffold" }, cron_dedupe_key: null } });
    await recordBilledCreditsForRun("r8", "t1", "a2a", sb as never);
    expect(sb.writes).toEqual([{ id: "r8", tenant: "t1", billed_credits: 1720 }]);
  });
  it("does not price a run that is no longer running", async () => {
    const sb = fakeSb({}, { run: null });
    await recordBilledCreditsForRun("r7", "t1", "cron", sb as never);
    expect(sb.writes).toEqual([]);
  });
  it("never throws when the run cannot be read", async () => {
    await expect(recordBilledCreditsForRun("r9", "t1", "cron", fakeSb({}, { failRunRead: true }) as never)).resolves.toBeUndefined();
  });
});

