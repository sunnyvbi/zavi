import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const alertMock = vi.fn(async () => {});
vi.mock("@/services/logging/alert", () => ({ alert: (...a: unknown[]) => alertMock(...(a as [])) }));

vi.mock("@/services/agents/seat-cooldown-store", () => ({
  publishSeatCooldown: vi.fn(),
  isSeatCoolingShared: () => false,
}));

const calls: Array<{ authToken?: string | null; apiKey?: string | null }> = [];
const behaviour = new Map<string, () => unknown>();

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    authToken?: string | null;
    apiKey?: string | null;
    messages: { create: () => Promise<unknown> };
    constructor(opts: { authToken?: string; apiKey?: string }) {
      this.authToken = opts.authToken ?? null;
      this.apiKey = opts.apiKey ?? null;
      this.messages = {
        create: async () => {
          calls.push({ authToken: this.authToken, apiKey: this.apiKey });
          const key = this.apiKey ? "api_key" : String(this.authToken);
          const fn = behaviour.get(key);
          if (fn) return fn();
          return { id: `msg-${key}` };
        },
      };
    }
  }
  return { default: FakeAnthropic };
});

import {
  getAnthropic,
  runWithTokenFailover,
  _resetAnthropicClientsForTest,
} from "../anthropic";
import {
  isTokenCooling,
  _resetTokenRotationForTest,
} from "@/services/agents/agent-auth";
import { _setOAuthTokenPoolOverrideForTest } from "@/services/agents/oauth-token-source";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKENS",
  "PRAXIS_AGENT_AUTH_MODE",
  "HELICONE_API_KEY",
];
let saved: Record<string, string | undefined> = {};
const CAP = { status: 429, message: "You've hit your limit · resets 12am (UTC)" };
const params = { model: "claude-haiku-4-5", max_tokens: 10, messages: [] } as never;
const noSleep = async () => {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  calls.length = 0;
  behaviour.clear();
  _resetAnthropicClientsForTest();
  _resetTokenRotationForTest();
  _setOAuthTokenPoolOverrideForTest([]);
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _setOAuthTokenPoolOverrideForTest([]);
});

describe("runWithTokenFailover benching", () => {
  it("benches a seat that returned its usage-limit message", async () => {
    await runWithTokenFailover(
      ["a", "b"],
      async (t) => {
        if (t === "a") throw CAP;
        return "ok";
      },
      noSleep,
    );
    expect(isTokenCooling("a")).toBe(true);
    expect(isTokenCooling("b")).toBe(false);
  });

  it("does NOT bench a seat for a plain 429 throttle or an overload", async () => {
    await runWithTokenFailover(
      ["a", "b", "c"],
      async (t) => {
        if (t === "a") throw { status: 429, message: "rate_limit_error" };
        if (t === "b") throw { status: 529, message: "Overloaded" };
        return "ok";
      },
      noSleep,
    );
    expect(isTokenCooling("a")).toBe(false);
    expect(isTokenCooling("b")).toBe(false);
  });
});

describe("getAnthropic() central failover", () => {
  it("fails over to the next seat when one is capped, and later calls skip the benched seat", async () => {
    _setOAuthTokenPoolOverrideForTest(["s1", "s2"]);
    behaviour.set("s1", () => {
      throw CAP;
    });
    const first = await getAnthropic().messages.create(params);
    expect((first as { id: string }).id).toBe("msg-s2");
    expect(calls.map((c) => c.authToken)).toEqual(["s1", "s2"]);

    calls.length = 0;
    await getAnthropic().messages.create(params);
    await getAnthropic().messages.create(params);
    expect(calls.map((c) => c.authToken)).toEqual(["s2", "s2"]);
  });

  it("picks up a pool edit without a restart (no seat pinned for the process)", async () => {
    _setOAuthTokenPoolOverrideForTest(["old"]);
    await getAnthropic().messages.create(params);
    _setOAuthTokenPoolOverrideForTest(["new"]);
    await getAnthropic().messages.create(params);
    expect(calls.map((c) => c.authToken)).toEqual(["old", "new"]);
  });

  it("single seat: one call, a cap bubbles (nothing to fail over to)", async () => {
    _setOAuthTokenPoolOverrideForTest(["only"]);
    behaviour.set("only", () => {
      throw CAP;
    });
    await expect(getAnthropic().messages.create(params)).rejects.toMatchObject(CAP);
    expect(calls).toHaveLength(1);
  });

  it("api_key mode: one call on the API key, the seat pool is not used", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-metered";
    process.env.PRAXIS_AGENT_AUTH_MODE = "api_key";
    _setOAuthTokenPoolOverrideForTest(["s1", "s2"]);
    await getAnthropic().messages.create(params);
    expect(calls).toEqual([{ authToken: null, apiKey: "sk-metered" }]);
  });

  it("api_key mode: an API-key usage limit does NOT bench the OAuth seat in the pool", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-metered";
    process.env.PRAXIS_AGENT_AUTH_MODE = "api_key";
    _setOAuthTokenPoolOverrideForTest(["s1", "s2"]);
    behaviour.set("api_key", () => {
      throw { status: 429, message: "insufficient credits" };
    });
    await expect(getAnthropic().messages.create(params)).rejects.toMatchObject({ status: 429 });
    expect(isTokenCooling("s1")).toBe(false);
  });

  it("still throws synchronously when there is no credential at all", () => {
    expect(() => getAnthropic()).toThrow(/No Anthropic auth/);
  });
});

describe("model refusal (5.x safety classifiers)", () => {
  it("returns the refused message unchanged and alerts with the category only", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    alertMock.mockClear();
    const refused = { id: "m", model: "claude-sonnet-5-5", stop_reason: "refusal", stop_details: { category: "bio" }, content: [] };
    behaviour.set("api_key", () => refused);
    const out = await getAnthropic().messages.create(params);
    expect(out).toBe(refused);
    expect(alertMock).toHaveBeenCalledWith(expect.objectContaining({ code: "model_refusal", msg: expect.stringContaining("category bio") }));
  });
  it("does not alert on a normal answer", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    alertMock.mockClear();
    behaviour.set("api_key", () => ({ id: "m", stop_reason: "end_turn", content: [] }));
    await getAnthropic().messages.create(params);
    expect(alertMock).not.toHaveBeenCalled();
  });
});
