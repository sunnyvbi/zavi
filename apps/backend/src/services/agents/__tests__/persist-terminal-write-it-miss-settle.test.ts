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
const LIST = "6b7a1c2e-1111-4222-8333-444455556666";
const WRITE_IT = {
  channel_slug: "email_marketing",
  top_action: { key: "new_email", by: "u1", inputs: { route: "zavi_list", list_id: LIST, brief: "Announce the spring sale" } },
};
const CHANNEL_RUN = { channel_slug: "email_marketing" };

function result(tool_calls: unknown[] | undefined): DispatcherResult {
  return {
    output_text: "Done.",
    parsed: { ok: true },
    parse_ok: true,
    raw_response_text: "Done.",
    prompt_snapshot: "sys",
    usage: { input_tokens: 10, output_tokens: 20, cost_usd: 0.1 },
    tool_calls,
  } as unknown as DispatcherResult;
}

async function terminalFor(payload: unknown, trigger: string, tool_calls: unknown[] | undefined): Promise<Record<string, unknown>> {
  await persistTerminal(RUN, "email_marketing", result(tool_calls), null, "m", payload, trigger, TENANT);
  return writes.find((w) => (w as { finished_at?: string }).finished_at) as Record<string, unknown>;
}

const refused = { name: "mcp__server__email__propose_campaign", status: "tool_error", code: "bulk_sender_not_configured", input_preview: "", output_preview: "" };
const filed = { name: "mcp__server__email__propose_campaign", status: "ok", input_preview: "", output_preview: "{}" };
const listed = { name: "outbound__list_email_lists", status: "ok", input_preview: "", output_preview: "{}" };

beforeEach(() => {
  events.length = 0;
  writes.length = 0;
  sendSpy.mockReset().mockResolvedValue({ ids: ["x"] });
  threadSpy.mockReset().mockResolvedValue(undefined);
  isActiveSpy.mockReset().mockResolvedValue(false);
  scrubSpy.mockReset().mockImplementation(async (_t: string, calls: unknown[]) => ({ calls, deleteCheckpoints: false }));
  deleteSpy.mockReset().mockResolvedValue(true);
  rows.casWins = true;
  rows.run = { id: RUN, agent_slug: "email_marketing", tenant_id: TENANT, trigger: "channel_recipe", payload: WRITE_IT, cost_usd: 0.1, infra_retry_count: 0, last_progress_at: null, status: "success" };
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("persistTerminal marks a Write it run that filed no email to settle at model usage", () => {
  it("marks a successful Write it run whose email tool refused, in the same terminal write that ends it", async () => {
    const t = await terminalFor(WRITE_IT, "channel_recipe", [listed, refused]);
    expect(t.status).toBe("success");
    expect(t.settle_at_usage).toBe(true);
  });

  it("marks a Write it run that never called the email tool, and one with no tool calls at all", async () => {
    expect((await terminalFor(WRITE_IT, "channel_recipe", [listed])).settle_at_usage).toBe(true);
    writes.length = 0;
    expect((await terminalFor(WRITE_IT, "channel_recipe", undefined)).settle_at_usage).toBe(true);
  });

  it("writes false for a Write it run that filed its email, even when the first pass was refused and the retry filed it", async () => {
    const plain = await terminalFor(WRITE_IT, "channel_recipe", [filed]);
    expect(plain).toHaveProperty("settle_at_usage", false);
    writes.length = 0;
    const retried = await terminalFor(WRITE_IT, "channel_recipe", [refused, listed, filed]);
    expect(retried).toHaveProperty("settle_at_usage", false);
  });

  it("clears a true left by an earlier finalize when the same run is finalized again after it filed", async () => {
    const first = await terminalFor(WRITE_IT, "channel_recipe", [refused]);
    expect(first.settle_at_usage).toBe(true);
    const stored = { ...first };
    writes.length = 0;
    const second = await terminalFor(WRITE_IT, "channel_recipe", [refused, filed]);
    Object.assign(stored, second);
    expect(stored.settle_at_usage).toBe(false);
  });

  it("does not mark a normal channel run that filed nothing new (a repeat of an open suggestion stays flat priced)", async () => {
    expect(await terminalFor(CHANNEL_RUN, "channel_recipe", [listed])).not.toHaveProperty("settle_at_usage");
    writes.length = 0;
    expect(await terminalFor(CHANNEL_RUN, "channel_recipe", [])).not.toHaveProperty("settle_at_usage");
  });

  it("does not mark a top action payload that did not come from the channel recipe trigger, or one that is broken", async () => {
    expect(await terminalFor(WRITE_IT, "manual", [refused])).not.toHaveProperty("settle_at_usage");
    writes.length = 0;
    const broken = { ...WRITE_IT, top_action: { ...WRITE_IT.top_action, inputs: { route: "zavi_list" } } };
    expect(await terminalFor(broken, "channel_recipe", [refused])).not.toHaveProperty("settle_at_usage");
  });
});
