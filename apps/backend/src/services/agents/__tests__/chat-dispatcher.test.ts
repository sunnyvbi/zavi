import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  runGenericMock: vi.fn(),
  postProcessorSpy: vi.fn(async () => {}),
  getEffectiveVisibilityMock: vi.fn(async () => ({
    visible: true,
    reason: "default_enabled",
  })),
  loadReadyHtmlPreviewMock: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: mocks.fromMock, rpc: mocks.rpcMock }),
  serverClientFromBearer: () => ({}),
}));
vi.mock("../visibility", () => ({
  getEffectiveVisibility: mocks.getEffectiveVisibilityMock,
}));
vi.mock("../generic-dispatcher", () => ({ runGeneric: mocks.runGenericMock }));
vi.mock("@/agents/index", () => ({
  postProcessors: { "pm": mocks.postProcessorSpy },
}));
vi.mock("../html-preview-artifacts", () => ({
  loadReadyHtmlPreview: mocks.loadReadyHtmlPreviewMock,
}));

import { runChat } from "../chat-dispatcher";
import { promoteMissingConnectorReply } from "../connector-request";
import type { AgentContext } from "../types";

const fromMock = mocks.fromMock;
const rpcMock = mocks.rpcMock;
const runGenericMock = mocks.runGenericMock;
const postProcessorSpy = mocks.postProcessorSpy;
const getEffectiveVisibilityMock = mocks.getEffectiveVisibilityMock;
const loadReadyHtmlPreviewMock = mocks.loadReadyHtmlPreviewMock;

function makeCtx(overrides?: Partial<{ tenant_id: string; slug: string; runId: string; userId: string; runOwnerBroken: boolean }>): AgentContext {
  return {
    agent: {
      slug: overrides?.slug ?? "support-lead",
      metadata_praxis: { requires_sandbox: false },
    } as never,
    tenant_id: overrides?.tenant_id ?? "tenant-A",
    tenantConfig: {} as never,
    memory: {} as never,
    anthropic: {} as never,
    runId: overrides?.runId ?? "run-1",
    ...(overrides?.userId ? { userId: overrides.userId } : {}),
    ...(overrides?.runOwnerBroken ? { runOwnerBroken: true } : {}),
    trigger: "chat" as never,
    scanRecentRuns: vi.fn(),
    emitDecision: vi.fn(),
    emitProgress: vi.fn(),
  } as never;
}

function stubChain(rows: unknown, err: unknown = null) {
  const result = Promise.resolve({ data: rows, error: err });
  const chain: Record<string, unknown> = {};
  const allMethods = ["select", "eq", "neq", "lt", "gte", "filter", "in_", "order", "limit", "contains"];
  for (const m of allMethods) chain[m] = vi.fn(() => chain);
  chain.single = vi.fn(() => result);
  chain.maybeSingle = vi.fn(() => result);
  chain.limit = vi.fn(() => result);
  return chain;
}

beforeEach(() => {
  fromMock.mockReset();
  rpcMock.mockReset();
  runGenericMock.mockReset();
  postProcessorSpy.mockReset();
  postProcessorSpy.mockResolvedValue(undefined);
  getEffectiveVisibilityMock.mockReset();
  getEffectiveVisibilityMock.mockResolvedValue({
    visible: true,
    reason: "default_enabled",
  });
  loadReadyHtmlPreviewMock.mockReset();
  loadReadyHtmlPreviewMock.mockResolvedValue(null);
  runGenericMock.mockResolvedValue({
    output_text: "ok",
    parsed: null,
    parse_ok: true,
    raw_response_text: "ok",
    prompt_snapshot: "",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  rpcMock.mockResolvedValue({ data: "msg-id", error: null });
  fromMock.mockImplementation(() => stubChain([]));
  fromMock.mockImplementationOnce(() => stubChain(null));
});

describe("runChat guard rails", () => {
  it("persists a recovered connection card beside the unchanged assistant reply", async () => {
    const text = "Google Analytics isn't connected, so I have no traffic figures.";
    const recovered = await promoteMissingConnectorReply({
      text, run_id: "run-1", trigger: "chat",
      validate: async slug => ({ok: true, slug, label: "Google Analytics"}),
    });
    expect(recovered).not.toBeNull();
    fromMock
      .mockImplementationOnce(() => stubChain({id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead", user_id: "user-owner"}))
      .mockImplementationOnce(() => stubChain({id: "u1", body: "Check my traffic", sender_role: "user", thread_id: "t1"}));
    runGenericMock.mockResolvedValueOnce({
      output_text: text, raw_response_text: text, parsed: null, parse_ok: true,
      prompt_snapshot: "", usage: {input_tokens: 1, output_tokens: 1},
      connector_request: recovered!.emitted.request,
    });
    await runChat(makeCtx({userId: "user-owner"}), {thread_id: "t1", user_message_id: "u1"});
    const call = rpcMock.mock.calls.find(([name]) => name === "record_agent_chat_reply");
    expect(call?.[1]).toMatchObject({
      p_tenant_id: "tenant-A", p_body: text,
      p_meta: {connector_request: recovered!.emitted.request},
    });
  });

  it("throws when thread_id is missing", async () => {
    await expect(runChat(makeCtx(), { user_message_id: "u1" })).rejects.toThrow(/thread_id/);
  });

  it("throws when user_message_id is missing", async () => {
    await expect(runChat(makeCtx(), { thread_id: "t1" })).rejects.toThrow(/user_message_id/);
  });

  it("disabled agent → rejected by safety gate with a clean message (defense-in-depth)", async () => {
    getEffectiveVisibilityMock.mockResolvedValueOnce({
      visible: false,
      reason: "default_disabled",
    });
    await expect(
      runChat(makeCtx({ slug: "company-founder" }), {
        thread_id: "t1",
        user_message_id: "u1",
      }),
    ).rejects.toThrow(/isn't available for chat/);
    expect(runGenericMock).not.toHaveBeenCalled();
  });

  it("a channel's own agent (channel_only_hide, a listing decision) is NOT refused by the worker", async () => {
    getEffectiveVisibilityMock.mockResolvedValueOnce({ visible: false, reason: "channel_only_hide" });
    await runChat(makeCtx({ slug: "seo" }), { thread_id: "t1", user_message_id: "u1" }).catch((e: Error) => {
      expect(e.message).not.toMatch(/isn't available for chat/);
    });
  });

  it("visible but chat_eligible:false → rejected (the tenant-visible-override case)", async () => {
    getEffectiveVisibilityMock.mockResolvedValueOnce({
      visible: true,
      reason: "tenant_visible_override",
    });
    const ctx = makeCtx({ slug: "pipeline-only-agent" });
    (ctx.agent.metadata_praxis as { chat_eligible?: boolean }).chat_eligible = false;
    await expect(
      runChat(ctx, { thread_id: "t1", user_message_id: "u1" }),
    ).rejects.toThrow(/isn't available for chat/);
    expect(runGenericMock).not.toHaveBeenCalled();
  });

  it("throws on tenant mismatch", async () => {
    fromMock.mockImplementationOnce(() =>
      stubChain({ id: "t1", tenant_id: "tenant-B", agent_slug: "support-lead" }),
    );
    await expect(
      runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" }),
    ).rejects.toThrow(/tenant mismatch/);
  });

  it("throws on agent_slug mismatch", async () => {
    fromMock.mockImplementationOnce(() =>
      stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "WRONG" }),
    );
    await expect(
      runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" }),
    ).rejects.toThrow(/agent_slug mismatch/);
  });

  it("a teammate's run naming another member's thread fails closed, before any replay", async () => {
    fromMock.mockImplementationOnce(() =>
      stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead", user_id: "user-owner" }),
    );
    await expect(
      runChat(makeCtx({ userId: "user-teammate" }), { thread_id: "t1", user_message_id: "u1" }),
    ).rejects.toThrow(/thread owner mismatch/);
    expect(fromMock).toHaveBeenCalledTimes(2);
    expect(runGenericMock).not.toHaveBeenCalled();
  });

  it("a run whose owner chain did not resolve is refused, before any replay", async () => {
    fromMock.mockImplementationOnce(() =>
      stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead", user_id: "user-owner" }),
    );
    await expect(
      runChat(makeCtx({ runOwnerBroken: true }), {
        thread_id: "t1",
        resume_of_run_id: "run-gone",
        internal_resume_turn: "approved",
      }),
    ).rejects.toThrow(/thread owner unresolved/);
    expect(fromMock).toHaveBeenCalledTimes(2);
    expect(runGenericMock).not.toHaveBeenCalled();
  });

  it("a resumed run whose owner is the thread's user replays the thread", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead", user_id: "user-owner" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "run-paused",
          tenant_id: "tenant-A",
          agent_slug: "support-lead",
          trigger: "chat",
          status: "success",
          payload: { thread_id: "t1" },
        }),
      )
      .mockImplementationOnce(() => stubChain([{ id: "decision-approval" }]));
    await runChat(makeCtx({ userId: "user-owner" }), {
      thread_id: "t1",
      resume_of_run_id: "run-paused",
      internal_resume_turn: "Your proposed action was approved.",
    });
    expect(runGenericMock).toHaveBeenCalledTimes(1);
  });

  it("the owner's own turn passes the owner check", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead", user_id: "user-owner" }),
      )
      .mockImplementationOnce(() =>
        stubChain({ id: "u1", body: "hi", created_at: "2026-05-10T00:00:00Z", sender_role: "user", thread_id: "t1" }),
      );
    await runChat(makeCtx({ userId: "user-owner" }), { thread_id: "t1", user_message_id: "u1" });
    expect(runGenericMock).toHaveBeenCalledTimes(1);
  });

  it("throws on user_message thread mismatch", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "u1",
          body: "hi",
          created_at: "2026-05-10T00:00:00Z",
          sender_role: "user",
          thread_id: "DIFFERENT",
        }),
      );
    await expect(
      runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" }),
    ).rejects.toThrow(/user_message_id thread mismatch/);
  });

  it("accepts a validated internal approval-resume turn without a user message row", async () => {
    const resumeTurn =
      "Your proposed action `github__open_pr` was approved and executed. Result: https://github.com/acme/repo/pull/46";
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "run-paused",
          tenant_id: "tenant-A",
          agent_slug: "support-lead",
          trigger: "chat",
          status: "success",
          payload: { thread_id: "t1" },
        }),
      )
      .mockImplementationOnce(() => stubChain([{ id: "decision-approval" }]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]));

    await runChat(makeCtx(), {
      thread_id: "t1",
      resume_of_run_id: "run-paused",
      internal_resume_turn: resumeTurn,
    });

    expect(runGenericMock).toHaveBeenCalledTimes(1);
    const dispatchPayload = runGenericMock.mock.calls[0][1] as Record<string, unknown>;
    expect(dispatchPayload.current_message).toBe(resumeTurn);
    expect(dispatchPayload).not.toHaveProperty("internal_resume_turn");
    expect(dispatchPayload).not.toHaveProperty("resume_of_run_id");
  });

  it("rejects an internal approval-resume turn whose origin does not match the thread", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "run-paused",
          tenant_id: "tenant-A",
          agent_slug: "support-lead",
          trigger: "chat",
          status: "success",
          payload: { thread_id: "different-thread" },
        }),
      );

    await expect(
      runChat(makeCtx(), {
        thread_id: "t1",
        resume_of_run_id: "run-paused",
        internal_resume_turn: "approved",
      }),
    ).rejects.toThrow(/invalid internal approval-resume continuation/);
    expect(runGenericMock).not.toHaveBeenCalled();
  });

  it("rejects an internal resume whose origin never emitted an approval decision", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "run-ordinary",
          tenant_id: "tenant-A",
          agent_slug: "support-lead",
          trigger: "chat",
          status: "success",
          payload: { thread_id: "t1" },
        }),
      )
      .mockImplementationOnce(() => stubChain([]));

    await expect(
      runChat(makeCtx(), {
        thread_id: "t1",
        resume_of_run_id: "run-ordinary",
        internal_resume_turn: "approved",
      }),
    ).rejects.toThrow(/invalid internal approval-resume continuation/);
    expect(runGenericMock).not.toHaveBeenCalled();
  });

  function setupEnvelopeAgentChain(slug: string) {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: slug }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "u1",
          body: "fix the user model",
          created_at: "2026-05-10T00:01:00Z",
          sender_role: "user",
          thread_id: "t1",
        }),
      )
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]));
    return makeCtx({
      slug,
      tenant_id: "tenant-A",
      runId: "run-1",
    });
  }
  function withEnvelope(ctx: AgentContext, envelope: string): AgentContext {
    const agent = ctx.agent as never as {
      metadata_praxis: { requires_sandbox?: boolean; output_envelope?: string };
    };
    agent.metadata_praxis = {
      ...(agent.metadata_praxis ?? {}),
      output_envelope: envelope,
    } as never;
    return ctx;
  }

  function setupEngineerPreviewStateTurn(args: {
    userText: string;
    lastAssistantEnvelope: Record<string, unknown>;
    latestPreviewEnvelope: Record<string, unknown>;
    lastRunId?: string;
    latestRunId?: string;
  }): AgentContext {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "engineer" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "u1",
          body: args.userText,
          created_at: "2026-07-24T00:01:00Z",
          sender_role: "user",
          thread_id: "t1",
        }),
      )
      .mockImplementationOnce(() =>
        stubChain([
          {
            meta: { envelope: args.lastAssistantEnvelope },
            agent_run_id: args.lastRunId ?? "run-last",
          },
        ]),
      )
      .mockImplementationOnce(() =>
        stubChain([
          {
            meta: { envelope: args.latestPreviewEnvelope },
            agent_run_id: args.latestRunId ?? "run-preview",
          },
        ]),
      )
      .mockImplementationOnce(() => stubChain([]));
    return withEnvelope(makeCtx({ slug: "engineer" }), "pr_proposal");
  }

  function dispatchedPayload(): Record<string, unknown> {
    return runGenericMock.mock.calls[0]?.[1] as Record<string, unknown>;
  }

  describe("failed preview turn scope", () => {
    const failedEnvelope = {
      version: 2,
      kind: "html_preview",
      state: "html_preview_failed",
      failure_reason: "artifact_storage_failed",
      pending_html_preview: false,
    };

    it("normal question after failure remains a normal info turn", async () => {
      const ctx = setupEngineerPreviewStateTurn({
        userText: "Why did the preview fail?",
        lastAssistantEnvelope: { kind: "prose_fallback" },
        latestPreviewEnvelope: failedEnvelope,
      });

      await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });

      expect(dispatchedPayload()).toMatchObject({
        cto_chat_intent: "info",
        canonical_preview_state: "failed",
        preview_build_blocked: false,
        preview_retry_requested: false,
      });
    });

    it("build remains blocked after failure and intervening prose", async () => {
      const ctx = setupEngineerPreviewStateTurn({
        userText: "implement it now",
        lastAssistantEnvelope: { kind: "prose_fallback" },
        latestPreviewEnvelope: failedEnvelope,
      });

      await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });

      expect(dispatchedPayload()).toMatchObject({
        canonical_preview_state: "failed",
        preview_build_blocked: true,
        preview_retry_requested: false,
      });
    });

    it("explicit retry enters preview-only mode", async () => {
      const ctx = setupEngineerPreviewStateTurn({
        userText: "retry the preview",
        lastAssistantEnvelope: failedEnvelope,
        latestPreviewEnvelope: failedEnvelope,
      });

      await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });

      expect(dispatchedPayload()).toMatchObject({
        canonical_preview_state: "failed",
        preview_build_blocked: false,
        preview_retry_requested: true,
      });
    });

    it("successful retry clears the block and binds approval to the ready artifact", async () => {
      const readyEnvelope = {
        version: 2,
        kind: "html_preview",
        state: "html_preview_ready",
        title: "Fresh preview",
        summary: "Retry succeeded",
        preview_id: "550e8400-e29b-41d4-a716-446655440000",
        pending_html_preview: true,
      };
      loadReadyHtmlPreviewMock.mockResolvedValueOnce({
        row: { displayed_at: "2026-07-24T00:00:30Z" },
        html: "<main>Fresh preview</main>",
      });
      const ctx = setupEngineerPreviewStateTurn({
        userText: "looks good",
        lastAssistantEnvelope: readyEnvelope,
        latestPreviewEnvelope: readyEnvelope,
        lastRunId: "run-retry",
        latestRunId: "run-retry",
      });

      await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });

      expect(dispatchedPayload()).toMatchObject({
        canonical_preview_state: "ready",
        preview_build_blocked: false,
        preview_retry_requested: false,
        approved_design_contract: {
          text: expect.stringContaining("Fresh preview"),
        },
      });
    });
  });

  it("envelope_omitted: model gave prose without envelope tag (tool-cap repro)", async () => {
    const ctx = withEnvelope(setupEnvelopeAgentChain("engineer"), "pr_proposal");
    const prose =
      "The lateReturnUser boolean field is already fully implemented in the " +
      "rravi149/upcar repo. No PR is needed. Already in place: User model " +
      "interface, admin dashboard inline-edit row, backend update path.";
    runGenericMock.mockResolvedValueOnce({
      output_text: prose,
      parsed: null,
      parse_ok: false,
      parse_error: "tool_iter_cap",
      raw_response_text: prose,
      prompt_snapshot: "",
      usage: { input_tokens: 100, output_tokens: 100 },
    });

    await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });

    expect(rpcMock).toHaveBeenCalledWith(
      "record_agent_chat_reply",
      expect.objectContaining({
        p_run_id: "run-1",
        p_body: prose,
        p_meta: expect.objectContaining({ envelope_omitted: true }),
      }),
    );
    const [, args] = rpcMock.mock.calls[0] as [string, { p_meta: Record<string, unknown> }];
    expect(args.p_meta.parse_failed).toBeUndefined();
  });

  it("Case B is a soft success: chat prose reply clears parse_ok/parse_error so the run lands 'success', not 'parse_failed'", async () => {
    const ctx = withEnvelope(
      setupEnvelopeAgentChain("pm"),
      "product_pm_backlog",
    );
    const prose =
      "The upcar project is mid-migration: backend on EC2, web on Amplify. " +
      "No blocking incidents in the last 7 days. Nothing needs a PR right now.";
    runGenericMock.mockResolvedValueOnce({
      output_text: prose,
      parsed: null,
      parse_ok: false,
      parse_error:
        "no <product_pm_backlog>...</product_pm_backlog> block found",
      raw_response_text: prose,
      prompt_snapshot: "",
      usage: { input_tokens: 100, output_tokens: 100 },
    });

    const result = await runChat(ctx, {
      thread_id: "t1",
      user_message_id: "u1",
    });

    expect(result.parse_ok).toBe(true);
    expect(result.parse_error).toBeUndefined();

    const [, args] = rpcMock.mock.calls[0] as [
      string,
      { p_body: string; p_meta: Record<string, unknown> },
    ];
    expect(args.p_body).toBe(prose);
    expect(args.p_meta.envelope_omitted).toBe(true);
    expect(args.p_meta.parse_error).toBeUndefined();
    expect(args.p_meta.parse_failed).toBeUndefined();
    expect(args.p_meta.envelope_omitted_reason).toBe(
      "no <product_pm_backlog>...</product_pm_backlog> block found",
    );
  });

  it("qa envelope omission (prod run 88676be4): <drafts> without <digest> → meta.drafts extracted + category inferred + JSON stripped from bubble", async () => {
    const ctx = withEnvelope(setupEnvelopeAgentChain("qa"), "digest");
    const draftsJson =
      '[{"index":1,"title":"Guest checkout works","role":"guest","nl_spec":{"steps":["Open checkout","Pay"],"expected_outcome":"Order placed","preconditions":[]},"tags":["checkout"]}]';
    const raw =
      'I drafted 1 test case for checkout:\n\n1. Guest checkout works\n\nReply with "add all" or "skip" to confirm.\n\n' +
      `<drafts>\n${draftsJson}\n</drafts>`;
    runGenericMock.mockResolvedValueOnce({
      output_text: raw,
      parsed: { rendered_markdown: raw },
      parse_ok: true,
      raw_response_text: raw,
      prompt_snapshot: "",
      usage: { input_tokens: 100, output_tokens: 100 },
    });

    await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });

    const [, args] = rpcMock.mock.calls[0] as [
      string,
      { p_body: string; p_meta: Record<string, unknown> },
    ];
    expect(args.p_meta.drafts).toEqual(JSON.parse(draftsJson));
    expect(args.p_meta.envelope_category).toBe("qa-chat-add-draft");
    expect(args.p_body).not.toContain("<drafts>");
    expect(args.p_body).not.toContain("nl_spec");
    expect(args.p_body).toContain("Guest checkout works");
  });

  it("qa: a model-emitted tier4 category is NEVER overridden by drafts-presence inference", async () => {
    const ctx = withEnvelope(setupEnvelopeAgentChain("qa"), "digest");
    const draftsJson =
      '[{"index":1,"title":"Guest checkout works","role":"guest","nl_spec":{"steps":["Open checkout"],"expected_outcome":"Order placed","preconditions":[]},"tags":[]}]';
    const rendered = "Added 1 case to the catalog.";
    runGenericMock.mockResolvedValueOnce({
      output_text: rendered,
      parsed: {
        tier4: [{ category: "qa-chat-add-inserted", summary: "Added 1 case." }],
        rendered_markdown: rendered,
      },
      parse_ok: true,
      raw_response_text: `<digest>{}</digest>\n<drafts>\n${draftsJson}\n</drafts>`,
      prompt_snapshot: "",
      usage: { input_tokens: 100, output_tokens: 100 },
    });

    await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });

    const [, args] = rpcMock.mock.calls[0] as [
      string,
      { p_meta: Record<string, unknown> },
    ];
    expect(args.p_meta.envelope_category).toBe("qa-chat-add-inserted");
    expect(args.p_meta.drafts).toEqual(JSON.parse(draftsJson));
  });

  it("Case A: model emitted opening tag but JSON malformed → recovery message", async () => {
    const ctx = withEnvelope(setupEnvelopeAgentChain("engineer"), "pr_proposal");
    const halfEnvelope = '<pr_proposal>{"title":"Add lateRet';
    runGenericMock.mockResolvedValueOnce({
      output_text: halfEnvelope,
      parsed: null,
      parse_ok: false,
      parse_error: "JSON parse error at line 1",
      raw_response_text: halfEnvelope,
      prompt_snapshot: "",
      usage: { input_tokens: 100, output_tokens: 100 },
    });

    await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });

    const [, args] = rpcMock.mock.calls[0] as [
      string,
      { p_body: string; p_meta: Record<string, unknown> },
    ];
    expect(args.p_body).toContain("couldn't finish that one cleanly");
    expect(args.p_body).not.toContain("<pr_proposal>");
    expect(args.p_body).not.toContain("Runs");
    expect(args.p_meta.parse_failed).toBe(true);
    expect(args.p_meta.envelope_omitted).toBeUndefined();
    expect(args.p_meta.raw_output_preview).toBeDefined();
  });

  it("Case A honesty: schema-fail without truncation must NOT blame 'truncated'", async () => {
    const ctx = withEnvelope(setupEnvelopeAgentChain("engineer"), "pr_proposal");
    const completeButInvalid = '<pr_proposal>{"status":"no_signal"}</pr_proposal>';
    runGenericMock.mockResolvedValueOnce({
      output_text: completeButInvalid,
      parsed: null,
      parse_ok: false,
      parse_error: "schema validation: required field 'title' missing",
      raw_response_text: completeButInvalid,
      prompt_snapshot: "",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 100 },
    });

    await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });

    const [, args] = rpcMock.mock.calls[0] as [
      string,
      { p_body: string; p_meta: Record<string, unknown> },
    ];
    expect(args.p_body).not.toContain("ran long and got cut off");
    expect(args.p_body).toContain("couldn't finish that one cleanly");
    expect(args.p_meta.parse_failed).toBe(true);
  });

  it("Case A honesty: genuine max_tokens truncation still says 'cut off'", async () => {
    const ctx = withEnvelope(setupEnvelopeAgentChain("engineer"), "pr_proposal");
    const half = '<pr_proposal>{"title":"Add lateRet';
    runGenericMock.mockResolvedValueOnce({
      output_text: half,
      parsed: null,
      parse_ok: false,
      parse_error: "JSON parse error at line 1",
      raw_response_text: half,
      prompt_snapshot: "",
      stop_reason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 16000 },
    });

    await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });

    const [, args] = rpcMock.mock.calls[0] as [string, { p_body: string }];
    expect(args.p_body).toContain("ran long and got cut off");
  });

  it("Case B body cap: prose over 32000 chars is truncated to fit RPC limit", async () => {
    const ctx = withEnvelope(setupEnvelopeAgentChain("engineer"), "pr_proposal");
    const longProse = "x".repeat(40000);
    runGenericMock.mockResolvedValueOnce({
      output_text: longProse,
      parsed: null,
      parse_ok: false,
      parse_error: "tool_iter_cap",
      raw_response_text: longProse,
      prompt_snapshot: "",
      usage: { input_tokens: 100, output_tokens: 100 },
    });

    await runChat(ctx, { thread_id: "t1", user_message_id: "u1" });

    const [, args] = rpcMock.mock.calls[0] as [string, { p_body: string }];
    expect(args.p_body.length).toBe(32000);
  });

  it("happy path: builds prior_messages, calls runGeneric, persists reply via RPC", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "u1",
          body: "now what?",
          created_at: "2026-05-10T00:01:00Z",
          sender_role: "user",
          thread_id: "t1",
        }),
      )
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() =>
        stubChain([
          { sender_role: "assistant", body: "hi back", created_at: "2026-05-10T00:00:30Z" },
          { sender_role: "user", body: "hi", created_at: "2026-05-10T00:00:00Z" },
        ]),
      );

    await runChat(makeCtx(), { thread_id: "t1", user_message_id: "u1" });

    expect(runGenericMock).toHaveBeenCalledOnce();
    const [, payloadArg] = runGenericMock.mock.calls[0] as [
      AgentContext,
      { prior_messages: unknown[]; current_message: string },
    ];
    expect(payloadArg).toEqual({
      prior_messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hi back" },
      ],
      current_message: "now what?",
      current_user_text_raw: "now what?",
      owner_turn_texts: [],
    });
    expect(rpcMock).toHaveBeenCalledWith(
      "record_agent_chat_reply",
      expect.objectContaining({
        p_thread_id: "t1",
        p_tenant_id: "tenant-A",
        p_expected_agent_slug: "support-lead",
        p_run_id: "run-1",
        p_body: "ok",
      }),
    );
  });

  it("command_slug in payload: wraps current_message with instructions for this turn only", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "u1",
          body: "make this happen",
          created_at: "2026-05-10T00:01:00Z",
          sender_role: "user",
          thread_id: "t1",
        }),
      )
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() =>
        stubChain({
          instructions_md: "Always ask which state the host is in first.",
        }),
      )
      .mockImplementationOnce(() =>
        stubChain([
          { sender_role: "user", body: "hi", created_at: "2026-05-10T00:00:00Z" },
        ]),
      );

    await runChat(makeCtx(), {
      thread_id: "t1",
      user_message_id: "u1",
      command_slug: "onboard-host",
    });

    const [, payloadArg] = runGenericMock.mock.calls[0] as [
      AgentContext,
      { prior_messages: unknown[]; current_message: string },
    ];
    expect(payloadArg.current_message).toBe(
      "[Command: onboard-host]\nAlways ask which state the host is in first.\n\n" +
        "[User input]\nmake this happen",
    );
    expect(payloadArg.prior_messages).toEqual([
      { role: "user", content: "hi" },
    ]);
    expect(payloadArg).not.toHaveProperty("command_slug");
  });

  it("command_slug deleted between send and claim: falls through to raw user message (no error)", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "support-lead" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "u1",
          body: "do the thing",
          created_at: "2026-05-10T00:01:00Z",
          sender_role: "user",
          thread_id: "t1",
        }),
      )
      .mockImplementationOnce(() => stubChain(null))
      .mockImplementationOnce(() => stubChain([]));

    await runChat(makeCtx(), {
      thread_id: "t1",
      user_message_id: "u1",
      command_slug: "deleted-cmd",
    });

    const [, payloadArg] = runGenericMock.mock.calls[0] as [
      AgentContext,
      { current_message: string },
    ];
    expect(payloadArg.current_message).toBe("do the thing");
  });

  it("pm iterate detector: prior actionable run → mode='iterate' passed to runGeneric", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "pm" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "u1",
          body: "Here's more info — redo the backlog",
          created_at: "2026-05-10T00:01:00Z",
          sender_role: "user",
          thread_id: "t1",
        }),
      )
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([{ id: "prior-run-1" }]));

    await runChat(
      makeCtx({ slug: "pm", tenant_id: "tenant-A", runId: "run-2" }),
      { thread_id: "t1", user_message_id: "u1" },
    );

    expect(runGenericMock).toHaveBeenCalledOnce();
    const [, payloadArg] = runGenericMock.mock.calls[0] as [
      AgentContext,
      { mode?: string },
    ];
    expect(payloadArg.mode).toBe("iterate");
  });

  it("pm iterate detector: NO prior actionable run → mode='delivery' (not iterate)", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "pm" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "u1",
          body: "what should we ship?",
          created_at: "2026-05-10T00:01:00Z",
          sender_role: "user",
          thread_id: "t1",
        }),
      )
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]));

    await runChat(
      makeCtx({ slug: "pm", tenant_id: "tenant-A", runId: "run-1" }),
      { thread_id: "t1", user_message_id: "u1" },
    );

    expect(runGenericMock).toHaveBeenCalledOnce();
    const [, payloadArg] = runGenericMock.mock.calls[0] as [
      AgentContext,
      { mode?: string },
    ];
    expect(payloadArg.mode).toBe("delivery");
  });

  it("pm iterate detector: query error → fails safe to ITERATE (hold, don't dispatch)", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "pm" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "u1",
          body: "redo the backlog",
          created_at: "2026-05-10T00:01:00Z",
          sender_role: "user",
          thread_id: "t1",
        }),
      )
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([], { message: "db down" }));

    await runChat(
      makeCtx({ slug: "pm", tenant_id: "tenant-A", runId: "run-2" }),
      { thread_id: "t1", user_message_id: "u1" },
    );

    expect(runGenericMock).toHaveBeenCalledOnce();
    const [, payloadArg] = runGenericMock.mock.calls[0] as [
      AgentContext,
      { mode?: string },
    ];
    expect(payloadArg.mode).toBe("iterate");
  });

  it("pm iterate detector: post-processor receives augmented payload with mode='iterate' (PR #212)", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "pm" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "u1",
          body: "Here's more info — redo the backlog with this in mind",
          created_at: "2026-05-10T00:01:00Z",
          sender_role: "user",
          thread_id: "t1",
        }),
      )
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([{ id: "prior-run-1" }]));

    await runChat(
      makeCtx({ slug: "pm", tenant_id: "tenant-A", runId: "run-2" }),
      { thread_id: "t1", user_message_id: "u1" },
    );

    expect(runGenericMock).toHaveBeenCalledOnce();
    expect(postProcessorSpy).toHaveBeenCalledOnce();
    const [, runGenericPayload] = runGenericMock.mock.calls[0] as [
      AgentContext,
      { mode?: string },
    ];
    const [, , postProcessPayload] = postProcessorSpy.mock.calls[0] as unknown as [
      AgentContext,
      unknown,
      { mode?: string },
    ];
    expect(runGenericPayload.mode).toBe("iterate");
    expect(postProcessPayload.mode).toBe("iterate");
    expect(postProcessPayload).toBe(runGenericPayload);
  });

  it("post-processor receives augmented payload — delivery mode case (no prior artifact)", async () => {
    fromMock
      .mockImplementationOnce(() =>
        stubChain({ id: "t1", tenant_id: "tenant-A", agent_slug: "pm" }),
      )
      .mockImplementationOnce(() =>
        stubChain({
          id: "u1",
          body: "what should we ship?",
          created_at: "2026-05-10T00:01:00Z",
          sender_role: "user",
          thread_id: "t1",
        }),
      )
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]))
      .mockImplementationOnce(() => stubChain([]));

    await runChat(
      makeCtx({ slug: "pm", tenant_id: "tenant-A", runId: "run-1" }),
      { thread_id: "t1", user_message_id: "u1" },
    );

    expect(postProcessorSpy).toHaveBeenCalledOnce();
    const [, , payload] = postProcessorSpy.mock.calls[0] as unknown as [
      AgentContext,
      unknown,
      { mode?: string },
    ];
    expect(payload.mode).toBe("delivery");
  });
});
