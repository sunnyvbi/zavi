import { describe, it, expect, vi, beforeEach } from "vitest";

const chainable: Record<string, unknown> = {};
const thenableChain = new Proxy(chainable, {
  get(_t, prop) {
    if (prop === "then") return undefined;
    return () => thenableChain;
  },
  apply() {
    return thenableChain;
  },
});
vi.mock("@/services/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/supabase")>()),
  serviceClient: () => ({
    from: () => thenableChain,
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => chainable },
  }),
}));

const { script } = vi.hoisted(() => ({ script: { turns: [] as string[], subtype: "success" as string } }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: { prompt: AsyncIterable<unknown> }) {
    for await (const _m of args.prompt) void _m;
    for (const text of script.turns) {
      yield {
        type: "assistant" as const,
        message: { content: [{ type: "text", text }] },
      };
    }
    yield {
      type: "result" as const,
      subtype: script.subtype,
      session_id: "test-session",
      result: script.turns[script.turns.length - 1] ?? "",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }),
}));

vi.mock("@/services/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory")>()),
  searchMemory: vi.fn(async () => []),
}));
vi.mock("@/services/mcp/discovery", () => ({
  discoverToolsForTenant: async () => ({ tools: [], disconnected_connectors: [] }),
  listToolsForTenant: async () => [],
  _clearToolCacheForTests: () => {},
}));
vi.mock("@/services/logging/logEvent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/logging/logEvent")>()),
  logEvent: vi.fn(async () => {}),
}));
vi.mock("../setup-schema", () => ({
  probeSetupCompleteness: async () => ({
    ok: true,
    missing_vault_keys: [],
    missing_connectors: [],
    missing_required_connectors: [],
    missing_optional_connectors: [],
  }),
  getAgentSetupSchema: async () => null,
  recordSetupBlock: async () => {},
}));
vi.mock("../learnings", () => ({ loadAgentLearnings: async () => [] }));

import { runGeneric } from "@/services/agents/generic-dispatcher";
import type { AgentContext } from "@/services/agents/types";
import { evaluateCtoShipGate } from "@/agents/engineer/ship-gate";
import { latestTurnEnvelopeMatch } from "../envelope-turn-fallback";

const gateReason = (p: unknown) => (evaluateCtoShipGate(p) as { reason?: string }).reason;

const SCAFFOLD = {
  summary: "Scaffold couple app",
  rendered_markdown: "Scaffolded the couple app: auth, schema, home screen.",
  repo: "Praxis-build/couple-app",
  base_branch: "main",
};
const REFUSAL = {
  refused: true,
  rendered_markdown: "I can't ship this: the repo is archived.",
};
const env = (o: unknown) => `<pr_proposal>${JSON.stringify(o)}</pr_proposal>`;

const progress: Array<[string, unknown]> = [];

function makeCtx(): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: "run-envelope-turn-fallback",
    trigger: "handoff",
    draft_mode: true,
    citedNotes: new Map(),
    agent: {
      slug: "operator",
      body_markdown: "# Operator",
      metadata_praxis: {
        memory_layer: false,
        tools: [] as string[],
        model: "claude-sonnet-4-6",
        output_envelope: "pr_proposal",
        prose_fallback: true,
      },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async (stage: string, meta?: unknown) => {
      progress.push([stage, meta]);
    },
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

async function run(turns: string[], subtype = "success") {
  script.turns = turns;
  script.subtype = subtype;
  const warn = vi.spyOn(console, "warn");
  const r = await runGeneric(makeCtx(), "build the scaffold");
  const fallbackLogged = warn.mock.calls.some((c) =>
    String(c[0]).includes("final turn had no <pr_proposal>"),
  );
  warn.mockRestore();
  return { r, parsed: r.parsed as Record<string, unknown> | null, fallbackLogged };
}

beforeEach(() => {
  progress.length = 0;
});

describe("engineer envelope written in an earlier turn, final turn is prose", () => {
  it("uses the earlier envelope instead of refusing, and logs the fallback", async () => {
    const { r, parsed, fallbackLogged } = await run([
      `Done. ${env(SCAFFOLD)}`,
      "Let me know if you'd like me to tweak the colors on the home screen.",
    ]);
    expect(parsed?.refused).toBeUndefined();
    expect(parsed?.parse_fallback_kind).toBeUndefined();
    expect(parsed?.summary).toBe(SCAFFOLD.summary);
    expect(parsed?.repo).toBe(SCAFFOLD.repo);
    expect(r.parse_ok).toBe(true);
    expect(fallbackLogged).toBe(true);
    expect(progress).toContainEqual(["envelope_extracted", { code: "earlier_turn_envelope" }]);
    expect(gateReason(parsed)).not.toBe("refused_envelope");
  });

  it("no envelope in any turn still refuses as before", async () => {
    const { parsed, fallbackLogged } = await run([
      "Looking at the repo now.",
      "I couldn't finish the scaffold.",
    ]);
    expect(parsed?.refused).toBe(true);
    expect(parsed?.parse_fallback_kind).toBe("no_envelope_block_prose_fallback");
    expect(fallbackLogged).toBe(false);
    expect(evaluateCtoShipGate(parsed)).toEqual({
      shippable: false,
      reason: "refused_envelope",
    });
  });

  it("a later explicit refusal envelope beats an earlier proposal", async () => {
    const { parsed } = await run([
      env(SCAFFOLD),
      `Actually no. ${env(REFUSAL)}`,
      "Sorry about that.",
    ]);
    expect(parsed?.refused).toBe(true);
    expect(parsed?.summary).toBeUndefined();
    expect(parsed?.rendered_markdown).toBe(REFUSAL.rendered_markdown);
    expect(gateReason(parsed)).toBe("refused_envelope");
  });

  it("a run that ran out of turns never ships an earlier envelope", async () => {
    const { r, parsed, fallbackLogged } = await run(
      [`Done. ${env(SCAFFOLD)}`, "Fixing one more type error in app/page.tsx"],
      "error_max_turns",
    );
    expect(fallbackLogged).toBe(false);
    expect(parsed?.refused).toBe(true);
    expect(parsed?.parse_fallback_kind).toBe("tool_iter_cap_fallback");
    expect(parsed?.summary).toBeUndefined();
    expect(r.parse_error).toBe("tool_iter_cap");
    expect(progress).not.toContainEqual(["envelope_extracted", { code: "earlier_turn_envelope" }]);
    expect(gateReason(parsed)).toBe("refused_envelope");
  });

  it("a truncated envelope in the latest turn is skipped for the last well-formed one", async () => {
    const { parsed } = await run([
      env(SCAFFOLD),
      '<pr_proposal>{"summary": "half</pr_proposal>',
      "Wrapping up.",
    ]);
    expect(parsed?.summary).toBe(SCAFFOLD.summary);
  });
});

describe("latestTurnEnvelopeMatch", () => {
  const re = /<pr_proposal>([\s\S]*?)<\/pr_proposal>/;
  it("only applies to pr_proposal", () => {
    const re2 = /<digest>([\s\S]*?)<\/digest>/;
    expect(latestTurnEnvelopeMatch(['<digest>{"a":1}</digest>', "prose"], "digest", re2)).toBeNull();
  });
  it("accepts a fenced JSON payload and reports the turn", () => {
    const hit = latestTurnEnvelopeMatch(
      ["<pr_proposal>\n```json\n{\"summary\":\"x\"}\n```\n</pr_proposal>", "prose"],
      "pr_proposal",
      re,
    );
    expect(hit?.turnIndex).toBe(0);
  });
});
