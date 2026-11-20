import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import type { ToolCallTrace } from "@/services/tools/types";

const mockRunGeneric = vi.fn();
vi.mock("@/services/agents/generic-dispatcher", () => ({
  runGeneric: (...args: unknown[]) => mockRunGeneric(...args),
  writesSuppressed: () => false,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: vi.fn() }) }));
const logs = vi.hoisted(() => ({ logEvent: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: logs.logEvent }));
const cards = vi.hoisted(() => ({ rows: [] as Array<{ run_id: string; exec_class: string }> }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  tenantClient: () => {
    let run: string | null = null;
    const q = {
      select: () => q,
      eq: (k: string, v: string) => {
        if (k === "run_id") run = v;
        return q;
      },
      not: async () => ({ count: cards.rows.filter((r) => r.run_id === run).length, error: null }),
    };
    return { from: () => q };
  },
}));
vi.mock("@/services/channels/channel-actions", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/channel-actions")>()),
  switchedChannelForRun: async () => "email_marketing",
}));

import { createSideEffectDispatcher } from "@/agents/lib/side-effect-dispatcher";
import { topActionRetryPayload, withTopActionBrief } from "@/services/channels/top-actions";
import { resolveChannelExecEmit } from "@/services/channels/exec-emit";
import { estimateCostUsd } from "@/services/anthropic";
import { MODELS } from "@/services/llm/models";

const LIST = "8f0c3c1e-2b1a-4c55-9d1e-4b7f1b2a9c10";
const payload = {
  channel_slug: "email_marketing",
  top_action: { key: "new_email", inputs: { route: "zavi_list", list_id: LIST, brief: "Our spring sale starts Friday" }, instruction: "x", by: "u1" },
};

const call = (over: Partial<ToolCallTrace>): ToolCallTrace => ({ name: "email__propose_campaign", input_preview: "{}", output_preview: "{}", ms: 1, status: "ok", ...over });
const read = call({ name: "outbound__list_email_lists" });
const errPreview = (code: string, message: string) => JSON.stringify(JSON.stringify({ error: code, message }));
const okBlocks = (body: unknown) => JSON.stringify([{ type: "text", text: JSON.stringify(body) }]);
const AUD = "aud_9f2";
const toolPayload = {
  channel_slug: "email_marketing",
  top_action: { key: "new_email", inputs: { route: "mailchimp", list_id: AUD, brief: "Our spring sale starts Friday" }, instruction: "x", by: "u1" },
};

function result(tool_calls: ToolCallTrace[], over: Partial<DispatcherResult> = {}): DispatcherResult {
  return {
    output_text: "done",
    parsed: { rendered_markdown: "done", steps: [] },
    parse_ok: true,
    raw_response_text: "",
    prompt_snapshot: "",
    usage: { input_tokens: 100, output_tokens: 10, cost_usd: 0.5 },
    tool_calls,
    ...over,
  };
}

const ctx = () => ({ emitDecision: vi.fn(), tenant_id: "t1", runId: "r1" }) as unknown as AgentContext;
const dispatcher = () =>
  createSideEffectDispatcher({ slug: "email_marketing", decisionClass: "channel.recipe_step", shouldEmit: () => false });

beforeEach(() => {
  mockRunGeneric.mockReset();
  cards.rows = [];
});

describe("Write it (new_email) that files no card", () => {
  it("does not retry a tool refusal a second try cannot change, and keeps the refusal as the run's answer", async () => {
    const refused = result([read, call({ status: "tool_error", code: "bulk_sender_not_configured" })], {
      output_text: 'The campaign tool refused with "Bulk email is not set up yet", so the email wasn\'t proposed.',
    });
    mockRunGeneric.mockResolvedValueOnce(refused);
    const out = await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(1);
    expect(out.output_text).toContain("Bulk email is not set up yet");
  });

  for (const code of ["email_test_list", "list_not_consented", "list_empty", "sending_domain_not_verified"]) {
    it(`does not retry ${code}`, async () => {
      mockRunGeneric.mockResolvedValueOnce(result([call({ status: "tool_error", code })]));
      await dispatcher()(ctx(), payload);
      expect(mockRunGeneric).toHaveBeenCalledTimes(1);
    });
  }

  it("retries once when the model held the email back on its own, with the directive in the run's input, and adds both tries' cost", async () => {
    mockRunGeneric.mockResolvedValueOnce(result([read], { output_text: "The list has only two people, so I did not write it." }));
    mockRunGeneric.mockResolvedValueOnce(result([call({ status: "ok" })], { output_text: "Filed the email.", usage: { input_tokens: 50, output_tokens: 5, cost_usd: 0.25 } }));
    const out = await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(2);
    const second = mockRunGeneric.mock.calls[1][1] as typeof payload & { top_action: { retry?: boolean } };
    expect(second.top_action.retry).toBe(true);
    expect(second.top_action.inputs).toEqual(payload.top_action.inputs);
    expect(withTopActionBrief(second, "TURN")).toMatch(/## Second try[\s\S]*only a refusal from the tool stops it[\s\S]*TURN$/);
    expect(withTopActionBrief(payload, "TURN")).not.toContain("Second try");
    expect(out.output_text).toBe("Filed the email.");
    expect(out.usage).toMatchObject({ input_tokens: 150, output_tokens: 15, cost_usd: 0.75 });
    expect(out.tool_calls).toHaveLength(2);
  });

  it("retries a mismatch the model can fix (wrong list), and never a third time", async () => {
    mockRunGeneric.mockResolvedValue(result([call({ status: "tool_error", code: "email_wrong_list" })]));
    await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the card was filed", async () => {
    mockRunGeneric.mockResolvedValueOnce(result([read, call({ name: "mcp__server__email__propose_campaign", status: "ok" })]));
    await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(1);
  });

  it("does not retry a first try the dispatcher stopped at the daily spend cap or on a Stop", async () => {
    for (const over of [{ parse_error: "budget_cap", parse_ok: false }, { stop_reason: "budget_exceeded" }] as Partial<DispatcherResult>[]) {
      mockRunGeneric.mockReset();
      mockRunGeneric.mockResolvedValue(result([read], over));
      const out = await dispatcher()(ctx(), payload);
      expect(mockRunGeneric).toHaveBeenCalledTimes(1);
      expect(out.tool_calls).toHaveLength(1);
    }
  });

  it("does not retry any other run", async () => {
    mockRunGeneric.mockResolvedValueOnce(result([]));
    await dispatcher()(ctx(), { channel_slug: "email_marketing" });
    expect(mockRunGeneric).toHaveBeenCalledTimes(1);
    expect(topActionRetryPayload({ channel_slug: "x_organic", top_action: { key: "new_post", inputs: { topic: "launch" }, instruction: "x", by: "u1" } }, [])).toBeNull();
  });

  it("a client cannot pre-arm the retry through inputs", () => {
    const sneaky = { ...payload, top_action: { ...payload.top_action, inputs: { ...payload.top_action.inputs, retry: true } } };
    expect(withTopActionBrief(sneaky, "TURN")).not.toContain("Second try");
  });
});

describe("a refusal from any call of the run ends it", () => {
  it("does not retry when Zavi could not count the cards already filed (the tool says stop here)", async () => {
    mockRunGeneric.mockResolvedValueOnce(result([read, call({ status: "tool_error", code: "email_card_count_unavailable" })]));
    await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(1);
  });

  it("reads the code from the tool's error body when the trace carries none (the SDK path)", async () => {
    mockRunGeneric.mockResolvedValueOnce(
      result([read, call({ status: "tool_error", output_preview: errPreview("bulk_sender_not_configured", "Bulk email is not set up yet.") })]),
    );
    await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the card cap says the card is already filed", async () => {
    mockRunGeneric.mockResolvedValueOnce(result([call({ status: "tool_error", output_preview: errPreview("top_action_cap", "This action files 1 card and it is already filed.") })]));
    await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(1);
  });

  it("does not retry when list_audiences says no email tool is connected, and the propose tool was never called", async () => {
    const notConnected = call({ name: "mcp__server__email_campaign__list_audiences", status: "tool_error", output_preview: errPreview("email_tool_not_connected", "No email tool is connected for this workspace.") });
    mockRunGeneric.mockResolvedValueOnce(result([notConnected]));
    await dispatcher()(ctx(), toolPayload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(1);
  });

  it("a not-connected email tool does not stop a Zavi-list email, which never uses it", async () => {
    const notConnected = call({ name: "email_campaign__list_audiences", status: "tool_error", output_preview: errPreview("email_tool_not_connected", "No email tool is connected.") });
    mockRunGeneric.mockResolvedValueOnce(result([notConnected]));
    mockRunGeneric.mockResolvedValueOnce(result([call({ status: "ok" })]));
    await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(2);
  });

  for (const [label, message] of [
    ["SendGrid refused the key", "SendGrid could not be read: SendGrid refused the key (it was removed, or lacks a permission)."],
    ["Mailchimp API Key Invalid", 'Mailchimp could not be read: {"title":"API Key Invalid","status":401,"detail":"Your API key may be invalid, or you\'ve attempted to access the wrong datacenter."}'],
    ["Klaviyo not_authenticated", 'Klaviyo could not be read: {"errors":[{"code":"not_authenticated","detail":"Incorrect authentication credentials."}]}'],
  ] as const) {
    it(`does not retry a read the tool refused because it rejected the key (${label})`, async () => {
      const rejected = call({ name: "email_campaign__list_audiences", status: "tool_error", output_preview: errPreview("email_tool_read_failed", message) });
      mockRunGeneric.mockResolvedValueOnce(result([rejected]));
      await dispatcher()(ctx(), toolPayload);
      expect(mockRunGeneric).toHaveBeenCalledTimes(1);
    });
  }

  it("does retry a read that failed for a passing reason", async () => {
    const blip = call({ name: "email_campaign__list_audiences", status: "tool_error", output_preview: errPreview("email_tool_read_failed", "Mailchimp could not be read: HTTP 503") });
    mockRunGeneric.mockResolvedValueOnce(result([blip]));
    mockRunGeneric.mockResolvedValueOnce(result([call({ status: "ok" })]));
    await dispatcher()(ctx(), toolPayload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the picked email-tool list has nobody on it", async () => {
    const lists = call({ name: "email_campaign__list_audiences", output_preview: okBlocks({ tool: "mailchimp", audiences: [{ id: "other", name: "All", member_count: 40 }, { id: AUD, name: "VIP", member_count: 0 }] }) });
    mockRunGeneric.mockResolvedValueOnce(result([lists]));
    await dispatcher()(ctx(), toolPayload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(1);
  });

  it("does not retry a Zavi-list email when outbound__list_email_lists says bulk email is not ready", async () => {
    const lists = call({ name: "outbound__list_email_lists", output_preview: okBlocks({ lists: [{ id: LIST, name: "News", people: 3, can_be_emailed: 3, unsubscribed_or_bounced: 0, ready_to_send: true, not_ready_because: null }], bulk_email_ready: false, from_address: null, missing: ["Verify a sending domain."] }) });
    mockRunGeneric.mockResolvedValueOnce(result([lists]));
    await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(1);
  });

  it("does not retry a Zavi-list email when the picked list is not ready to send, and does when only another list is", async () => {
    const body = (ready: boolean) => ({ lists: [{ id: LIST, name: "News", people: 3, can_be_emailed: 0, unsubscribed_or_bounced: 3, ready_to_send: ready, not_ready_because: ready ? null : "Everyone on it is unsubscribed or bounced." }, { id: "other", name: "Old", people: 9, can_be_emailed: 0, unsubscribed_or_bounced: 9, ready_to_send: false, not_ready_because: "x" }], bulk_email_ready: true, from_address: "a@b.example", missing: [] });
    mockRunGeneric.mockResolvedValueOnce(result([call({ name: "outbound__list_email_lists", output_preview: okBlocks(body(false)) })]));
    await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(1);
    mockRunGeneric.mockReset();
    mockRunGeneric.mockResolvedValueOnce(result([call({ name: "outbound__list_email_lists", output_preview: okBlocks(body(true)) })]));
    mockRunGeneric.mockResolvedValueOnce(result([call({ status: "ok" })]));
    await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(2);
  });

  it("bulk email not being ready does not stop an email to the founder's own email tool", async () => {
    const lists = call({ name: "outbound__list_email_lists", output_preview: okBlocks({ lists: [], bulk_email_ready: false, from_address: null, missing: ["x"] }) });
    mockRunGeneric.mockResolvedValueOnce(result([lists]));
    mockRunGeneric.mockResolvedValueOnce(result([call({ status: "ok" })]));
    await dispatcher()(ctx(), toolPayload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(2);
  });
});

describe("the second try going wrong", () => {
  const heldBack = () => result([read], { output_text: "The list has only two people, so I did not write it.", usage: { input_tokens: 100, output_tokens: 10, cost_usd: 0.5 } });

  it("keeps the first try's answer, tokens and calls when the second try throws", async () => {
    mockRunGeneric.mockResolvedValueOnce(heldBack());
    mockRunGeneric.mockRejectedValueOnce(new Error("sdk_run_ceiling: the run hit its 25-minute time limit and was stopped"));
    const out = await dispatcher()(ctx(), payload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(2);
    expect(out.output_text).toBe("The list has only two people, so I did not write it.");
    expect(out.usage).toEqual({ input_tokens: 100, output_tokens: 10, cost_usd: 0.5 });
    expect(out.tool_calls).toEqual([read]);
  });

  it("the second try's budget gate counts what the first try spent (one shared daily headroom), then the context is restored", async () => {
    mockRunGeneric.mockResolvedValueOnce(heldBack());
    let seen: number | undefined;
    mockRunGeneric.mockImplementationOnce(async (c: AgentContext) => {
      seen = c.priorPassSpendUsd;
      return heldBack();
    });
    const c = ctx();
    await dispatcher()(c, payload);
    expect(seen).toBe(0.5);
    expect(c.priorPassSpendUsd).toBeUndefined();
  });

  it("records that the second try's spend is missing from the run's cost, keyed to the run", async () => {
    logs.logEvent.mockClear();
    mockRunGeneric.mockResolvedValueOnce(heldBack());
    mockRunGeneric.mockRejectedValueOnce(new Error("sdk_run_ceiling: the run hit its 25-minute time limit and was stopped"));
    await dispatcher()(ctx(), payload);
    expect(logs.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", code: "top_action.second_pass_failed", tenant_id: "t1", run_id: "r1", meta: expect.objectContaining({ stage: "top_action_retry", error_class: "Error" }) }),
    );
  });

  for (const code of ["run_cancelled", "kill_switch"]) {
    it(`lets a ${code} stop through`, async () => {
      mockRunGeneric.mockResolvedValueOnce(heldBack());
      mockRunGeneric.mockRejectedValueOnce(new Error(code));
      await expect(dispatcher()(ctx(), payload)).rejects.toThrow(code);
    });
  }
});

describe("the cost of both tries", () => {
  const MODEL = MODELS.anthropic.sonnet;
  const agentCtx = () => ({ emitDecision: vi.fn(), tenant_id: "t1", runId: "r1", agent: { slug: "email_marketing", metadata_praxis: { model: MODEL } } }) as unknown as AgentContext;
  const tokens = { input_tokens: 2000, output_tokens: 300, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 };
  const routing = (model: string, classifier_cost_usd: number) =>
    ({ model, picked_tier: "sonnet", picked_depth: "light", picked_model: model, reason_code: "x", classifier_ms: 5, classifier_cost_usd, effective: true }) as unknown as DispatcherResult["routing"];

  it("prices the pass with no SDK total at its model when the other pass has one", async () => {
    mockRunGeneric.mockResolvedValueOnce(result([read], { usage: { input_tokens: 100, output_tokens: 10, cost_usd: 0.5 } }));
    mockRunGeneric.mockResolvedValueOnce(result([call({ status: "ok" })], { usage: { ...tokens } }));
    const out = await dispatcher()(agentCtx(), payload);
    const est = estimateCostUsd(MODEL, tokens);
    expect(est).toBeGreaterThan(0);
    expect(out.usage.cost_usd).toBeCloseTo(0.5 + est, 10);
  });

  it("prices the first pass at its routed model when only the second has a total", async () => {
    const routed = MODELS.anthropic.opus;
    mockRunGeneric.mockResolvedValueOnce(result([read], { usage: { ...tokens }, routing: routing(routed, 0.01) }));
    mockRunGeneric.mockResolvedValueOnce(result([call({ status: "ok" })], { usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.25 }, routing: routing(routed, 0.02) }));
    const out = await dispatcher()(agentCtx(), payload);
    expect(out.usage.cost_usd).toBeCloseTo(estimateCostUsd(routed, tokens) + 0.25, 10);
    expect(out.routing?.classifier_cost_usd).toBeCloseTo(0.03, 10);
  });

  it("keeps the first pass's classifier cost when only it was routed", async () => {
    mockRunGeneric.mockResolvedValueOnce(result([read], { routing: routing(MODEL, 0.01) }));
    mockRunGeneric.mockResolvedValueOnce(result([call({ status: "ok" })]));
    const out = await dispatcher()(agentCtx(), payload);
    expect(out.routing?.classifier_cost_usd).toBeCloseTo(0.01, 10);
  });

  it("leaves cost to the runner when neither pass has a total", async () => {
    mockRunGeneric.mockResolvedValueOnce(result([read], { usage: { input_tokens: 1, output_tokens: 1 } }));
    mockRunGeneric.mockResolvedValueOnce(result([call({ status: "ok" })], { usage: { input_tokens: 2, output_tokens: 2 } }));
    const out = await dispatcher()(agentCtx(), payload);
    expect(out.usage.cost_usd).toBeUndefined();
    expect(out.usage).toMatchObject({ input_tokens: 3, output_tokens: 3 });
  });
});

describe("no second card", () => {
  it("a second propose after the first try filed its card is refused by the run's card cap", async () => {
    const write = vi.fn(async (a: { run_id: string; decision_class: string }) => {
      cards.rows.push({ run_id: a.run_id, exec_class: a.decision_class });
      return `card-${cards.rows.length}`;
    });
    const scope = vi.fn(async () => ({ channel_slug: "email_marketing", top_action: toolPayload.top_action }));
    const refusals: unknown[] = [];
    const pass = async (c: AgentContext, firstTry: boolean): Promise<DispatcherResult> => {
      const emit = await resolveChannelExecEmit(new Set(["email_marketing"]), { tenant_id: c.tenant_id, run_id: c.runId, emit_decision: vi.fn(async () => "legacy"), top_action_run: true }, write, scope);
      try {
        await emit!("email_campaign.create_and_send", { tool: "mailchimp", audience_id: AUD, variants: [] });
      } catch (e) {
        refusals.push(e);
        return result([call({ status: "tool_error", output_preview: errPreview((e as { code: string }).code, (e as Error).message) })]);
      }
      return result([call({ status: "tool_error", output_preview: firstTry ? JSON.stringify("Tool call timed out") : "{}" })]);
    };
    mockRunGeneric.mockImplementationOnce((c: AgentContext) => pass(c, true));
    mockRunGeneric.mockImplementationOnce((c: AgentContext) => pass(c, false));
    await dispatcher()(ctx(), toolPayload);
    expect(mockRunGeneric).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(cards.rows).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ code: "top_action_cap" });
  });
});
