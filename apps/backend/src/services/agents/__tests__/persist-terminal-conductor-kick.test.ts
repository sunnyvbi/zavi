import { describe, it, expect, vi, beforeEach } from "vitest";

const { events, sendSpy, threadSpy, isActiveSpy, rows, rpcSpy } = vi.hoisted(() => ({
  rpcSpy: vi.fn(async (_name: string, _args: unknown) => ({ data: null, error: null })),
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
          return () => {
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
    rpc: rpcSpy,
  };
  return { ...(await orig<Record<string, unknown>>()), serviceClient: () => client };
});

import { persistTerminal } from "../runner";
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";
import type { DispatcherResult } from "../types";

const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const CONDUCTOR = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";

function result(): DispatcherResult {
  return {
    output_text: "Built the site.",
    parsed: { ok: true },
    parse_ok: true,
    raw_response_text: "Built the site.",
    prompt_snapshot: "sys",
    usage: { input_tokens: 10, output_tokens: 20 },
    tool_calls: [],
  } as unknown as DispatcherResult;
}

function seedRun(payload: Record<string, unknown>) {
  rows.casWins = true;
  rows.run = {
    id: RUN,
    agent_slug: "engineer",
    tenant_id: TENANT,
    trigger: "a2a",
    started_at: new Date().toISOString(),
    payload,
    cost_usd: 0.5,
    infra_retry_count: 0,
    last_progress_at: null,
    status: "success",
  };
}

function ticks() {
  return sendSpy.mock.calls.filter(
    (c) => (c[0] as { name?: string } | undefined)?.name === "conductor/tick.requested",
  );
}

beforeEach(() => {
  events.length = 0;
  sendSpy.mockReset();
  threadSpy.mockReset();
  isActiveSpy.mockReset();
  sendSpy.mockImplementation(async (e: { name?: string }) => {
    events.push(`send:${e?.name}`);
    return { ids: ["x"] };
  });
  threadSpy.mockImplementation(async (e: { kind?: string }) => {
    events.push(`thread:${e?.kind}`);
  });
  isActiveSpy.mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("persistTerminal kicks the build conductor as soon as the terminal status is written", () => {
  it("the tick goes out right after the status write, even while later bookkeeping is still stuck", async () => {
    seedRun({ [BUILD_CONDUCTOR_RUN_ID_KEY]: CONDUCTOR, stage: "build" });
    threadSpy.mockImplementation(async (e: { kind?: string }) => {
      events.push(`thread:${e?.kind}`);
      if (e?.kind === "run_end") await new Promise(() => undefined);
    });
    void persistTerminal(RUN, "engineer", result(), null, "m", rows.run.payload, "a2a", TENANT);
    await vi.waitFor(() => expect(events).toContain("thread:run_end"), { timeout: 5000 });
    expect(ticks()).toHaveLength(1);
    expect(ticks()[0][0]).toEqual({
      name: "conductor/tick.requested",
      data: { conductor_run_id: CONDUCTOR },
    });
    expect(events.indexOf("terminal_write")).toBeLessThan(events.indexOf("send:conductor/tick.requested"));
    expect(events.indexOf("send:conductor/tick.requested")).toBeLessThan(events.indexOf("thread:run_end"));
    expect(isActiveSpy).toHaveBeenCalledWith(CONDUCTOR, TENANT);
  });

  it("a settled run kicks its conductor exactly once, not again at the end", async () => {
    seedRun({ [BUILD_CONDUCTOR_RUN_ID_KEY]: CONDUCTOR, stage: "build" });
    await persistTerminal(RUN, "engineer", result(), null, "m", rows.run.payload, "a2a", TENANT);
    expect(ticks()).toHaveLength(1);
  });

  it("if the early kick could not be sent, the end-of-path kick still tries again", async () => {
    seedRun({ [BUILD_CONDUCTOR_RUN_ID_KEY]: CONDUCTOR, stage: "build" });
    let first = true;
    sendSpy.mockImplementation(async (e: { name?: string }) => {
      if (e?.name === "conductor/tick.requested" && first) {
        first = false;
        throw new Error("inngest unreachable");
      }
      events.push(`send:${e?.name}`);
      return { ids: ["x"] };
    });
    await persistTerminal(RUN, "engineer", result(), null, "m", rows.run.payload, "a2a", TENANT);
    expect(ticks()).toHaveLength(2);
  });

  it("a run with no conductor stamp never kicks or looks one up", async () => {
    seedRun({ stage: "build" });
    await persistTerminal(RUN, "engineer", result(), null, "m", rows.run.payload, "a2a", TENANT);
    expect(ticks()).toHaveLength(0);
    expect(isActiveSpy).not.toHaveBeenCalled();
  });

  it("a run that lost the terminal write (already reaped) never kicks", async () => {
    seedRun({ [BUILD_CONDUCTOR_RUN_ID_KEY]: CONDUCTOR, stage: "build" });
    rows.casWins = false;
    await persistTerminal(RUN, "engineer", result(), null, "m", rows.run.payload, "a2a", TENANT);
    expect(ticks()).toHaveLength(0);
  });

  it("a conductor that is no longer active is not kicked", async () => {
    seedRun({ [BUILD_CONDUCTOR_RUN_ID_KEY]: CONDUCTOR, stage: "build" });
    isActiveSpy.mockResolvedValue(false);
    await persistTerminal(RUN, "engineer", result(), null, "m", rows.run.payload, "a2a", TENANT);
    expect(ticks()).toHaveLength(0);
  });
});


describe("channel terminal state", () => {
  it.each(["a2a", "chat", "channel_recipe"])("reflects a stamped %s run after completion", async trigger => {
    seedRun({}); rows.run.trigger = trigger; rows.run.channel_slug = "linkedin_organic";
    rpcSpy.mockClear();
    await persistTerminal(RUN, "engineer", result(), null, "test", {}, trigger, TENANT);
    expect(rpcSpy).toHaveBeenCalledWith("record_channel_run", expect.objectContaining({ p_run_id: RUN, p_tenant_id: TENANT }));
  });
  it("does not write channel state for an unstamped chat run", async () => {
    seedRun({}); rows.run.trigger = "chat"; rows.run.channel_slug = null; rpcSpy.mockClear();
    await persistTerminal(RUN, "engineer", result(), null, "test", {}, "chat", TENANT);
    expect(rpcSpy.mock.calls.some(c => c[0] === "record_channel_run")).toBe(false);
  });
});
