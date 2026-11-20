import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("@/services/agents/generic-dispatcher", () => ({
  buildSystemPromptForTest: () => "sys",
  resolveClaudeBinary: () => undefined,
}));
vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: async () => ({
    body_markdown: "body",
    metadata_praxis: { model: "claude-opus-5-5", tools: ["memory__search", "meta_ads__list_campaigns", "meta_ads__propose_status_change"] },
  }),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CGO_REVIEW_MODEL, cgoProdConfig, cgoQueryOptions, liveAuth, replayToolAnswer, PROD_MAX_TOOL_ITERS } from "../cgo-model";

describe("cgo model call: tools really off, no backend secrets in the child", () => {
  it("denies every built-in tool and does not bypass permissions", () => {
    const o = cgoQueryOptions("sys", "tok", () => {}) as Record<string, unknown>;
    for (const t of ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Grep", "Glob", "Task", "KillShell", "BashOutput", "SlashCommand"]) {
      expect(o.disallowedTools).toContain(t);
    }
    expect(o.permissionMode).toBeUndefined();
    expect(o.maxTurns).toBe(1);
  });

  it("the child env carries the OAuth token and none of the backend .env", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret";
    process.env.ANTHROPIC_API_KEY = "api-key-secret";
    const env = (cgoQueryOptions("sys", "tok", () => {}) as { env: NodeJS.ProcessEnv }).env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(JSON.stringify(env)).not.toContain("service-role-secret");
    expect(JSON.stringify(env)).not.toContain("api-key-secret");
  });
});

describe("the sim runs cgo on its production model", () => {
  it("CGO_REVIEW_MODEL is the model in cgo's agent.md", () => {
    const md = readFileSync(join(__dirname, "../../../../agents/cgo/agent.md"), "utf8");
    const prod = /^\s*model:\s*(\S+)/m.exec(md)?.[1];
    expect(prod).toBeTruthy();
    expect(CGO_REVIEW_MODEL).toBe(prod);
  });
});

describe("the live evals run cgo as production does", () => {
  it("model, declared tools and turn cap come from the agent definition, not a pinned model", async () => {
    const cfg = await cgoProdConfig();
    expect(cfg.model).toBe("claude-opus-5-5");
    expect(cfg.tools).toContain("meta_ads__propose_status_change");
    expect(cfg.maxTurns).toBe(PROD_MAX_TOOL_ITERS);
    expect((cgoQueryOptions("sys", "tok", () => {}, cfg.model) as { model?: string }).model).toBe("claude-opus-5-5");
  });

  it("auth: OAuth first as production, API key as the CI fallback, else a clear error", () => {
    expect(liveAuth({ CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_API_KEY: "k" })).toEqual({ mode: "oauth", secret: "o" });
    expect(liveAuth({ ANTHROPIC_API_KEY: "k" })).toEqual({ mode: "api_key", secret: "k" });
    expect(() => liveAuth({})).toThrow(/CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY/);
  });

  it("replay tools answer from the fixture and never claim a write applied", () => {
    const world = { campaigns: [{ platform: "meta", id: "1", name: "A", objective: "OUTCOME_SALES", sets: [] }] } as never;
    expect(JSON.parse(replayToolAnswer("meta_ads__list_campaigns", {}, world)).campaigns[0]).toMatchObject({ id: "1", status: "ACTIVE" });
    expect(replayToolAnswer("meta_ads__propose_status_change", {}, world)).toMatch(/nothing was applied/);
    expect(replayToolAnswer("growth__read_revenue", {}, world)).toMatch(/Nothing to read/);
  });
});
