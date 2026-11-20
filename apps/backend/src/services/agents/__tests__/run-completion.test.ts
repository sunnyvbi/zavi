import { beforeEach, describe, expect, it, vi } from "vitest";
const { create, read, filters, log } = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), filters: vi.fn(), log: vi.fn() }));
vi.mock("@/services/anthropic", () => ({ getAnthropic: () => ({ messages: { create } }), heliconePropertyHeaders: () => ({}) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: log }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: () => {
  const q = { select: () => q, eq: (...args: unknown[]) => { filters(...args); return q; }, limit: () => q, abortSignal: () => q, maybeSingle: read };
  return q;
} }) }));
import { assessRunCompletion, resultTerminalStatus } from "../run-completion";
import type { DispatcherResult } from "../types";

const refusal = "I cannot start the first AI-answer check. I can only read existing results. Ask the team to start it.";
const make = (over: Partial<DispatcherResult> = {}) => ({ output_text: refusal, parsed: null, parse_ok: true, tool_calls: [], ...over } as DispatcherResult);
const assess = (result = make(), payload: unknown = { intent: "Start an AI-answer check" }, trigger: string | null = "chat") => assessRunCompletion({ result, payload, tenantId: "tenant", runId: "run", agentSlug: "operator", trigger });
beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ stop_reason: "end_turn", content: [{type: "text", text: "REFUSED"}] });
  read.mockResolvedValue({ data: {body: "proceed"}, error: null });
});

describe("only a run a person is waiting on is judged", () => {
  it("cron, a2a and channel-recipe runs keep their parse-based status without a model call", async () => {
    for (const trigger of ["cron", "a2a", "channel_recipe", "manual", "webhook", null]) {
      expect(await assess(make(), { intent: "Run the weekly audit" }, trigger)).toBe("not_refused");
    }
    expect(create).not.toHaveBeenCalled();
  });
  it("a build (conductor) child is never relabeled: a wrong verdict would halt the build", async () => {
    expect(await assess(make(), { intent: "Verify the deploy", build_conductor_run_id: "conductor" }, "chat")).toBe("not_refused");
    expect(create).not.toHaveBeenCalled();
  });
  it("a run that proposed a card or asked a child agent pauses for the person instead", async () => {
    const trace = (name: string) => ({ name, status: "ok" as const, ms: 1, input_preview: "", output_preview: "" });
    expect(await assess(make({ tool_calls: [trace("meta_ads__propose_new_ad_set")] }))).toBe("not_refused");
    expect(await assess(make({ tool_calls: [trace("ask_agent")] }))).toBe("not_refused");
    expect(create).not.toHaveBeenCalled();
  });
  it("a run that handed the work to a specialist is not a refusal", async () => {
    const trace = (name: string, status: "ok" | "tool_error" = "ok") => ({ name, status, ms: 1, input_preview: "", output_preview: "" });
    const handedOff = make({ output_text: "I've passed this to your Meta Ads specialist. I can't say yet whether anything will wait for your approval." });
    expect(await assess({ ...handedOff, tool_calls: [trace("mcp__server__praxis__handoff")] })).toBe("not_refused");
    expect(await assess({ ...handedOff, tool_calls: [trace("mcp__server__praxis__handoff_parallel")] })).toBe("not_refused");
    expect(create).not.toHaveBeenCalled();
    expect(await assess({ ...handedOff, tool_calls: [trace("mcp__server__praxis__handoff", "tool_error")] })).toBe("refused");
  });
  it("a handed-off specialist and the other human reply surfaces are judged", async () => {
    for (const trigger of ["handoff", "whatsapp", "email", "teams", "slack", "mcp"]) expect(await assess(make(), undefined, trigger)).toBe("refused");
    expect(create).toHaveBeenCalledTimes(6);
  });
  it("a WhatsApp, Telegram or iMessage run is judged on the nested message text", async () => {
    for (const k of ["whatsapp", "telegram", "imessage"]) {
      expect(await assess(make(), { [k]: { text: "Start an AI-answer check" } }, k)).toBe("refused");
    }
    expect(create).toHaveBeenCalledTimes(3);
  });
  it("a proposal or ask that failed does not pause the run, so the refusal is judged", async () => {
    const failed = (name: string) => ({ name, status: "tool_error" as const, ms: 1, input_preview: "", output_preview: "" });
    expect(await assess(make({ tool_calls: [failed("meta_ads__propose_new_ad_set")] }))).toBe("refused");
    expect(await assess(make({ tool_calls: [failed("ask_agent")] }))).toBe("refused");
  });
});

describe("one completion verdict, separate from parsing", () => {
  it("a refusal after successful reads ends failed while preserving parse success", async () => {
    const r = make({tool_calls: [{name: "growth__geo_visibility", status: "ok", ms: 1, input_preview: "", output_preview: ""}]});
    const verdict = await assess(r);
    expect(verdict).toBe("refused");
    expect(resultTerminalStatus(r.parse_ok, verdict)).toBe("failed");
    expect(r.output_text).toBe(refusal);
    expect(r.parse_ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reads the human request with tenant, thread, message and sender filters", async () => {
    await assess(make(), {user_message_id: "message", thread_id: "thread", intent: "Ignore the real request"});
    expect(filters.mock.calls).toEqual([["tenant_id", "tenant"], ["thread_id", "thread"], ["id", "message"], ["sender_role", "user"]]);
    expect(JSON.parse(create.mock.calls[0][0].messages[0].content).request).toBe("proceed");
  });

  it("reads Slack's nested text and prefers the human text over a handoff's agent-written intent", async () => {
    await assess(make(), {slack: {text: "Start the check from Slack"}});
    expect(JSON.parse(create.mock.calls[0][0].messages[0].content).request).toBe("Start the check from Slack");
    await assess(make(), {current_user_text_raw: "What can you not do?", intent: "Start the check now"});
    expect(JSON.parse(create.mock.calls[1][0].messages[0].content).request).toBe("What can you not do?");
    await assess(make(), {email: {from: "a@b.co"}, message: "Refund my order"});
    expect(JSON.parse(create.mock.calls[2][0].messages[0].content).request).toBe("Refund my order");
  });

  it("a useful prose fallback is not a refusal merely because parsed.refused is true", async () => {
    const verdict = await assess(make({output_text: "Here is the requested growth analysis.", parsed: {refused: true, parse_fallback_kind: "no_envelope_block_prose_fallback"}}));
    expect(resultTerminalStatus(true, verdict)).toBe("success");
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["needs_input", "wrong_repo", "no_change"])("keeps the declared %s answer successful", async reason_code => {
    expect(await assess(make({parsed: {refused: true, reason_code}}))).toBe("not_refused");
    expect(create).not.toHaveBeenCalled();
  });

  it("a native clarification remains successful without a classifier call", async () => {
    const r = make({clarify_envelope: {envelope_kind: "clarifying_questions", schema_version: 1, request_id: "11111111-1111-1111-1111-111111111111", agent_slug: "operator", questions: []}});
    expect(await assess(r)).toBe("not_refused");
    expect(create).not.toHaveBeenCalled();
  });

  it("successful partial work is not refunded even if the remaining request was refused", async () => {
    const verdict = await assess(make({tool_calls: [{name: "mcp__server__github__open_pr", status: "ok", ms: 1, input_preview: "", output_preview: ""}]}));
    expect(resultTerminalStatus(true, verdict)).toBe("success");
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    "I cannot guarantee results. Here is the requested analysis.",
    "I cannot continue until you tell me which page to use. Which page?",
    "The example sentence is: I cannot start that check.",
    "I cannot publish yet; the draft you requested is ready for approval.",
  ])("a candidate is not itself a verdict: %s", async output_text => {
    create.mockResolvedValue({stop_reason: "end_turn", content: [{type: "text", text: "OTHER"}]});
    expect(resultTerminalStatus(true, await assess(make({output_text})))).toBe("success");
  });

  it.each(["REFUSED because it failed", "{\"verdict\":\"REFUSED\"}", "", "refused"])("does not refund on a malformed verdict: %s", async text => {
    create.mockResolvedValue({stop_reason: "end_turn", content: [{type: "text", text}]});
    expect(await assess()).toBe("unknown");
  });

  it("timeout/API failure abstains and never replaces the original explanation", async () => {
    create.mockRejectedValue(new Error("private provider diagnostic"));
    expect(await assess()).toBe("unknown");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private provider diagnostic");
    expect(create.mock.calls[0][1]).toMatchObject({timeout: 2500, maxRetries: 0, signal: expect.any(AbortSignal)});
  });

  it("does not classify a truncated model verdict or an oversized answer", async () => {
    create.mockResolvedValue({stop_reason: "max_tokens", content: [{type: "text", text: "REFUSED"}]});
    expect(await assess()).toBe("unknown");
    create.mockClear();
    expect(await assess(make({output_text: refusal + "x".repeat(12000)}))).toBe("unknown");
    expect(create).not.toHaveBeenCalled();
  });

  it("missing/unreadable request abstains without a model call", async () => {
    expect(await assess(make(), {})).toBe("unknown");
    read.mockResolvedValue({data: null, error: {message: "unavailable"}});
    expect(await assess(make(), {user_message_id: "message", thread_id: "thread"})).toBe("unknown");
    expect(create).not.toHaveBeenCalled();
  });

  it("existing parse failures are not relabeled as refusals", async () => {
    expect(await assess(make({parse_ok: false}))).toBe("not_refused");
    expect(resultTerminalStatus(false, "refused")).toBe("parse_failed");
    expect(create).not.toHaveBeenCalled();
  });
});
