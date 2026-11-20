
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

const CANARY = "CANARY-41c9-keep-cards";

const h = vi.hoisted(() => ({
  switched: "seo" as string | null,
  writes: [] as string[],
  recorded: [] as Array<Record<string, unknown>>,
}));
const mockRunGeneric = vi.fn();

vi.mock("@/services/agents/generic-dispatcher", () => ({
  runGeneric: (...args: unknown[]) => mockRunGeneric(...args),
  writesSuppressed: (ctx: { draft_mode?: boolean; shadow_mode?: boolean }) =>
    ctx.shadow_mode === true || ctx.draft_mode === true,
  makeDraftCtx: (ctx: AgentContext) => ({ ...ctx, draft_mode: true }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (t: string) => {
      h.writes.push(`from:${t}`);
      throw new Error(`unexpected DB access: ${t}`);
    },
    rpc: (n: string) => {
      h.writes.push(`rpc:${n}`);
      throw new Error(`unexpected RPC: ${n}`);
    },
  }),
}));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = await orig<typeof import("@/services/tenant-client")>();
  return {
    ...real,
    tenantRpc: vi.fn(async (_t: unknown, name: string) => {
      h.writes.push(`tenantRpc:${name}`);
      throw new Error(`unexpected tenant RPC: ${name}`);
    }),
  };
});
vi.mock("@/services/decisions/dispatch-interactive", () => ({
  dispatchInteractiveDecision: vi.fn(async () => {
    h.writes.push("dispatchInteractiveDecision");
    return { dispatched: false };
  }),
}));
vi.mock("@/services/channels/channel-actions", async (orig) => {
  const real = await orig<typeof import("@/services/channels/channel-actions")>();
  return {
    ...real,
    recordChannelRunActions: vi.fn(async (args: Record<string, unknown>) => {
      h.writes.push("recordChannelRunActions");
      h.recorded.push(args);
      return { ids: [{ id: "a-1" }, { id: "a-2" }] };
    }),
    switchedChannelForRun: vi.fn(async () => h.switched),
  };
});

import { createSideEffectDispatcher } from "@/agents/lib/side-effect-dispatcher";
import { stripDryPreviewResult } from "@/services/growth/preview-dry-run";

beforeEach(() => {
  vi.clearAllMocks();
  h.switched = "seo";
  h.writes.length = 0;
  h.recorded.length = 0;
});

function modelResult(): DispatcherResult {
  const steps = [
    { title: `Fix the homepage title ${CANARY}`, action_type: "fix", detail: CANARY },
    { title: `Write a comparison page ${CANARY}`, action_type: "page", deliverable: { kind: "page", content: CANARY } },
  ];
  return {
    output_text: `Here is what I found ${CANARY}`,
    parsed: { rendered_markdown: CANARY, steps },
    parse_ok: true,
    raw_response_text: CANARY,
    prompt_snapshot: CANARY,
    usage: { input_tokens: 100, output_tokens: 50 },
    tool_calls: [{ name: "web_fetch__fetch", input_preview: CANARY, output_preview: CANARY, ms: 3, status: "ok" }],
  } as unknown as DispatcherResult;
}

function ctxWith(over: Record<string, unknown> = {}): AgentContext {
  return {
    tenant_id: "t-1",
    runId: "r-1",
    agent: { slug: "seo" },
    draft_mode: true,
    preview_dry: true,
    preview_keep_cards: true,
    emitDecision: vi.fn(async () => {
      h.writes.push("emitDecision");
      return "best_of_n_draft_noop";
    }),
    ...over,
  } as unknown as AgentContext;
}

function channelDispatcher(
  transform: (envelope: unknown) => Promise<unknown> = vi.fn(async (envelope: unknown) => ({ envelope })),
) {
  const dispatcher = createSideEffectDispatcher({
    slug: "seo",
    decisionClass: "channel.recipe_step",
    fanOut: (env: unknown) =>
      ((env as { steps: unknown[] }).steps ?? []).map((step, i, all) => ({ step, position: i + 1, of: all.length })),
    transformBeforeCriticAndEmit: transform,
  } as never);
  return { dispatcher, transform };
}

describe("a keep-cards preview run through the side-effect dispatcher", () => {
  it("records the run's cards, and writes nothing else", async () => {
    mockRunGeneric.mockResolvedValueOnce(modelResult());
    const { dispatcher, transform } = channelDispatcher();
    const ctx = ctxWith();

    const result = await dispatcher(ctx, {});

    expect(transform).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual(["recordChannelRunActions"]);
    expect(ctx.emitDecision).not.toHaveBeenCalled();
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ tenantId: "t-1", runId: "r-1", channelSlug: "seo", redo: null });
    expect((h.recorded[0].bodies as unknown[]).length).toBe(2);
    expect(result.preview_action_types).toBeUndefined();
  });

  it("the result the worker persists is still stripped: no text, no types, no side effect", async () => {
    mockRunGeneric.mockResolvedValueOnce(modelResult());
    const { dispatcher } = channelDispatcher();
    const persisted = stripDryPreviewResult(await dispatcher(ctxWith(), {}));

    expect(JSON.stringify(persisted)).not.toContain(CANARY);
    expect(persisted.output_text).toBe("");
    expect(persisted.parsed).toBeNull();
    expect(persisted.side_effect).toEqual({ kind: "none" });
    expect(persisted.preview_action_types).toEqual([]);
  });

  it("what is recorded is what the publish gate let through, not the model's raw steps", async () => {
    mockRunGeneric.mockResolvedValueOnce(modelResult());
    const gated = { rendered_markdown: "gated", steps: [{ title: "Gated title", action_type: "fix" }] };
    const { dispatcher } = channelDispatcher(vi.fn(async () => ({ envelope: gated })));

    await dispatcher(ctxWith(), {});

    expect(h.recorded[0].envelope).toEqual(gated);
    expect(JSON.stringify(h.recorded[0])).not.toContain(CANARY);
  });

  it("a gate that suppresses the run records nothing", async () => {
    mockRunGeneric.mockResolvedValueOnce(modelResult());
    const { dispatcher } = channelDispatcher(vi.fn(async () => ({ suppress: true as const, reason: "empty_diff" })));
    await dispatcher(ctxWith(), {});
    expect(h.writes).toEqual([]);
  });

  it("a channel still on the decisions store writes nothing at all", async () => {
    h.switched = null;
    mockRunGeneric.mockResolvedValueOnce(modelResult());
    const { dispatcher } = channelDispatcher();
    const ctx = ctxWith();
    await dispatcher(ctx, {});
    expect(h.writes).toEqual([]);
    expect(ctx.emitDecision).not.toHaveBeenCalled();
  });

  it("the flag opens nothing on its own: without preview_dry a draft run still records nothing", async () => {
    mockRunGeneric.mockResolvedValueOnce(modelResult());
    const { dispatcher } = channelDispatcher();
    await dispatcher(ctxWith({ preview_dry: undefined }), {});
    expect(h.writes.filter((w) => w === "recordChannelRunActions")).toEqual([]);
  });

  it("never on a shadow run", async () => {
    mockRunGeneric.mockResolvedValueOnce(modelResult());
    const { dispatcher } = channelDispatcher();
    await dispatcher(ctxWith({ shadow_mode: true }), {});
    expect(h.writes.filter((w) => w === "recordChannelRunActions")).toEqual([]);
  });

  it("switch OFF (no keep-cards flag): the dry run still counts types and records nothing", async () => {
    mockRunGeneric.mockResolvedValueOnce(modelResult());
    const { dispatcher, transform } = channelDispatcher();
    const result = await dispatcher(ctxWith({ preview_keep_cards: undefined }), {});
    expect(result.preview_action_types).toEqual(["fix", "page"]);
    expect(transform).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
});
