import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/services/agents/seat-cooldown-store", () => ({
  publishSeatCooldown: vi.fn(),
  isSeatCoolingShared: () => false,
}));

type Sys = undefined | string | Array<{ type: string; text: string }>;
const seen: Array<{ apiKey: string | null; system: Sys }> = [];

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    apiKey: string | null;
    messages: { create: (p: { system?: Sys }) => Promise<unknown> };
    constructor(opts: { authToken?: string; apiKey?: string }) {
      this.apiKey = opts.apiKey ?? null;
      this.messages = {
        create: async (p) => {
          seen.push({ apiKey: this.apiKey, system: p.system });
          return { id: "msg" };
        },
      };
    }
  }
  return { default: FakeAnthropic };
});

import { getAnthropic, withClaudeCodeSystemBlock, _resetAnthropicClientsForTest } from "../anthropic";
import { _resetTokenRotationForTest } from "@/services/agents/agent-auth";
import { _setOAuthTokenPoolOverrideForTest } from "@/services/agents/oauth-token-source";

const BLOCK = "You are Claude Code, Anthropic's official CLI for Claude.";
const KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKENS", "PRAXIS_AGENT_AUTH_MODE"];
let saved: Record<string, string | undefined> = {};
const base = { model: "claude-sonnet-4-6", max_tokens: 10, messages: [] };

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  seen.length = 0;
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

describe("the entitlement block on the OAuth leg", () => {
  it("leads the system prompt on a subscription seat", async () => {
    _setOAuthTokenPoolOverrideForTest(["oat-1"]);
    await getAnthropic().messages.create({ ...base, system: "Be terse." } as never);
    expect(seen).toHaveLength(1);
    expect(seen[0].system).toEqual([
      { type: "text", text: BLOCK },
      { type: "text", text: "Be terse." },
    ]);
  });

  it("is the ONLY block when the caller passed no system prompt", async () => {
    _setOAuthTokenPoolOverrideForTest(["oat-1"]);
    await getAnthropic().messages.create(base as never);
    expect(seen[0].system).toEqual([{ type: "text", text: BLOCK }]);
  });

  it("keeps a caller's block array intact, including its cache_control", async () => {
    _setOAuthTokenPoolOverrideForTest(["oat-1"]);
    const cached = { type: "text", text: "long context", cache_control: { type: "ephemeral" } };
    await getAnthropic().messages.create({ ...base, system: [cached] } as never);
    expect(seen[0].system).toEqual([{ type: "text", text: BLOCK }, cached]);
  });

  it("is NOT added in api_key mode", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-metered";
    process.env.PRAXIS_AGENT_AUTH_MODE = "api_key";
    _setOAuthTokenPoolOverrideForTest(["oat-1"]);
    await getAnthropic().messages.create({ ...base, system: "Be terse." } as never);
    expect(seen[0]).toEqual({ apiKey: "sk-metered", system: "Be terse." });
  });
});

describe("withClaudeCodeSystemBlock", () => {
  it("is idempotent, so it can never double up", () => {
    const once = withClaudeCodeSystemBlock({ ...base, system: "hi" } as never);
    expect(withClaudeCodeSystemBlock(once)).toBe(once);
  });

  it("leaves a string that already starts with the block alone", () => {
    const p = { ...base, system: `${BLOCK}\n\nAlso be terse.` } as never;
    expect(withClaudeCodeSystemBlock(p)).toBe(p);
  });
});
