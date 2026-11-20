import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  error: null as { message: string } | null,
  throwOnRead: false,
  flagDisabled: false,
  flagError: false,
}));

vi.mock("@/services/supabase", () => {
  const overrideQ: Record<string, unknown> = {
    select: () => overrideQ,
    eq: () => overrideQ,
    maybeSingle: () => {
      if (h.throwOnRead) throw new Error("boom");
      return { data: h.data, error: h.error };
    },
  };
  const configQ: Record<string, unknown> = {
    select: () => configQ,
    eq: () => configQ,
    maybeSingle: () => {
      if (h.flagError) return { data: null, error: { message: "cfg down" } };
      return {
        data: { blob: { provider_overrides_disabled: h.flagDisabled } },
        error: null,
      };
    },
  };
  return {
    serviceClient: () => ({
      from: (table: string) =>
        table === "system_config" ? configQ : overrideQ,
    }),
  };
});

import { resolveRunEngine } from "../resolve-run-engine";

const META = { provider: undefined, model: "claude-opus-4-7" } as never;

describe("resolveRunEngine", () => {
  beforeEach(() => {
    h.data = null;
    h.error = null;
    h.throwOnRead = false;
    h.flagDisabled = false;
    h.flagError = false;
  });

  it("no override row → agent default (anthropic + agent.md model)", async () => {
    const r = await resolveRunEngine("t1", "research", META);
    expect(r).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
      source: "agent_default",
    });
  });

  it("valid openai override → provider+model from the row", async () => {
    h.data = { provider: "openai", model: "gpt-5.5" };
    const r = await resolveRunEngine("t1", "support-lead", META);
    expect(r).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      source: "tenant_override",
    });
  });

  it("inconsistent override (openai + claude model) → fail safe to agent default", async () => {
    h.data = { provider: "openai", model: "claude-opus-4-7" };
    const r = await resolveRunEngine("t1", "engineer", META);
    expect(r.provider).toBe("anthropic");
    expect(r.source).toBe("agent_default");
  });

  it("read error → fail safe to agent default", async () => {
    h.error = { message: "db down" };
    const r = await resolveRunEngine("t1", "pm", META);
    expect(r.provider).toBe("anthropic");
    expect(r.source).toBe("agent_default");
  });

  it("thrown read → fail safe to agent default (never breaks the run)", async () => {
    h.throwOnRead = true;
    const r = await resolveRunEngine("t1", "qa", META);
    expect(r.provider).toBe("anthropic");
    expect(r.source).toBe("agent_default");
  });

  it("anthropic override with explicit model is honored (no provider flip)", async () => {
    h.data = { provider: "anthropic", model: "claude-sonnet-4-6" };
    const r = await resolveRunEngine("t1", "social", META);
    expect(r).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      source: "tenant_override",
    });
  });

  it("override row with blank model falls back to the agent.md model", async () => {
    h.data = { provider: "anthropic", model: "  " };
    const r = await resolveRunEngine("t1", "advisor", META);
    expect(r.model).toBe("claude-opus-4-7");
    expect(r.source).toBe("tenant_override");
  });

  it("master-kill ON → ignores an otherwise-valid override, returns agent default", async () => {
    h.flagDisabled = true;
    h.data = { provider: "openai", model: "gpt-5.5" };
    const r = await resolveRunEngine("t1", "support-lead", META);
    expect(r).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
      source: "agent_default",
    });
  });

  it("master-kill OFF → override is honored (flag does not block when false)", async () => {
    h.flagDisabled = false;
    h.data = { provider: "openai", model: "gpt-5.5" };
    const r = await resolveRunEngine("t1", "support-lead", META);
    expect(r.provider).toBe("openai");
    expect(r.source).toBe("tenant_override");
  });

  it("master-kill flag read error → fail toward default-engine (overrides ignored)", async () => {
    h.flagError = true;
    h.data = { provider: "openai", model: "gpt-5.5" };
    const r = await resolveRunEngine("t1", "support-lead", META);
    expect(r.provider).toBe("anthropic");
    expect(r.source).toBe("agent_default");
  });

  it("bad bedrock+gpt row (mismatched model) → fail safe to agent default", async () => {
    h.data = { provider: "bedrock", model: "gpt-5.5" };
    const r = await resolveRunEngine("t1", "research", META);
    expect(r.provider).toBe("anthropic");
    expect(r.source).toBe("agent_default");
  });

  it("bad bedrock+claude row → fail safe to agent default", async () => {
    h.data = { provider: "bedrock", model: "claude-opus-4-7" };
    const r = await resolveRunEngine("t1", "research", META);
    expect(r.provider).toBe("anthropic");
    expect(r.source).toBe("agent_default");
  });

  it("valid bedrock row for a STATELESS agent → honored", async () => {
    h.data = { provider: "bedrock", model: "qwen.qwen3-next-80b-a3b-instruct" };
    const r = await resolveRunEngine("t1", "research", META);
    expect(r.provider).toBe("bedrock");
    expect(r.model).toBe("qwen.qwen3-next-80b-a3b-instruct");
    expect(r.source).toBe("tenant_override");
  });

  it("valid bedrock row for a CONVERSATIONAL agent → fail safe to agent default", async () => {
    h.data = { provider: "bedrock", model: "qwen.qwen3-next-80b-a3b-instruct" };
    const r = await resolveRunEngine("t1", "support-lead", META);
    expect(r.provider).toBe("anthropic");
    expect(r.source).toBe("agent_default");
  });
});
