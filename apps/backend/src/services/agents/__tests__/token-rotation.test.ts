
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  nextStartOffset,
  orderAttemptTokens,
  markTokenCooldown,
  isTokenCooling,
  tokenCooldownMs,
  resolveAttemptTokens,
  resolveOAuthTokenPool,
  _resetTokenRotationForTest,
} from "../agent-auth";
import { _setOAuthTokenPoolOverrideForTest } from "../oauth-token-source";

beforeEach(() => {
  _resetTokenRotationForTest();
  _setOAuthTokenPoolOverrideForTest([]);
});

describe("nextStartOffset — round-robin spread", () => {
  it("cycles 0,1,2,0,1,2 for a 3-token pool", () => {
    expect([0, 0, 0, 0, 0, 0].map(() => nextStartOffset(3))).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it("uses all 3 tokens equally over 300 runs (±0)", () => {
    const pool = ["oat-a", "oat-b", "oat-c"];
    const counts = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const first = orderAttemptTokens({ pool, startOffset: nextStartOffset(pool.length) })[0];
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual([100, 100, 100]);
  });

  it("degenerate pools never rotate (0 or 1 token → offset 0)", () => {
    expect(nextStartOffset(0)).toBe(0);
    expect(nextStartOffset(1)).toBe(0);
    expect(nextStartOffset(1)).toBe(0);
  });
});

describe("orderAttemptTokens — rotation + cooldown ordering", () => {
  const pool = ["oat-a", "oat-b", "oat-c"];

  it("rotates to start at the offset, keeping the rest as failover order", () => {
    expect(orderAttemptTokens({ pool, startOffset: 1 })).toEqual(["oat-b", "oat-c", "oat-a"]);
    expect(orderAttemptTokens({ pool, startOffset: 2 })).toEqual(["oat-c", "oat-a", "oat-b"]);
  });

  it("offset 0 with no cooldowns is byte-identical to the legacy order", () => {
    expect(orderAttemptTokens({ pool, startOffset: 0 })).toEqual(pool);
  });

  it("normalizes an out-of-range or negative offset", () => {
    expect(orderAttemptTokens({ pool, startOffset: 4 })).toEqual(["oat-b", "oat-c", "oat-a"]);
    expect(orderAttemptTokens({ pool, startOffset: -1 })).toEqual(["oat-c", "oat-a", "oat-b"]);
  });

  it("pushes a cooling token to the BACK but never drops it", () => {
    const now = 1_000_000;
    markTokenCooldown("oat-a", now, 60_000);
    expect(orderAttemptTokens({ pool, startOffset: 0, now })).toEqual([
      "oat-b",
      "oat-c",
      "oat-a",
    ]);
  });

  it("all-cooling → still returns every token (dispatch is never refused)", () => {
    const now = 1_000_000;
    for (const t of pool) markTokenCooldown(t, now, 60_000);
    expect(orderAttemptTokens({ pool, startOffset: 0, now }).sort()).toEqual([...pool].sort());
  });

  it("cooldown expires on its own clock", () => {
    const now = 1_000_000;
    markTokenCooldown("oat-a", now, 60_000);
    expect(isTokenCooling("oat-a", now + 59_000)).toBe(true);
    expect(isTokenCooling("oat-a", now + 61_000)).toBe(false);
    expect(orderAttemptTokens({ pool, startOffset: 0, now: now + 61_000 })).toEqual(pool);
  });

  it("marking an undefined token is a no-op (api_key / none paths)", () => {
    expect(() => markTokenCooldown(undefined)).not.toThrow();
  });
});

describe("tokenCooldownMs", () => {
  it("defaults to 20 minutes", () => {
    expect(tokenCooldownMs({} as NodeJS.ProcessEnv)).toBe(20 * 60_000);
  });
  it("honors PRAXIS_OAUTH_TOKEN_COOLDOWN_MS, ignoring garbage", () => {
    expect(tokenCooldownMs({ PRAXIS_OAUTH_TOKEN_COOLDOWN_MS: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
    expect(tokenCooldownMs({ PRAXIS_OAUTH_TOKEN_COOLDOWN_MS: "nope" } as NodeJS.ProcessEnv)).toBe(20 * 60_000);
    expect(tokenCooldownMs({ PRAXIS_OAUTH_TOKEN_COOLDOWN_MS: "-1" } as NodeJS.ProcessEnv)).toBe(20 * 60_000);
  });
});

describe("resolveAttemptTokens — offset threaded through", () => {
  it("oauth mode + 3 tokens + offset 1 → rotated full pool", () => {
    expect(
      resolveAttemptTokens({
        pool: ["oat-1", "oat-2", "oat-3"],
        apiKey: undefined,
        preferApiKey: false,
        startOffset: 1,
      }),
    ).toEqual(["oat-2", "oat-3", "oat-1"]);
  });

  it("api_key mode ignores the offset (token unused → single attempt)", () => {
    expect(
      resolveAttemptTokens({
        pool: ["oat-1", "oat-2", "oat-3"],
        apiKey: "sk-ant-xyz",
        preferApiKey: true,
        startOffset: 2,
      }),
    ).toEqual(["oat-1"]);
  });
});

describe("resolveOAuthTokenPool — DB override beats env (no-deploy rotation)", () => {
  const env = {
    CLAUDE_CODE_OAUTH_TOKENS: "env-1,env-2",
  } as unknown as NodeJS.ProcessEnv;

  it("no override stored → env, byte-identical to before", () => {
    expect(resolveOAuthTokenPool(env)).toEqual(["env-1", "env-2"]);
  });

  it("override stored → DB tokens win", () => {
    _setOAuthTokenPoolOverrideForTest(["db-1", "db-2", "db-3"]);
    expect(resolveOAuthTokenPool(env)).toEqual(["db-1", "db-2", "db-3"]);
  });

  it("cleared override → falls back to env (reversible)", () => {
    _setOAuthTokenPoolOverrideForTest(["db-1"]);
    expect(resolveOAuthTokenPool(env)).toEqual(["db-1"]);
    _setOAuthTokenPoolOverrideForTest([]);
    expect(resolveOAuthTokenPool(env)).toEqual(["env-1", "env-2"]);
  });

  it("empty env + no override → empty pool (api_key / none paths unchanged)", () => {
    expect(resolveOAuthTokenPool({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("oauth-token-source — refresh cache semantics", () => {
  it("keeps the last-known-good pool when the settings read throws (fail-open)", async () => {
    vi.resetModules();
    vi.doMock("@/services/settings", () => ({
      getAppSetting: vi.fn().mockRejectedValue(new Error("db down")),
    }));
    const mod = await import("../oauth-token-source");
    mod._setOAuthTokenPoolOverrideForTest(["good-1"]);
    await mod.refreshOAuthTokenPoolOverride();
    expect(mod.getOAuthTokenPoolOverride()).toEqual(["good-1"]);
    vi.doUnmock("@/services/settings");
    vi.resetModules();
  });

  it("parses a comma+space separated stored value", async () => {
    vi.resetModules();
    vi.doMock("@/services/settings", () => ({
      getAppSetting: vi.fn().mockResolvedValue(" oat-a , oat-b ,, oat-c "),
    }));
    const mod = await import("../oauth-token-source");
    await mod.refreshOAuthTokenPoolOverride();
    expect(mod.getOAuthTokenPoolOverride()).toEqual(["oat-a", "oat-b", "oat-c"]);
    vi.doUnmock("@/services/settings");
    vi.resetModules();
  });

  it("a non-string stored value yields no override", async () => {
    vi.resetModules();
    vi.doMock("@/services/settings", () => ({
      getAppSetting: vi.fn().mockResolvedValue(42),
    }));
    const mod = await import("../oauth-token-source");
    await mod.refreshOAuthTokenPoolOverride();
    expect(mod.getOAuthTokenPoolOverride()).toEqual([]);
    vi.doUnmock("@/services/settings");
    vi.resetModules();
  });
});

describe("planUsageLimitRetry — durable chat can switch seats without its session", () => {
  const CAP = "You've hit your limit · resets 12am (UTC)";
  const base = { hasMoreTokens: true, attemptDirty: false, aborted: false, resultText: CAP };

  it("a clean capped attempt with no durable store rotates normally", async () => {
    const { planUsageLimitRetry } = await import("../agent-auth");
    expect(planUsageLimitRetry({ ...base, durableAttached: false })).toBe("rotate");
  });

  it("a clean capped attempt WITH a durable store rotates by dropping the store (it used to never rotate)", async () => {
    const { planUsageLimitRetry } = await import("../agent-auth");
    expect(planUsageLimitRetry({ ...base, durableAttached: true })).toBe("rotate_without_durable");
  });

  it("never retries once a side effect landed, when aborted, with no seat left, or for a non-cap error", async () => {
    const { planUsageLimitRetry } = await import("../agent-auth");
    expect(planUsageLimitRetry({ ...base, durableAttached: true, attemptDirty: true })).toBe("none");
    expect(planUsageLimitRetry({ ...base, durableAttached: true, aborted: true })).toBe("none");
    expect(planUsageLimitRetry({ ...base, durableAttached: true, hasMoreTokens: false })).toBe("none");
    expect(planUsageLimitRetry({ ...base, durableAttached: true, resultText: "socket hang up" })).toBe("none");
  });
});
