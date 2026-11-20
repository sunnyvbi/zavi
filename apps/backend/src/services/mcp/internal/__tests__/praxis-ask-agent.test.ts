import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn() }));
vi.mock("@/services/agents/entitlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: async () => ({ enforced: false, tier: "free", required_tier: "free", allowed: true }),
}));
vi.mock("@/services/agents/visibility", () => ({ getVisibleAgentSlugs: vi.fn() }));
vi.mock("@/services/decisions/operator-action-execute", () => ({ executeOperatorAction: vi.fn() }));
vi.mock("@/agents/engineer/decompose", () => ({ decomposeMessage: vi.fn() }));
vi.mock("@/services/sandbox/repo-picker", () => ({ pickRepoForTask: vi.fn() }));
vi.mock("@/services/sandbox/repo-access-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sandbox/repo-access-gate")>()),
  isUmbrellaProvisionedTenant: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/services/agents/refine-product", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/refine-product")>()),
  refineProduct: vi.fn(),
}));
vi.mock("@/services/agents/schedules", () => ({ getSchedule: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  LOG_META_KEYS: ["agent_slug"],
}));
vi.mock("@/services/agents/pm-interactive-handoff-flag", () => ({
  isPmInteractiveHandoffEnabled: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/services/agents/_render-launch-video-flag-check", () => ({
  isRenderLaunchVideoEnabled: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/services/agents/custom-agent-writes", () => ({
  resolveCustomWriteRun: vi.fn(async () => ({ state: "not_custom" })),
}));
vi.mock("@/services/agents/custom-agent-decisions", () => ({ handCustomDecisionToHuman: vi.fn() }));
vi.mock("@/services/channels/direct-run", () => ({
  admitDirectChannelRun: vi.fn(async (_tenant: string, slug: string) => ({
    allowed: true, channel_slug: slug === "chatgpt_ads" ? "chatgpt_ads" : null,
  })),
  stampDirectChannelRun: vi.fn(async () => true),
  stampDirectChannelRunWithin: vi.fn(async () => true),
}));

const flags = vi.hoisted(() => ({ askEnabled: true, forwarding: true }));
vi.mock("@/services/agents/ask-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/ask-agent")>()),
  isAskAgentEnabled: async () => flags.askEnabled,
}));
vi.mock("@/services/agents/a2a-attachment-forwarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/a2a-attachment-forwarding")>()),
  isA2aAttachmentForwardingEnabled: async () => flags.forwarding,
}));

const state = vi.hoisted(() => ({
  runPayload: {} as Record<string, unknown>,
  askInserts: [] as Array<Record<string, unknown>>,
  askInsertError: null as null | { code?: string; message: string },
  askUpdates: [] as Array<Record<string, unknown>>,
  askDeletes: 0,
  runUpdates: [] as Array<Record<string, unknown>>,
  priorAsk: { id: "ask-0", target_agent_slug: "seo", child_run_id: "child-0" } as Record<string, unknown>,
  dedupedRun: null as null | { id: string },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: [{ max_depth: 0, target_slugs: [], cumulative_cost: 0 }], error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      let mode: "select" | "insert" | "update" | "delete" = "select";
      let row: Record<string, unknown> = {};
      let sel = "";
      const chain = () => b;
      b.select = (c?: string) => {
        sel = c ?? "";
        return b;
      };
      b.eq = chain;
      b.is = chain;
      b.order = chain;
      b.limit = chain;
      b.insert = (r: Record<string, unknown>) => {
        mode = "insert";
        row = r;
        if (table === "agent_asks") state.askInserts.push(r);
        return b;
      };
      b.update = (r: Record<string, unknown>) => {
        mode = "update";
        row = r;
        if (table === "agent_asks") state.askUpdates.push(r);
        if (table === "agent_runs") state.runUpdates.push(r);
        return b;
      };
      b.delete = () => {
        mode = "delete";
        if (table === "agent_asks") state.askDeletes++;
        return b;
      };
      b.single = async () => {
        if (table === "agent_asks" && mode === "insert") {
          return state.askInsertError
            ? { data: null, error: state.askInsertError }
            : { data: { id: "ask-1" }, error: null };
        }
        return { data: null, error: null };
      };
      b.maybeSingle = async () => {
        if (table === "agent_runs" && state.dedupedRun && sel === "id") return { data: state.dedupedRun, error: null };
        if (table === "agent_runs") return { data: { payload: state.runPayload }, error: null };
        if (table === "agent_asks") return { data: state.priorAsk, error: null };
        return { data: null, error: null };
      };
      b.then = (onF: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onF);
      void row;
      return b;
    },
  }),
}));
const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../../../../workers/client", () => ({
  inngest: {
    send: async (e: Record<string, unknown>) => {
      sent.push(e);
      return { ids: ["evt"] };
    },
  },
}));

import { callPraxisTool, listPraxisTools } from "../praxis";
import { enqueueAgentRun } from "@/services/agents/runner";
import { getVisibleAgentSlugs } from "@/services/agents/visibility";

const enqueueMock = enqueueAgentRun as unknown as ReturnType<typeof vi.fn>;
const visibleMock = getVisibleAgentSlugs as unknown as ReturnType<typeof vi.fn>;

const chatCtx = {
  tenant_id: "t1",
  run_id: "parent-1",
  agent_slug: "operator",
  trigger: "chat",
  chat_thread_id: "th1",
  user_id: "u1",
  tool_use_id: "toolu_1",
};
const args = { target_agent_slug: "seo", intent: "Where do we rank for 'car rental la'?" };
const body = (s: string) => JSON.parse(s) as Record<string, unknown>;

beforeEach(() => {
  flags.askEnabled = true;
  flags.forwarding = true;
  state.runPayload = { user_message: "where do we rank?" };
  state.askInserts.length = 0;
  state.askInsertError = null;
  state.askUpdates.length = 0;
  state.askDeletes = 0;
  state.runUpdates.length = 0;
  state.priorAsk = { id: "ask-0", target_agent_slug: "seo", child_run_id: "child-0" };
  state.dedupedRun = null;
  sent.length = 0;
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue({ run_id: "child-1" });
  visibleMock.mockReset();
  visibleMock.mockResolvedValue(new Set(["operator", "seo", "pm", "engineer"]));
});

describe("praxis__ask_agent", () => {
  it.each(["handoff", "ask_agent"])("%s preserves the admitted channel alongside the generic user intent", async (tool) => {
    const intent = "Suggest a few ads options for our company";
    const result = await callPraxisTool(chatCtx, tool, { target_agent_slug: "chatgpt_ads", intent });
    expect(result.is_error).toBe(false);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0]).toMatchObject({
      agent_slug: "chatgpt_ads", trigger: "handoff",
      payload: { channel_slug: "chatgpt_ads", intent, operator_thread_id: "th1" },
    });
  });

  it("is listed as a WRITE tool with a plain object schema", () => {
    const t = listPraxisTools().find((x) => x.tool_name === "ask_agent");
    expect(t).toBeDefined();
    expect(t!.effect).toBe("write");
    expect(t!.input_schema.type).toBe("object");
  });

  it("chat: records the ask, enqueues the child with server-side correlation, schedules the deadline", async () => {
    const res = await callPraxisTool(chatCtx, "ask_agent", args);
    expect(res.is_error).toBe(false);
    expect(body(res.content)).toMatchObject({ ok: true, waiting: true, run_id: "child-1", target: "seo" });
    expect(String(body(res.content).message)).toContain("END YOUR TURN");

    expect(state.askInserts).toHaveLength(1);
    expect(state.askInserts[0]).toMatchObject({
      tenant_id: "t1",
      parent_run_id: "parent-1",
      target_agent_slug: "seo",
      tool_use_id: "toolu_1",
      surface: "chat",
    });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enq = enqueueMock.mock.calls[0][0];
    expect(enq.trigger).toBe("handoff");
    expect(enq.agent_slug).toBe("seo");
    expect(enq.payload).toMatchObject({
      operator_thread_id: "th1",
      ask_id: "ask-1",
      ask_parent_run_id: "parent-1",
      ask_depth: 1,
    });
    expect(state.askUpdates).toContainEqual({ child_run_id: "child-1" });
    expect(state.runUpdates.some((u) => (u.payload as Record<string, unknown>)?.ask_waiting_on === "seo")).toBe(true);
    const dl = sent.find((e) => e.name === "agent.ask.deadline");
    expect(dl).toMatchObject({ id: "ask-deadline-ask-1", data: { ask_id: "ask-1" } });
  });

  it("depth guard is read from the run row, not the model: an asked child cannot ask", async () => {
    state.runPayload = { ask_depth: 1, ask_id: "x", ask_parent_run_id: "p" };
    const res = await callPraxisTool(chatCtx, "ask_agent", args);
    expect(body(res.content).error).toBe("ask_agent_depth");
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(state.askInserts).toHaveLength(0);
  });

  it("a continuation that already carries the answer cannot ask again", async () => {
    state.runPayload = { ask_resumed: true, ask_id: "ask-0", resume_of_run_id: "p0" };
    const res = await callPraxisTool(chatCtx, "ask_agent", args);
    expect(body(res.content).error).toBe("ask_agent_depth");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a hidden target is refused", async () => {
    const res = await callPraxisTool(chatCtx, "ask_agent", { ...args, target_agent_slug: "browser-operator" });
    expect(body(res.content).error).toBe("ask_agent_target_invalid");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a heavy build target is refused (use handoff)", async () => {
    const res = await callPraxisTool(chatCtx, "ask_agent", { ...args, target_agent_slug: "engineer" });
    expect(body(res.content).error).toBe("ask_agent_target_invalid");
    expect(String(body(res.content).message)).toContain("praxis__handoff");
  });

  it("self / operator target is refused", async () => {
    const res = await callPraxisTool(chatCtx, "ask_agent", { ...args, target_agent_slug: "operator" });
    expect(body(res.content).error).toBe("ask_agent_self_loop");
  });

  it("kill switch off → typed not-available, nothing enqueued", async () => {
    flags.askEnabled = false;
    const res = await callPraxisTool(chatCtx, "ask_agent", args);
    expect(body(res.content).error).toBe("ask_agent_unavailable");
    expect(String(body(res.content).message)).toContain("praxis__handoff");
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(state.askInserts).toHaveLength(0);
  });

  it("non-operator callers are refused by the same gate as handoff", async () => {
    const res = await callPraxisTool({ ...chatCtx, agent_slug: "seo" }, "ask_agent", { ...args, target_agent_slug: "pm" });
    expect(body(res.content).error).toBe("ask_agent_not_authorized");
  });

  it("an MCP ask (no conversation to resume) is refused", async () => {
    const res = await callPraxisTool({ ...chatCtx, trigger: "mcp", chat_thread_id: undefined }, "ask_agent", args);
    expect(body(res.content).error).toBe("ask_agent_unavailable");
  });

  it("Slack: forwards the user's Slack images to the child (problem #5)", async () => {
    const images = [{ url: "https://files.slack.com/a.png", mimetype: "image/png", name: "a.png", size: 10 }];
    state.runPayload = { slack: { channel_id: "C1", thread_ts: "1.0", event_id: "ev1", team_id: "T1", images, text: "see this" } };
    const slack_routing = { channel_id: "C1", thread_ts: "1.0", original_ts: "1.0", event_id: "ev1", team_id: "T1" };
    const res = await callPraxisTool({ ...chatCtx, trigger: "slack", chat_thread_id: undefined, slack_routing }, "ask_agent", args);
    expect(res.is_error).toBe(false);
    const enq = enqueueMock.mock.calls[0][0];
    expect(enq.trigger).toBe("slack");
    expect(enq.payload.slack_handoff_child).toBe(true);
    expect(enq.payload.slack).toMatchObject({ ...slack_routing, images });
  });

  it("Slack images are not forwarded with the forwarding flag off", async () => {
    flags.forwarding = false;
    state.runPayload = { slack: { images: [{ url: "https://files.slack.com/a.png", mimetype: "image/png" }] } };
    const slack_routing = { channel_id: "C1", thread_ts: "1.0", original_ts: "1.0", event_id: "ev1" };
    await callPraxisTool({ ...chatCtx, trigger: "slack", chat_thread_id: undefined, slack_routing }, "ask_agent", args);
    expect(enqueueMock.mock.calls[0][0].payload.slack.images).toBeUndefined();
  });

  it("enqueue refused → the ask row is removed so the parent never pauses on nothing", async () => {
    enqueueMock.mockRejectedValue(new Error("insufficient credits"));
    const res = await callPraxisTool(chatCtx, "ask_agent", args);
    expect(body(res.content).error).toBe("ask_agent_enqueue_failed");
    expect(state.askDeletes).toBe(1);
    expect(sent.find((e) => e.name === "agent.ask.deadline")).toBeUndefined();
  });

  it("a second ask in the same run (unique parent) does not enqueue a second child", async () => {
    state.askInsertError = { code: "23505", message: "duplicate" };
    const res = await callPraxisTool(chatCtx, "ask_agent", args);
    expect(body(res.content)).toMatchObject({ ok: true, waiting: true });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a retry after the ask row committed but before the child was enqueued finishes the enqueue", async () => {
    state.askInsertError = { code: "23505", message: "duplicate" };
    state.priorAsk = { id: "ask-0", target_agent_slug: "seo", child_run_id: null };
    const res = await callPraxisTool(chatCtx, "ask_agent", args);
    expect(body(res.content)).toMatchObject({ ok: true, waiting: true, run_id: "child-1", target: "seo" });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enq = enqueueMock.mock.calls[0][0];
    expect(enq.payload.ask_id).toBe("ask-0");
    expect(enq.cron_dedupe_key).toBe("ask-child:t1:ask-0");
    expect(state.askUpdates).toContainEqual({ child_run_id: "child-1" });
    expect(sent.find((e) => e.name === "agent.ask.deadline")).toMatchObject({ id: "ask-deadline-ask-0" });
  });

  it("the enqueue dedupes on the ask: a deduped enqueue recovers the existing child run", async () => {
    enqueueMock.mockResolvedValue({ run_id: "" });
    state.dedupedRun = { id: "child-existing" };
    const res = await callPraxisTool(chatCtx, "ask_agent", args);
    expect(body(res.content)).toMatchObject({ ok: true, waiting: true, run_id: "child-existing" });
    expect(enqueueMock.mock.calls[0][0].cron_dedupe_key).toBe("ask-child:t1:ask-1");
    expect(state.askUpdates).toContainEqual({ child_run_id: "child-existing" });
    expect(state.askDeletes).toBe(0);
  });
});

describe("praxis__handoff forwards Slack images too (problem #5)", () => {
  it("adds payload.slack.images from the parent run", async () => {
    const images = [{ url: "https://files.slack.com/b.png", mimetype: "image/png" }];
    state.runPayload = { slack: { images } };
    const slack_routing = { channel_id: "C1", thread_ts: "1.0", original_ts: "1.0", event_id: "ev1", team_id: "T1" };
    const res = await callPraxisTool(
      { ...chatCtx, trigger: "slack", chat_thread_id: undefined, slack_routing },
      "handoff",
      { target_agent_slug: "seo", intent: "look at this screenshot" },
    );
    expect(res.is_error).toBe(false);
    const enq = enqueueMock.mock.calls[0][0];
    expect(enq.payload.slack).toMatchObject({ ...slack_routing, images });
  });
});
