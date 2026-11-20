import { describe, it, expect, vi, beforeEach } from "vitest";

const { events, sendSpy, threadSpy, isActiveSpy, rows, scrubSpy, deleteSpy, writes } = vi.hoisted(() => ({
  scrubSpy: vi.fn(),
  deleteSpy: vi.fn(),
  writes: [] as unknown[],
  events: [] as string[],
  sendSpy: vi.fn(),
  threadSpy: vi.fn(),
  isActiveSpy: vi.fn(),
  rows: { run: {} as Record<string, unknown>, casWins: true },
}));

vi.mock("@/../workers/client", () => ({
  inngest: { send: sendSpy, createFunction: () => ({}) },
}));
vi.mock("../thread-event", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitThreadEvent: threadSpy,
}));
vi.mock("../conductor-kick", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isActiveConductorRun: isActiveSpy,
}));
vi.mock("@/services/data-gateway/scrub", () => ({
  scrubPreviewsForRunEnd: (...a: unknown[]) => {
    events.push("scrub");
    return scrubSpy(...a);
  },
  deleteCheckpointsAtRunEnd: (...a: unknown[]) => {
    events.push("delete_checkpoints");
    return deleteSpy(...a);
  },
}));
vi.mock("@/services/supabase", async (orig) => {
  function chain(table: string) {
    let op: "select" | "update" | "insert" | "upsert" | "delete" = "select";
    let wantsRows = false;
    const result = () => {
      if (table === "agent_runs" && op === "update") {
        events.push("terminal_write");
        return { data: rows.casWins ? [structuredClone(rows.run)] : [], error: null };
      }
      if (table === "agent_runs" && op === "select") {
        return { data: wantsRows ? [structuredClone(rows.run)] : structuredClone(rows.run), error: null };
      }
      return { data: wantsRows ? [] : null, error: null, count: 0 };
    };
    const q: Record<string, unknown> = {};
    const self = new Proxy(q, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            try {
              resolve(result());
            } catch (e) {
              reject(e);
            }
          };
        }
        if (prop === "update" || prop === "insert" || prop === "upsert" || prop === "delete") {
          return (payload: unknown) => {
            if (table === "agent_runs" && prop === "update") writes.push(payload);
            op = prop;
            return self;
          };
        }
        if (prop === "select") {
          return () => {
            if (op === "update") wantsRows = true;
            return self;
          };
        }
        if (prop === "single" || prop === "maybeSingle") {
          return async () => {
            const r = result();
            return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
          };
        }
        return () => self;
      },
    });
    return self;
  }
  const client = {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: null }),
  };
  return { ...(await orig<Record<string, unknown>>()), serviceClient: () => client };
});

vi.mock("@/services/anthropic", async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getAnthropic: () => ({ messages: { create: async () => ({stop_reason: "end_turn", content: [{type: "text", text: "REFUSED"}]}) } }),
}));
import { persistTerminal } from "../runner";
import { selectReplyTextFromRow } from "../terminal-reply-text";
import { classifyRun } from "../run-display-state";
import type { DispatcherResult } from "../types";

const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";

function result(): DispatcherResult {
  return {
    output_text: "There are 42 bookings.",
    parsed: { ok: true },
    parse_ok: true,
    raw_response_text: "There are 42 bookings.",
    prompt_snapshot: "sys",
    usage: { input_tokens: 10, output_tokens: 20 },
    tool_calls: [{ name: "operator_db__query", status: "ok", ms: 1, input_preview: "select", output_preview: "count: 42" }],
  } as unknown as DispatcherResult;
}

beforeEach(() => {
  events.length = 0;
  writes.length = 0;
  sendSpy.mockReset().mockResolvedValue({ ids: ["x"] });
  threadSpy.mockReset().mockResolvedValue(undefined);
  isActiveSpy.mockReset().mockResolvedValue(false);
  scrubSpy.mockReset().mockImplementation(async (_t: string, calls: Array<Record<string, unknown>>) => ({
    calls: calls.map((c) => ({ ...c, output_preview: "" })),
    deleteCheckpoints: true,
  }));
  deleteSpy.mockReset().mockResolvedValue(true);
  rows.casWins = true;
  rows.run = { id: RUN, agent_slug: "operator", tenant_id: TENANT, trigger: "manual", payload: {}, cost_usd: 0.1, infra_retry_count: 0, last_progress_at: null, status: "success" };
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("refusal completion regression reproduction", () => {
  it("a retry reuses the saved refusal even if the new assessment differs", async () => {
    rows.casWins = false;
    rows.run.status = "failed";
    rows.run.outcome = {failure: {class: "policy_refusal"}};
    expect(await persistTerminal(RUN, "operator", result(), null, "m", {intent: "Read the count"}, "chat", TENANT)).toBe("refused");
  });
  it("a losing refusal assessment cannot relabel the saved success", async () => {
    rows.casWins = false;
    const r = {...result(), output_text: "I cannot start the requested check."};
    expect(await persistTerminal(RUN, "operator", r, null, "m", {intent: "Start the check"}, "chat", TENANT)).toBe("not_refused");
  });
  it("does not count a final inability to perform the requested action as success", async () => {
    const r = { ...result(), output_text: "I cannot start the requested analytics check. I can only read its existing results.", parsed: null, tool_calls: [{name: "growth__read_results", status: "ok", ms: 1, input_preview: "", output_preview: ""}] } as DispatcherResult;
    const completion = await persistTerminal(RUN, "operator", r, null, "m", {intent: "Start an analytics check"}, "chat", TENANT);
    const terminal = writes.find(w => (w as {finished_at?: string}).finished_at) as Record<string, unknown>;
    expect(completion).toBe("refused");
    expect(terminal.status).toBe("failed");
    expect(terminal.output_text).toContain("cannot start");
    expect(terminal.parse_ok).toBe(true);
    expect(terminal.outcome).toMatchObject({deliverable: null, customer_summary: expect.stringContaining("cannot start"), failure: {class: "policy_refusal"}, liveness_tier: "empty"});
    expect(classifyRun(terminal as Parameters<typeof classifyRun>[0]).displayState).toBe("failed");
    expect(selectReplyTextFromRow(terminal as Parameters<typeof selectReplyTextFromRow>[0]).markdown).toContain("cannot start");
    expect(threadSpy.mock.calls.find(([event]) => event.kind === "run_end")?.[0].body).toMatchObject({status: "error", answered: false});
  });
  it("keeps a useful prose fallback successful despite its synthetic refused flag", async () => {
    const r = { ...result(), output_text: "The search report shows a decline. Improve the three product pages first.", parsed: {refused: true, parse_fallback_kind: "no_envelope_block_prose_fallback"}, tool_calls: [] } as DispatcherResult;
    await persistTerminal(RUN, "operator", r, null, "m", {intent: "Start an analytics check"}, "chat", TENANT);
    const terminal = writes.find(w => (w as {finished_at?: string}).finished_at) as Record<string, unknown>;
    expect(terminal.status).toBe("success");
  });
});
