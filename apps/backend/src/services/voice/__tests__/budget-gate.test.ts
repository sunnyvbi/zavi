
import { describe, it, expect, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  resolveTenantDailyCapMicros,
  sumTodayVoiceMicros,
  checkVoiceBudget,
  DEFAULT_DAILY_BUDGET_MICROS,
  DEFAULT_TURN_WORSTCASE_MICROS,
} from "../budget-gate";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function mockTenantsClient(result: {
  data?: { settings: unknown } | null;
  error?: unknown;
}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: result.data ?? null,
    error: result.error ?? null,
  });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { from } as unknown as SupabaseClient;
}

function mockCostsClient(result: {
  data?: Array<{
    stt_micros: string | number;
    tts_micros: string | number;
    llm_micros: string | number;
  }> | null;
  error?: unknown;
}) {
  const gte = vi.fn().mockResolvedValue({
    data: result.data ?? null,
    error: result.error ?? null,
  });
  const eq = vi.fn().mockReturnValue({ gte });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return {
    client: { from } as unknown as SupabaseClient,
    spies: { from, select, eq, gte },
  };
}

function mockComposedClient(opts: {
  capSettings?: { settings: unknown } | null;
  capError?: unknown;
  costRows?: Array<{
    stt_micros: string | number;
    tts_micros: string | number;
    llm_micros: string | number;
  }> | null;
  costError?: unknown;
}) {
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "tenants") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: opts.capSettings ?? null,
              error: opts.capError ?? null,
            }),
          }),
        }),
      };
    }
    if (table === "voice_session_costs") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            gte: vi.fn().mockResolvedValue({
              data: opts.costRows ?? [],
              error: opts.costError ?? null,
            }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return { from } as unknown as SupabaseClient;
}

afterEach(() => {
  delete process.env.PRAXIS_DAILY_VOICE_BUDGET_MICROS;
  delete process.env.PRAXIS_VOICE_TURN_WORSTCASE_MICROS;
  vi.restoreAllMocks();
});

describe("resolveTenantDailyCapMicros — cap precedence", () => {
  it("falls back to the hardcoded $25 default when no override and no env", async () => {
    const supa = mockTenantsClient({ data: { settings: {} } });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(DEFAULT_DAILY_BUDGET_MICROS);
  });

  it("uses the env PRAXIS_DAILY_VOICE_BUDGET_MICROS when set and no tenant override", async () => {
    process.env.PRAXIS_DAILY_VOICE_BUDGET_MICROS = "50000000";
    const supa = mockTenantsClient({ data: { settings: {} } });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(50_000_000n);
  });

  it("tenant override (string) WINS over env and default", async () => {
    process.env.PRAXIS_DAILY_VOICE_BUDGET_MICROS = "50000000";
    const supa = mockTenantsClient({
      data: { settings: { voice_budget_micros_daily: "10000000" } },
    });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(10_000_000n);
  });

  it("tenant override of 0 is honored (a tenant can be hard-capped to $0)", async () => {
    const supa = mockTenantsClient({
      data: { settings: { voice_budget_micros_daily: "0" } },
    });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(0n);
  });

  it("accepts a numeric override and floors it to integer micros", async () => {
    const supa = mockTenantsClient({
      data: { settings: { voice_budget_micros_daily: 12345678.9 } },
    });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(12_345_678n);
  });

  it("does NOT drift precision for very large overrides (bigint, past 2^53)", async () => {
    const big = "9007199254740993";
    const supa = mockTenantsClient({
      data: { settings: { voice_budget_micros_daily: big } },
    });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(9_007_199_254_740_993n);
    expect(cap.toString()).toBe(big);
  });

  it("falls through to env on an unparseable string override", async () => {
    process.env.PRAXIS_DAILY_VOICE_BUDGET_MICROS = "7000000";
    const supa = mockTenantsClient({
      data: { settings: { voice_budget_micros_daily: "not-a-number" } },
    });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(7_000_000n);
  });

  it("falls through to default on a negative string override", async () => {
    const supa = mockTenantsClient({
      data: { settings: { voice_budget_micros_daily: "-500" } },
    });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(DEFAULT_DAILY_BUDGET_MICROS);
  });

  it("ignores a negative env value and uses the default", async () => {
    process.env.PRAXIS_DAILY_VOICE_BUDGET_MICROS = "-1";
    const supa = mockTenantsClient({ data: { settings: {} } });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(DEFAULT_DAILY_BUDGET_MICROS);
  });

  it("returns env default when the tenants row is missing (no throw)", async () => {
    process.env.PRAXIS_DAILY_VOICE_BUDGET_MICROS = "3000000";
    const supa = mockTenantsClient({ data: null });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(3_000_000n);
  });

  it("returns env default when the tenants read errors (never throws)", async () => {
    const supa = mockTenantsClient({ error: { code: "PGRST500" } });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(DEFAULT_DAILY_BUDGET_MICROS);
  });

  it("returns env default when settings is null (no override key)", async () => {
    const supa = mockTenantsClient({ data: { settings: null } });
    const cap = await resolveTenantDailyCapMicros(supa, TENANT);
    expect(cap).toBe(DEFAULT_DAILY_BUDGET_MICROS);
  });
});

describe("sumTodayVoiceMicros — micros summation + UTC-midnight boundary", () => {
  it("sums stt + tts + llm across rows as bigint (no Number drift)", async () => {
    const { client } = mockCostsClient({
      data: [
        { stt_micros: "1000", tts_micros: "2000", llm_micros: "3000" },
        { stt_micros: 4000, tts_micros: 5000, llm_micros: 6000 },
      ],
    });
    const total = await sumTodayVoiceMicros(client, TENANT, "2026-05-22T12:00:00.000Z");
    expect(total).toBe(21_000n);
  });

  it("treats missing/undefined micros columns as 0", async () => {
    const { client } = mockCostsClient({
      data: [
        // @ts-expect-error — exercise the `?? 0` guard on absent columns
        { stt_micros: "500" },
      ],
    });
    const total = await sumTodayVoiceMicros(client, TENANT, "2026-05-22T12:00:00.000Z");
    expect(total).toBe(500n);
  });

  it("returns 0n on an empty ledger (the prod 'blind gate' state)", async () => {
    const { client } = mockCostsClient({ data: [] });
    const total = await sumTodayVoiceMicros(client, TENANT, "2026-05-22T12:00:00.000Z");
    expect(total).toBe(0n);
  });

  it("returns 0n when data is null", async () => {
    const { client } = mockCostsClient({ data: null });
    const total = await sumTodayVoiceMicros(client, TENANT, "2026-05-22T12:00:00.000Z");
    expect(total).toBe(0n);
  });

  it("queries created_at >= the UTC midnight of the supplied instant", async () => {
    const { client, spies } = mockCostsClient({ data: [] });
    await sumTodayVoiceMicros(client, TENANT, "2026-05-22T23:59:59.000Z");
    expect(spies.eq).toHaveBeenCalledWith("tenant_id", TENANT);
    expect(spies.gte).toHaveBeenCalledWith("created_at", "2026-05-22T00:00:00.000Z");
  });

  it("floors to the prior UTC day for an instant just after UTC midnight", async () => {
    const { client, spies } = mockCostsClient({ data: [] });
    await sumTodayVoiceMicros(client, TENANT, "2026-05-22T00:30:00.000Z");
    expect(spies.gte).toHaveBeenCalledWith("created_at", "2026-05-22T00:00:00.000Z");
  });

  it("uses UTC midnight even when the local wall-clock day differs", async () => {
    const { client, spies } = mockCostsClient({ data: [] });
    await sumTodayVoiceMicros(client, TENANT, "2026-05-22T03:00:00.000Z");
    expect(spies.gte).toHaveBeenCalledWith("created_at", "2026-05-22T00:00:00.000Z");
  });

  it("throws when the ledger read errors (caller must surface, not silently allow)", async () => {
    const { client } = mockCostsClient({ error: { code: "PGRST500" } });
    await expect(
      sumTodayVoiceMicros(client, TENANT, "2026-05-22T12:00:00.000Z"),
    ).rejects.toMatchObject({ code: "PGRST500" });
  });
});

describe("checkVoiceBudget — gate outcomes", () => {
  it("ALLOWS a turn when remaining >= worst-case", async () => {
    const supa = mockComposedClient({
      capSettings: { settings: {} },
      costRows: [{ stt_micros: "100000", tts_micros: "200000", llm_micros: "200000" }],
    });
    const out = await checkVoiceBudget(supa, TENANT);
    expect(out.allowed).toBe(true);
    expect(out.capMicros).toBe(DEFAULT_DAILY_BUDGET_MICROS);
    expect(out.remainingTodayMicros).toBe(24_500_000n);
    expect(out.reason).toBeUndefined();
  });

  it("refuses with cap_exhausted when spend already EQUALS the cap (remaining 0)", async () => {
    const supa = mockComposedClient({
      capSettings: { settings: { voice_budget_micros_daily: "1000000" } },
      costRows: [{ stt_micros: "400000", tts_micros: "300000", llm_micros: "300000" }],
    });
    const out = await checkVoiceBudget(supa, TENANT);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("cap_exhausted");
    expect(out.remainingTodayMicros).toBe(0n);
    expect(out.capMicros).toBe(1_000_000n);
  });

  it("refuses with cap_exhausted AND clamps remaining to 0 when overspent", async () => {
    const supa = mockComposedClient({
      capSettings: { settings: { voice_budget_micros_daily: "1000000" } },
      costRows: [{ stt_micros: "500000", tts_micros: "500000", llm_micros: "500000" }],
    });
    const out = await checkVoiceBudget(supa, TENANT);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("cap_exhausted");
    expect(out.remainingTodayMicros).toBe(0n);
  });

  it("refuses with worst_case_too_close when budget remains but < one worst-case turn", async () => {
    const supa = mockComposedClient({
      capSettings: { settings: { voice_budget_micros_daily: "1000000" } },
      costRows: [{ stt_micros: "300000", tts_micros: "300000", llm_micros: "200000" }],
    });
    const out = await checkVoiceBudget(supa, TENANT);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("worst_case_too_close");
    expect(out.remainingTodayMicros).toBe(200_000n);
  });

  it("ALLOWS at the exact worst-case boundary (remaining == worst_case)", async () => {
    const supa = mockComposedClient({
      capSettings: { settings: { voice_budget_micros_daily: "1000000" } },
      costRows: [{ stt_micros: "300000", tts_micros: "300000", llm_micros: "50000" }],
    });
    const out = await checkVoiceBudget(supa, TENANT);
    expect(out.allowed).toBe(true);
    expect(out.remainingTodayMicros).toBe(DEFAULT_TURN_WORSTCASE_MICROS);
  });

  it("respects a custom worst-case argument over the env default", async () => {
    const supa = mockComposedClient({
      capSettings: { settings: {} },
      costRows: [],
    });
    const out = await checkVoiceBudget(supa, TENANT, 30_000_000n);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("worst_case_too_close");
    expect(out.remainingTodayMicros).toBe(DEFAULT_DAILY_BUDGET_MICROS);
  });

  it("honors the env PRAXIS_VOICE_TURN_WORSTCASE_MICROS default arg", async () => {
    process.env.PRAXIS_VOICE_TURN_WORSTCASE_MICROS = "1000000";
    const supa = mockComposedClient({
      capSettings: { settings: {} },
      costRows: [{ stt_micros: "24500000", tts_micros: "0", llm_micros: "0" }],
    });
    const out = await checkVoiceBudget(supa, TENANT);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("worst_case_too_close");
    expect(out.remainingTodayMicros).toBe(500_000n);
  });

  it("a $0-capped tenant is immediately cap_exhausted even with zero spend", async () => {
    const supa = mockComposedClient({
      capSettings: { settings: { voice_budget_micros_daily: "0" } },
      costRows: [],
    });
    const out = await checkVoiceBudget(supa, TENANT);
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("cap_exhausted");
    expect(out.capMicros).toBe(0n);
  });
});
