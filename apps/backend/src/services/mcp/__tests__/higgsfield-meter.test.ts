import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: mocks.rpc }),
}));

import {
  isMeteredWriteTool,
  resolveMediaDailyCap,
  DEFAULT_MEDIA_DAILY_CAP,
  buildIdempotencyKey,
  consumeHiggsfieldGenerateOrReject,
  meterPlatformGeneration,
  utcDay,
} from "../higgsfield-meter";

beforeEach(() => {
  mocks.rpc.mockReset();
});

describe("isMeteredWriteTool", () => {
  it("only Higgsfield generate_* are metered", () => {
    expect(isMeteredWriteTool("higgsfield", "generate_video")).toBe(true);
    expect(isMeteredWriteTool("higgsfield", "generate_image")).toBe(true);
    expect(isMeteredWriteTool("higgsfield", "balance")).toBe(false);
    expect(isMeteredWriteTool("composio", "generate_video")).toBe(false);
  });
});

describe("resolveMediaDailyCap", () => {
  const prev = process.env.MEDIA_DAILY_GENERATE_CAP;
  afterEach(() => {
    if (prev === undefined) delete process.env.MEDIA_DAILY_GENERATE_CAP;
    else process.env.MEDIA_DAILY_GENERATE_CAP = prev;
  });
  it("unset still caps every tenant at the built-in default, never unlimited", () => {
    delete process.env.MEDIA_DAILY_GENERATE_CAP;
    delete process.env.HIGGSFIELD_DAILY_GENERATE_CAP;
    expect(resolveMediaDailyCap()).toBe(DEFAULT_MEDIA_DAILY_CAP);
    process.env.MEDIA_DAILY_GENERATE_CAP = "";
    expect(resolveMediaDailyCap()).toBe(DEFAULT_MEDIA_DAILY_CAP);
  });
  it("parses a positive integer", () => {
    process.env.MEDIA_DAILY_GENERATE_CAP = "10";
    expect(resolveMediaDailyCap()).toBe(10);
  });
  it("an explicit 0 turns the cap off, from either env name", () => {
    const prevOld = process.env.HIGGSFIELD_DAILY_GENERATE_CAP;
    try {
      delete process.env.HIGGSFIELD_DAILY_GENERATE_CAP;
      for (const v of ["0", " 0 ", "0.0"]) {
        process.env.MEDIA_DAILY_GENERATE_CAP = v;
        expect(resolveMediaDailyCap()).toBe(0);
      }
      delete process.env.MEDIA_DAILY_GENERATE_CAP;
      process.env.HIGGSFIELD_DAILY_GENERATE_CAP = "0";
      expect(resolveMediaDailyCap()).toBe(0);
      process.env.MEDIA_DAILY_GENERATE_CAP = "5";
      expect(resolveMediaDailyCap()).toBe(5);
    } finally {
      if (prevOld === undefined) delete process.env.HIGGSFIELD_DAILY_GENERATE_CAP;
      else process.env.HIGGSFIELD_DAILY_GENERATE_CAP = prevOld;
    }
  });
  it("junk or negative cannot switch the cap off: it falls back to the default", () => {
    for (const v of ["abc", "-3", "0.5", "Infinity", "NaN", "   "]) {
      process.env.MEDIA_DAILY_GENERATE_CAP = v;
      expect(resolveMediaDailyCap()).toBe(DEFAULT_MEDIA_DAILY_CAP);
    }
    process.env.MEDIA_DAILY_GENERATE_CAP = "2.9";
    expect(resolveMediaDailyCap()).toBe(2);
  });
  it("still reads the OLD env name, and the new one wins when both are set", () => {
    const prevOld = process.env.HIGGSFIELD_DAILY_GENERATE_CAP;
    try {
      delete process.env.MEDIA_DAILY_GENERATE_CAP;
      process.env.HIGGSFIELD_DAILY_GENERATE_CAP = "42";
      expect(resolveMediaDailyCap()).toBe(42);
      process.env.MEDIA_DAILY_GENERATE_CAP = "7";
      expect(resolveMediaDailyCap()).toBe(7);
    } finally {
      if (prevOld === undefined) delete process.env.HIGGSFIELD_DAILY_GENERATE_CAP;
      else process.env.HIGGSFIELD_DAILY_GENERATE_CAP = prevOld;
    }
  });
});

describe("buildIdempotencyKey", () => {
  it("is run_id:tool_use_id when both present (stable across retries)", () => {
    expect(buildIdempotencyKey("run-1", "toolu_abc")).toBe("run-1:toolu_abc");
  });
  it("falls back to a unique key when ids missing (still single-use)", () => {
    const a = buildIdempotencyKey(undefined, undefined);
    const b = buildIdempotencyKey(undefined, undefined);
    expect(a).not.toBe(b);
    expect(a.startsWith("nokey:")).toBe(true);
  });
});

describe("utcDay", () => {
  it("returns YYYY-MM-DD", () => {
    expect(utcDay(new Date("2026-05-24T23:59:59Z"))).toBe("2026-05-24");
  });
});

describe("consumeHiggsfieldGenerateOrReject", () => {
  it("returns 'charged' on first call under cap + passes the key through", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "charged", error: null });
    const r = await consumeHiggsfieldGenerateOrReject({
      tenant_id: "tnt-1",
      idempotency_key: "run-1:toolu_x",
      dailyCap: 10,
      day: "2026-05-24",
    });
    expect(r).toBe("charged");
    expect(mocks.rpc).toHaveBeenCalledWith("consume_higgsfield_generate_or_reject", {
      p_tenant_id: "tnt-1",
      p_day: "2026-05-24",
      p_idempotency_key: "run-1:toolu_x",
      p_daily_cap: 10,
    });
  });

  it("returns 'already' on a replay (idempotent retry)", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "already", error: null });
    expect(
      await consumeHiggsfieldGenerateOrReject({ tenant_id: "t", idempotency_key: "k", dailyCap: 10 }),
    ).toBe("already");
  });

  it("returns 'over_cap' when the daily cap is full", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "over_cap", error: null });
    expect(
      await consumeHiggsfieldGenerateOrReject({ tenant_id: "t", idempotency_key: "k", dailyCap: 1 }),
    ).toBe("over_cap");
  });

  it("FAILS CLOSED (throws) on an RPC error — never silently spend", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    await expect(
      consumeHiggsfieldGenerateOrReject({ tenant_id: "t", idempotency_key: "k", dailyCap: 10 }),
    ).rejects.toThrow(/consume_higgsfield_generate_or_reject failed/);
  });
});

describe("meterPlatformGeneration", () => {
  const prevCap = process.env.MEDIA_DAILY_GENERATE_CAP;
  afterEach(() => {
    if (prevCap === undefined) delete process.env.MEDIA_DAILY_GENERATE_CAP;
    else process.env.MEDIA_DAILY_GENERATE_CAP = prevCap;
  });

  it("keys per ASSET — `<run_id>:<surface>:<index>` (4 images in one run = 4 distinct keys)", async () => {
    mocks.rpc.mockResolvedValue({ data: "charged", error: null });
    const keys: string[] = [];
    for (let i = 0; i < 4; i++) {
      const g = await meterPlatformGeneration({ tenant_id: "t", run_id: "run-1", surface: "pdf-image", index: i });
      keys.push(g.idempotency_key);
    }
    expect(keys).toEqual([
      "run-1:pdf-image:0",
      "run-1:pdf-image:1",
      "run-1:pdf-image:2",
      "run-1:pdf-image:3",
    ]);
    expect(new Set(keys).size).toBe(4);
  });

  it("with the cap setting unset, the 101st generation of the day for one tenant is refused", async () => {
    delete process.env.MEDIA_DAILY_GENERATE_CAP;
    delete process.env.HIGGSFIELD_DAILY_GENERATE_CAP;
    expect(DEFAULT_MEDIA_DAILY_CAP).toBe(100);
    let used = 0;
    mocks.rpc.mockImplementation(async (_fn: string, a: { p_daily_cap: number }) => {
      if (a.p_daily_cap > 0 && used >= a.p_daily_cap) return { data: "over_cap", error: null };
      used++;
      return { data: "charged", error: null };
    });
    const out: string[] = [];
    for (let i = 0; i < 101; i++) out.push((await meterPlatformGeneration({ tenant_id: "t", run_id: "r", surface: "gen-video", index: i })).decision);
    expect(out.filter((d) => d === "charged")).toHaveLength(100);
    expect(out[100]).toBe("over_cap");
    expect(mocks.rpc).toHaveBeenLastCalledWith("consume_higgsfield_generate_or_reject", expect.objectContaining({ p_daily_cap: 100, p_idempotency_key: "r:gen-video:100" }));
  });

  it("with the cap set to 0, the 101st generation of the day still goes through and the RPC is told there is no cap", async () => {
    process.env.MEDIA_DAILY_GENERATE_CAP = "0";
    let used = 0;
    mocks.rpc.mockImplementation(async (_fn: string, a: { p_daily_cap: number }) => {
      if (a.p_daily_cap > 0 && used >= a.p_daily_cap) return { data: "over_cap", error: null };
      used++;
      return { data: "charged", error: null };
    });
    const out: string[] = [];
    for (let i = 0; i < 101; i++) out.push((await meterPlatformGeneration({ tenant_id: "t", run_id: "r", surface: "gen-video", index: i })).decision);
    expect(out.every((d) => d === "charged")).toBe(true);
    expect(mocks.rpc).toHaveBeenLastCalledWith("consume_higgsfield_generate_or_reject", expect.objectContaining({ p_daily_cap: 0 }));
  });

  it("with a cap CONFIGURED (100) the cap value is passed through and over_cap is surfaced", async () => {
    process.env.MEDIA_DAILY_GENERATE_CAP = "100";
    mocks.rpc.mockResolvedValue({ data: "over_cap", error: null });
    const g = await meterPlatformGeneration({ tenant_id: "t", run_id: "r", surface: "pdf-image", index: 7 });
    expect(g.decision).toBe("over_cap");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "consume_higgsfield_generate_or_reject",
      expect.objectContaining({ p_daily_cap: 100 }),
    );
  });

  it("a replayed key returns 'already' (the retry double-spend guard)", async () => {
    mocks.rpc.mockResolvedValue({ data: "already", error: null });
    const g = await meterPlatformGeneration({ tenant_id: "t", run_id: "r", surface: "pdf-image", index: 2 });
    expect(g.decision).toBe("already");
  });

  it("FAILS CLOSED on an RPC error — returns meter_error (never throws, never 'charged')", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    const g = await meterPlatformGeneration({ tenant_id: "t", run_id: "r", surface: "lv-image", index: "0:hero" });
    expect(g.decision).toBe("meter_error");
    expect(g.error).toMatch(/db down/);
  });

  it("FAILS CLOSED when tenant_id or run_id is missing — the RPC is not even attempted", async () => {
    for (const args of [
      { tenant_id: undefined, run_id: "r" },
      { tenant_id: "t", run_id: undefined },
    ] as const) {
      mocks.rpc.mockReset();
      const g = await meterPlatformGeneration({ ...args, surface: "pdf-image", index: 0 });
      expect(g.decision).toBe("meter_error");
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  });
});
