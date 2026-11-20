import { describe, it, expect, vi, beforeEach } from "vitest";

const { events, sendSpy, threadSpy, isActiveSpy, rows, scrubSpy, deleteSpy, writes, ARTIFACT } = vi.hoisted(() => ({
  ARTIFACT: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
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
      if (table === "run_artifacts" && op === "select") {
        return { data: [{ id: ARTIFACT }], error: null };
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
const RUN = "33333333-3333-3333-3333-333333333333";
const THREAD = "44444444-4444-4444-4444-444444444444";

function result(text: string, keep: string[]): DispatcherResult {
  return {
    output_text: text,
    parsed: null,
    parse_ok: true,
    raw_response_text: text,
    prompt_snapshot: "sys",
    usage: { input_tokens: 10, output_tokens: 20 },
    tool_calls: [],
    egress_email_allowlist: keep,
  } as unknown as DispatcherResult;
}

beforeEach(() => {
  events.length = 0;
  writes.length = 0;
  sendSpy.mockReset().mockResolvedValue({ ids: ["x"] });
  threadSpy.mockReset().mockResolvedValue(undefined);
  isActiveSpy.mockReset().mockResolvedValue(false);
  scrubSpy.mockReset().mockImplementation(async (_t: string, calls: Array<Record<string, unknown>>) => ({ calls, deleteCheckpoints: false }));
  deleteSpy.mockReset().mockResolvedValue(true);
  rows.casWins = true;
  rows.run = { id: RUN, agent_slug: "cgo", tenant_id: TENANT, trigger: "chat", payload: { thread_id: THREAD }, cost_usd: 0.1, infra_retry_count: 0, last_progress_at: null, status: "success" };
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function emitted(): string | undefined {
  const call = threadSpy.mock.calls.find((c) => (c[0] as { kind?: string }).kind === "chat_assistant");
  return (call?.[0] as { body?: { text?: string } } | undefined)?.body?.text;
}

describe("persistTerminal: the chat_assistant event is scrubbed like the stored output", () => {
  it("a cgo run's non-owner address never reaches the event; the owner's does; the event equals the stored output", async () => {
    const raw = "Email broker@example-agency.com, and loop in jane@customer.com.";
    await persistTerminal(RUN, "cgo", result(raw, ["broker@example-agency.com"]), null, "m", {}, "chat", TENANT);
    const stored = (writes.find((w) => (w as { output_text?: unknown }).output_text !== undefined) as { output_text: string }).output_text;
    const body = emitted();
    expect(stored).toBe("Email broker@example-agency.com, and loop in [redacted].");
    expect(body).toBe(stored);
    expect(body).not.toContain("jane@customer.com");
  });

  it("with no allow-list every address is scrubbed from the event too", async () => {
    await persistTerminal(RUN, "cgo", result("Write to broker@example-agency.com", undefined as unknown as string[]), null, "m", {}, "chat", TENANT);
    expect(emitted()).toBe("Write to [redacted]");
  });
});

describe("persistTerminal: a result that arrives with a later error is scrubbed with the full options (C24-2)", () => {
  it("strips the non-owner address AND the run's artifact id from the Slack event", async () => {
    rows.run = { ...rows.run, trigger: "slack" };
    const raw = `Done, see artifact ${ARTIFACT}. Ping jane@customer.com.`;
    await persistTerminal(RUN, "cgo", result(raw, []), "post_step_failed", "m", {}, "slack", TENANT);
    const body = emitted();
    expect(body).toBeDefined();
    expect(body).not.toContain(ARTIFACT);
    expect(body).not.toContain("jane@customer.com");
  });
});
