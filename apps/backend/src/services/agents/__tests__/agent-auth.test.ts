import { describe, it, expect } from "vitest";
import {
  resolveAgentAuthMode,
  buildAgentChildEnv,
  preferApiKeyFromEnv,
  preferApiKeyForProductBuilderCodegen,
  resolveOAuthTokenPool,
  resolveAttemptTokens,
  shouldRotateOnUsageLimit,
} from "../agent-auth";

describe("resolveAgentAuthMode — June-15 billing switch", () => {
  it("(a) flag unset + both creds → oauth", () => {
    expect(
      resolveAgentAuthMode({
        oauthToken: "oat-abc",
        apiKey: "sk-ant-xyz",
        preferApiKey: false,
      }),
    ).toBe("oauth");
  });

  it("(b) flag=api_key + both → api_key", () => {
    expect(
      resolveAgentAuthMode({
        oauthToken: "oat-abc",
        apiKey: "sk-ant-xyz",
        preferApiKey: true,
      }),
    ).toBe("api_key");
  });

  it("(c) flag=api_key + only oauth → oauth (graceful fallback)", () => {
    expect(
      resolveAgentAuthMode({
        oauthToken: "oat-abc",
        apiKey: undefined,
        preferApiKey: true,
      }),
    ).toBe("oauth");
  });

  it("(d) flag=api_key + neither → none", () => {
    expect(
      resolveAgentAuthMode({
        oauthToken: undefined,
        apiKey: undefined,
        preferApiKey: true,
      }),
    ).toBe("none");
  });

  it("(e) flag unset + only api_key → api_key", () => {
    expect(
      resolveAgentAuthMode({
        oauthToken: undefined,
        apiKey: "sk-ant-xyz",
        preferApiKey: false,
      }),
    ).toBe("api_key");
  });

  it("flag unset + neither → none", () => {
    expect(
      resolveAgentAuthMode({
        oauthToken: undefined,
        apiKey: undefined,
        preferApiKey: false,
      }),
    ).toBe("none");
  });

  it("treats whitespace-only creds as absent", () => {
    expect(
      resolveAgentAuthMode({
        oauthToken: "   ",
        apiKey: "sk-ant-xyz",
        preferApiKey: false,
      }),
    ).toBe("api_key");
  });
});

describe("preferApiKeyFromEnv", () => {
  it("true only for exact api_key (case/trim-insensitive)", () => {
    expect(preferApiKeyFromEnv({ PRAXIS_AGENT_AUTH_MODE: "api_key" })).toBe(true);
    expect(preferApiKeyFromEnv({ PRAXIS_AGENT_AUTH_MODE: " API_KEY " })).toBe(true);
  });
  it("false for unset / empty / oauth / garbage", () => {
    expect(preferApiKeyFromEnv({})).toBe(false);
    expect(preferApiKeyFromEnv({ PRAXIS_AGENT_AUTH_MODE: "" })).toBe(false);
    expect(preferApiKeyFromEnv({ PRAXIS_AGENT_AUTH_MODE: "oauth" })).toBe(false);
    expect(preferApiKeyFromEnv({ PRAXIS_AGENT_AUTH_MODE: "yes" })).toBe(false);
  });
});

describe("buildAgentChildEnv — per-call env for the spawned binary", () => {
  it("api_key mode: sets ANTHROPIC_API_KEY, deletes OAuth token", () => {
    const env = buildAgentChildEnv({
      mode: "api_key",
      oauthToken: "oat-abc",
      apiKey: "sk-ant-xyz",
      baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: "oat-abc", FOO: "bar" },
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xyz");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.FOO).toBe("bar");
  });

  it("oauth mode: sets OAuth token, deletes ANTHROPIC_API_KEY", () => {
    const env = buildAgentChildEnv({
      mode: "oauth",
      oauthToken: "oat-abc",
      apiKey: "sk-ant-xyz",
      baseEnv: { ANTHROPIC_API_KEY: "sk-ant-xyz", FOO: "bar" },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-abc");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.FOO).toBe("bar");
  });

  it("none mode: passes baseEnv through unchanged", () => {
    const base = { ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", FOO: "bar" };
    const env = buildAgentChildEnv({ mode: "none", baseEnv: base });
    expect(env.ANTHROPIC_API_KEY).toBe("k");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
    expect(env.FOO).toBe("bar");
  });

  it("oauth mode: strips the CLAUDE_CODE_OAUTH_TOKENS pool, exposes only the active token", () => {
    const env = buildAgentChildEnv({
      mode: "oauth",
      oauthToken: "oat-2",
      apiKey: undefined,
      baseEnv: {
        CLAUDE_CODE_OAUTH_TOKENS: "oat-1,oat-2,oat-3",
        CLAUDE_CODE_OAUTH_TOKEN: "oat-1",
        FOO: "bar",
      },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKENS).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-2");
    expect(env.FOO).toBe("bar");
  });

  it("api_key mode: also strips the CLAUDE_CODE_OAUTH_TOKENS pool", () => {
    const env = buildAgentChildEnv({
      mode: "api_key",
      oauthToken: "oat-1",
      apiKey: "sk-ant-xyz",
      baseEnv: { CLAUDE_CODE_OAUTH_TOKENS: "oat-1,oat-2" },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKENS).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xyz");
  });
});

describe("resolveOAuthTokenPool — comma-pool with single-token fallback", () => {
  it("plural CLAUDE_CODE_OAUTH_TOKENS wins, trims, drops empties", () => {
    expect(
      resolveOAuthTokenPool({
        CLAUDE_CODE_OAUTH_TOKENS: " oat-1 , oat-2 ,, oat-3 ",
        CLAUDE_CODE_OAUTH_TOKEN: "ignored",
      }),
    ).toEqual(["oat-1", "oat-2", "oat-3"]);
  });

  it("falls back to the single CLAUDE_CODE_OAUTH_TOKEN when plural unset", () => {
    expect(
      resolveOAuthTokenPool({ CLAUDE_CODE_OAUTH_TOKEN: "oat-solo" }),
    ).toEqual(["oat-solo"]);
  });

  it("splits a comma-list placed in the SINGULAR var too (the footgun that 401'd the fleet)", () => {
    expect(
      resolveOAuthTokenPool({ CLAUDE_CODE_OAUTH_TOKEN: " oat-1 , oat-2 ,, oat-3 , oat-4 " }),
    ).toEqual(["oat-1", "oat-2", "oat-3", "oat-4"]);
  });

  it("plural present but all-empty → falls back to single", () => {
    expect(
      resolveOAuthTokenPool({
        CLAUDE_CODE_OAUTH_TOKENS: " , , ",
        CLAUDE_CODE_OAUTH_TOKEN: "oat-solo",
      }),
    ).toEqual(["oat-solo"]);
  });

  it("empty array when neither var is set", () => {
    expect(resolveOAuthTokenPool({})).toEqual([]);
  });
});

describe("resolveAttemptTokens — rotation list (oauth mode + ≥2 tokens only)", () => {
  it("oauth mode + ≥2 tokens → full pool rotates", () => {
    expect(
      resolveAttemptTokens({
        pool: ["oat-1", "oat-2", "oat-3"],
        apiKey: undefined,
        preferApiKey: false,
      }),
    ).toEqual(["oat-1", "oat-2", "oat-3"]);
  });

  it("oauth mode + single token → single attempt (today's behavior)", () => {
    expect(
      resolveAttemptTokens({ pool: ["oat-1"], apiKey: undefined, preferApiKey: false }),
    ).toEqual(["oat-1"]);
  });

  it("empty pool → single undefined attempt (preserves api_key / none paths)", () => {
    expect(
      resolveAttemptTokens({ pool: [], apiKey: "sk-ant", preferApiKey: false }),
    ).toEqual([undefined]);
  });

  it("api_key mode (real key) → single attempt, NO rotation even with N tokens", () => {
    expect(
      resolveAttemptTokens({
        pool: ["oat-1", "oat-2"],
        apiKey: "sk-ant-xyz",
        preferApiKey: true,
      }),
    ).toEqual(["oat-1"]);
  });

  it("api_key flag but NO api key (degrade-to-oauth) → STILL rotates", () => {
    expect(
      resolveAttemptTokens({
        pool: ["oat-1", "oat-2"],
        apiKey: undefined,
        preferApiKey: true,
      }),
    ).toEqual(["oat-1", "oat-2"]);
  });
});

describe("shouldRotateOnUsageLimit — clean-attempt rotation gate", () => {
  const LIMIT = "You've hit your limit · resets Jun 13, 12am (UTC)";

  it("rotates: usage-limit + clean + token left + not aborted", () => {
    expect(
      shouldRotateOnUsageLimit({
        hasMoreTokens: true,
        attemptDirty: false,
        aborted: false,
        resultText: LIMIT,
      }),
    ).toBe(true);
  });

  it("does NOT rotate when the attempt already produced a side effect (dirty)", () => {
    expect(
      shouldRotateOnUsageLimit({
        hasMoreTokens: true,
        attemptDirty: true,
        aborted: false,
        resultText: LIMIT,
      }),
    ).toBe(false);
  });

  it("does NOT rotate on the last token (no more tokens)", () => {
    expect(
      shouldRotateOnUsageLimit({
        hasMoreTokens: false,
        attemptDirty: false,
        aborted: false,
        resultText: LIMIT,
      }),
    ).toBe(false);
  });

  it("does NOT rotate when the controller is already aborted", () => {
    expect(
      shouldRotateOnUsageLimit({
        hasMoreTokens: true,
        attemptDirty: false,
        aborted: true,
        resultText: LIMIT,
      }),
    ).toBe(false);
  });

  it("does NOT rotate on a non-usage-limit error (e.g. a normal failure)", () => {
    expect(
      shouldRotateOnUsageLimit({
        hasMoreTokens: true,
        attemptDirty: false,
        aborted: false,
        resultText: "Some unrelated tool error",
      }),
    ).toBe(false);
  });

  it("does NOT rotate on null/empty result text", () => {
    expect(
      shouldRotateOnUsageLimit({
        hasMoreTokens: true,
        attemptDirty: false,
        aborted: false,
        resultText: null,
      }),
    ).toBe(false);
  });
});

describe("buildAgentChildEnv — input not mutated", () => {
  it("does NOT mutate the input baseEnv (no shared-env race)", () => {
    const base = { CLAUDE_CODE_OAUTH_TOKEN: "oat-abc", ANTHROPIC_API_KEY: "sk-ant-xyz" };
    buildAgentChildEnv({
      mode: "api_key",
      oauthToken: "oat-abc",
      apiKey: "sk-ant-xyz",
      baseEnv: base,
    });
    expect(base.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-abc");
    expect(base.ANTHROPIC_API_KEY).toBe("sk-ant-xyz");
  });
});

describe("preferApiKeyForProductBuilderCodegen — codegen prefers API key when present", () => {
  it("codegen + ANTHROPIC_API_KEY present → true (prefer API key)", () => {
    expect(
      preferApiKeyForProductBuilderCodegen({
        isProductBuilderCodegen: true,
        apiKey: "sk-ant-xyz",
        env: {},
      }),
    ).toBe(true);
  });

  it("codegen + NO api key → false (graceful fallback to oauth, no hard break)", () => {
    expect(
      preferApiKeyForProductBuilderCodegen({
        isProductBuilderCodegen: true,
        apiKey: undefined,
        env: {},
      }),
    ).toBe(false);
    expect(
      preferApiKeyForProductBuilderCodegen({
        isProductBuilderCodegen: true,
        apiKey: "   ",
        env: {},
      }),
    ).toBe(false);
  });

  it("non-codegen run + api key present → false (only codegen is rerouted)", () => {
    expect(
      preferApiKeyForProductBuilderCodegen({
        isProductBuilderCodegen: false,
        apiKey: "sk-ant-xyz",
        env: {},
      }),
    ).toBe(false);
  });

  it("global PRAXIS_AGENT_AUTH_MODE=api_key → true for any run", () => {
    expect(
      preferApiKeyForProductBuilderCodegen({
        isProductBuilderCodegen: false,
        apiKey: undefined,
        env: { PRAXIS_AGENT_AUTH_MODE: "api_key" },
      }),
    ).toBe(true);
  });

  it("PRAXIS_BUILDER_AUTH_MODE=oauth pins codegen to oauth even with a key", () => {
    expect(
      preferApiKeyForProductBuilderCodegen({
        isProductBuilderCodegen: true,
        apiKey: "sk-ant-xyz",
        env: { PRAXIS_BUILDER_AUTH_MODE: "oauth" },
      }),
    ).toBe(false);
  });

  it("global api_key flag beats the builder oauth pin → true", () => {
    expect(
      preferApiKeyForProductBuilderCodegen({
        isProductBuilderCodegen: true,
        apiKey: "sk-ant-xyz",
        env: {
          PRAXIS_AGENT_AUTH_MODE: "api_key",
          PRAXIS_BUILDER_AUTH_MODE: "oauth",
        },
      }),
    ).toBe(true);
  });

  it("composes with resolveAgentAuthMode: key→api_key, no-key→oauth", () => {
    expect(
      resolveAgentAuthMode({
        oauthToken: "oat-abc",
        apiKey: "sk-ant-xyz",
        preferApiKey: preferApiKeyForProductBuilderCodegen({
          isProductBuilderCodegen: true,
          apiKey: "sk-ant-xyz",
          env: {},
        }),
      }),
    ).toBe("api_key");
    expect(
      resolveAgentAuthMode({
        oauthToken: "oat-abc",
        apiKey: undefined,
        preferApiKey: preferApiKeyForProductBuilderCodegen({
          isProductBuilderCodegen: true,
          apiKey: undefined,
          env: {},
        }),
      }),
    ).toBe("oauth");
  });
});
