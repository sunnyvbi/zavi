import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveEntityTractionMode,
  __resetEntityTractionFlagCache,
} from "../_entity-traction-flag-check";

function makeSb(opts: {
  blob?: Record<string, unknown>;
  error?: unknown;
  onCall?: () => void;
}) {
  const result = Promise.resolve({
    data: opts.error ? null : { blob: opts.blob ?? {} },
    error: opts.error ?? null,
  });
  const chain = {
    from() {
      opts.onCall?.();
      return chain;
    },
    select() {
      return chain;
    },
    eq() {
      return chain;
    },
    maybeSingle() {
      return result;
    },
  };
  return chain as unknown as Parameters<typeof resolveEntityTractionMode>[0];
}

describe("resolveEntityTractionMode — DB flag > env > off", () => {
  const ENV = "ENTITY_TRACTION_GUARD_MODE";
  let prevEnv: string | undefined;
  let clock = 1_000_000;

  beforeEach(() => {
    prevEnv = process.env[ENV];
    delete process.env[ENV];
    __resetEntityTractionFlagCache();
    clock += 100_000;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = prevEnv;
    __resetEntityTractionFlagCache();
  });

  it("uses the DB value when present (overrides env)", async () => {
    process.env[ENV] = "off";
    const sb = makeSb({ blob: { entity_traction_guard_mode: "hedge" } });
    expect(await resolveEntityTractionMode(sb, clock)).toBe("hedge");
  });

  it("falls back to env when the DB has no key", async () => {
    process.env[ENV] = "shadow";
    const sb = makeSb({ blob: {} });
    expect(await resolveEntityTractionMode(sb, clock)).toBe("shadow");
  });

  it("falls back to env when the DB value is garbage", async () => {
    process.env[ENV] = "shadow";
    const sb = makeSb({ blob: { entity_traction_guard_mode: "banana" } });
    expect(await resolveEntityTractionMode(sb, clock)).toBe("shadow");
  });

  it("defaults to off when neither DB nor env is set", async () => {
    const sb = makeSb({ blob: {} });
    expect(await resolveEntityTractionMode(sb, clock)).toBe("off");
  });

  it("keeps env fallback (does NOT arm) on a DB read error", async () => {
    process.env[ENV] = "off";
    const sb = makeSb({ error: { message: "system_config unreachable" } });
    expect(await resolveEntityTractionMode(sb, clock)).toBe("off");
  });

  it("caches within the TTL window (second call does not re-read)", async () => {
    let calls = 0;
    const sb = makeSb({
      blob: { entity_traction_guard_mode: "hedge" },
      onCall: () => {
        calls += 1;
      },
    });
    expect(await resolveEntityTractionMode(sb, clock)).toBe("hedge");
    expect(await resolveEntityTractionMode(sb, clock + 5_000)).toBe("hedge");
    expect(calls).toBe(1);
  });

  it("re-reads after the TTL expires", async () => {
    let calls = 0;
    const sb = makeSb({
      blob: { entity_traction_guard_mode: "hedge" },
      onCall: () => {
        calls += 1;
      },
    });
    expect(await resolveEntityTractionMode(sb, clock)).toBe("hedge");
    expect(await resolveEntityTractionMode(sb, clock + 60_000)).toBe("hedge");
    expect(calls).toBe(2);
  });
});
