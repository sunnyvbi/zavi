import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getFreshAnthropic, hasAnthropicAuth } from "../anthropic";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKENS",
  "PRAXIS_AGENT_AUTH_MODE",
  "HELICONE_API_KEY",
];
let saved: Record<string, string | undefined> = {};

describe("anthropic raw-SDK auth uses a single pooled token", () => {
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("uses pool[0], NOT the whole comma-list, as the bearer", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tokA,tokB,tokC,tokD";
    const client = getFreshAnthropic();
    expect(client.authToken).toBe("tokA");
    expect(client.authToken).not.toContain(",");
  });

  it("prefers the plural CLAUDE_CODE_OAUTH_TOKENS pool", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKENS = "plu1, plu2";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "single";
    expect(getFreshAnthropic().authToken).toBe("plu1");
  });

  it("passes a lone token through unchanged", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "onlytoken";
    expect(getFreshAnthropic().authToken).toBe("onlytoken");
  });

  it("hasAnthropicAuth is true for a comma-list and for a plural-only pool", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "a,b";
    expect(hasAnthropicAuth()).toBe(true);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKENS = "x,y";
    expect(hasAnthropicAuth()).toBe(true);
  });

  it("uses the metered API key when PRAXIS_AGENT_AUTH_MODE=api_key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-metered";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tokA,tokB";
    process.env.PRAXIS_AGENT_AUTH_MODE = "api_key";
    const client = getFreshAnthropic();
    expect(client.apiKey).toBe("sk-metered");
    expect(client.authToken).toBeFalsy();
  });
});
