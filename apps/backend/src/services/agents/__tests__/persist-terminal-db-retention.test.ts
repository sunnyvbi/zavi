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

import { persistTerminal } from "../runner";
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
    tool_calls: [{ name: "operator_db__query", status: "ok", input_preview: "select", output_preview: "email: a@b.c" }],
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

describe("persistTerminal run-end retention", () => {
  it.each([
    ["cgo", "draft_strategy", "strategy_superseded", "cancelled"],
    ["cgo", "draft_strategy", "strategy_delivery_failed", "parse_failed"],
    ["cgo", "conversation", "strategy_superseded", "parse_failed"],
    ["operator", "draft_strategy", "strategy_superseded", "parse_failed"],
  ])("classifies %s/%s/%s as %s without allowing follow-up actions", async (agent, stage, diagnostic, status) => {
    const r = { ...result(), parse_ok: false, parse_error: diagnostic };
    await persistTerminal(RUN, agent, r, null, "m", {stage}, "manual", TENANT);
    const terminal = writes.find(w => (w as {finished_at?:string}).finished_at) as Record<string,unknown>;
    expect(terminal.status).toBe(status);
    expect(terminal.parse_ok).toBe(false);
    if (status === "cancelled") expect(terminal.error).toBeNull();
    else expect(terminal.error).toBeTruthy();
  });

  it("the terminal write itself carries the scrubbed previews (no raw rows ever written)", async () => {
    await persistTerminal(RUN, "operator", result(), null, "m", {}, "manual", TENANT);
    expect(events.indexOf("scrub")).toBeLessThan(events.indexOf("terminal_write"));
    const terminal = writes.find((w) => (w as { finished_at?: string }).finished_at) as { tool_calls: Array<{ output_preview: string }> };
    expect(terminal.tool_calls[0].output_preview).toBe("");
    expect(scrubSpy.mock.calls[0][0]).toBe(TENANT);
  });

  it("checkpoints are deleted only after the terminal write wins, with the written status", async () => {
    await persistTerminal(RUN, "operator", result(), null, "m", {}, "manual", TENANT);
    expect(events.indexOf("delete_checkpoints")).toBeGreaterThan(events.indexOf("terminal_write"));
    expect(deleteSpy.mock.calls[0]).toEqual([TENANT, RUN, "success"]);
  });

  it("a lost CAS never deletes checkpoints", async () => {
    rows.casWins = false;
    await persistTerminal(RUN, "operator", result(), null, "m", {}, "manual", TENANT);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("no database tool call: neither step runs", async () => {
    const r = result();
    (r as unknown as { tool_calls: unknown[] }).tool_calls = [{ name: "github__read_file", status: "ok", input_preview: "", output_preview: "x" }];
    await persistTerminal(RUN, "operator", r, null, "m", {}, "manual", TENANT);
    expect(scrubSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});
