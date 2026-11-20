
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

const CANARY = "CANARY-7d2e-preview";

const mockRunGeneric = vi.fn();
const writes: string[] = [];
vi.mock("@/services/agents/generic-dispatcher", () => ({
  runGeneric: (...args: unknown[]) => mockRunGeneric(...args),
  writesSuppressed: (ctx: { draft_mode?: boolean }) => ctx.draft_mode === true,
  makeDraftCtx: (ctx: AgentContext) => ({ ...ctx, draft_mode: true }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (t: string) => {
      writes.push(`from:${t}`);
      throw new Error(`unexpected DB access: ${t}`);
    },
    rpc: (n: string) => {
      writes.push(`rpc:${n}`);
      throw new Error(`unexpected RPC: ${n}`);
    },
  }),
}));
vi.mock("@/services/channels/channel-actions", async (orig) => {
  const real = await orig<typeof import("@/services/channels/channel-actions")>();
  return {
    ...real,
    recordChannelRunActions: vi.fn(async () => {
      writes.push("recordChannelRunActions");
      throw new Error("a dry preview must not record actions");
    }),
    switchedChannelForRun: vi.fn(async () => "seo"),
  };
});

import { createSideEffectDispatcher } from "@/agents/lib/side-effect-dispatcher";
import { stripDryPreviewResult } from "@/services/growth/preview-dry-run";

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
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

function previewCtx(): AgentContext {
  return {
    tenant_id: "t-1",
    runId: "r-1",
    agent: { slug: "seo" },
    draft_mode: true,
    preview_dry: true,
    emitDecision: vi.fn(async () => {
      writes.push("emitDecision");
      return "d-1";
    }),
  } as unknown as AgentContext;
}

describe("a dry preview run through the side-effect dispatcher", () => {
  it("counts the action types and writes nothing", async () => {
    mockRunGeneric.mockResolvedValueOnce(modelResult());
    const transform = vi.fn(async (envelope: unknown) => ({ envelope }));
    const dispatcher = createSideEffectDispatcher({
      slug: "seo",
      decisionClass: "channel.recipe_step",
      fanOut: (env: unknown) =>
        ((env as { steps: unknown[] }).steps ?? []).map((step, i, all) => ({ step, position: i + 1, of: all.length })),
      transformBeforeCriticAndEmit: transform,
    } as never);

    const ctx = previewCtx();
    const result = await dispatcher(ctx, {});

    expect(result.preview_action_types).toEqual(["fix", "page"]);
    expect(transform).not.toHaveBeenCalled();
    expect(ctx.emitDecision).not.toHaveBeenCalled();
    expect(writes).toEqual([]);

    const persisted = JSON.stringify(stripDryPreviewResult(result));
    expect(persisted).not.toContain(CANARY);
    expect(persisted).toContain('"preview_action_types":["fix","page"]');
  });

  it("a normal (non-preview) run still reaches the transform", async () => {
    mockRunGeneric.mockResolvedValueOnce({ ...modelResult(), parsed: { steps: [] } });
    const transform = vi.fn(async () => ({ suppress: true as const, reason: "empty_diff" }));
    const dispatcher = createSideEffectDispatcher({
      slug: "seo",
      decisionClass: "channel.recipe_step",
      fanOut: () => [],
      transformBeforeCriticAndEmit: transform,
    } as never);
    const ctx = { ...previewCtx(), draft_mode: undefined, preview_dry: undefined } as unknown as AgentContext;
    await dispatcher(ctx, {});
    expect(transform).toHaveBeenCalledTimes(1);
  });
});
