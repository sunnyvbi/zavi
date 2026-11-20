
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => {
  const state = {
    run: null as Record<string, unknown> | null,
    binding: { id: "th-1" } as { id: string } | null,
    bindingArgs: [] as unknown[],
    send: { ok: true, chunks: 1 } as Record<string, unknown>,
    goneFilters: [] as Array<[string, unknown]>,
    claimInserts: 0,
    claimDeletes: 0,
  };
  const from = vi.fn((table: string) => {
    if (table === "agent_runs") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.run, error: null }) }) }) };
    }
    if (table === "imessage_threads") {
      return {
        update: () => {
          const chain: any = {
            eq: (c: string, v: unknown) => (state.goneFilters.push([c, v]), chain),
            then: (r: (v: unknown) => unknown) => r({ error: null }),
          };
          return chain;
        },
      };
    }
    if (table === "imessage_reply_claims") {
      return {
        insert: async () => ((state.claimInserts += 1), { error: null }),
        delete: () => ({ eq: async () => ((state.claimDeletes += 1), { error: null }) }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  const post = vi.fn(async (_a: unknown) => state.send);
  return { state, from, post };
});

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: m.from }) }));
vi.mock("@/services/tools/imessage/_client", () => ({ postIMessageReply: m.post }));
vi.mock("@/services/connectors/imessage/binding", () => ({
  findEnabledIMessageBinding: async (a: unknown) => (m.state.bindingArgs.push(a), m.state.binding),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("../../client", () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, fn: unknown) => fn },
}));

import { replyOne } from "../imessage-triage-reply";

const LINE = "+13475550100";
const HANDLE = "+14155550123";
const KEYS = ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SENDBLUE_API_KEY_ID = "kid";
  process.env.SENDBLUE_API_SECRET = "ksecret";
  process.env.SENDBLUE_FROM_NUMBER = LINE;
  process.env.SENDBLUE_WEBHOOK_SECRET = "hook";
  Object.assign(m.state, {
    run: {
      tenant_id: "t-1",
      trigger: "imessage",
      status: "success",
      output_text: "Signups are up 12% this week.",
      error: null,
      parse_error: null,
      agent_slug: "operator",
      outcome: null,
      parsed: null,
      payload: { imessage: { line: LINE, handle: HANDLE, message_handle: "mh-1", text: "how are signups?" } },
    },
    binding: { id: "th-1" },
    bindingArgs: [],
    send: { ok: true, chunks: 1 },
    goneFilters: [],
    claimInserts: 0,
    claimDeletes: 0,
  });
  m.post.mockClear();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("imessage-triage-reply", () => {
  it("posts the run's answer to the person, after re-checking the binding for THIS tenant", async () => {
    expect(await replyOne("run-1")).toMatchObject({ sent: true, chunks: 1 });
    expect(m.state.bindingArgs).toEqual([{ line: LINE, handle: HANDLE, tenant_id: "t-1" }]);
    expect(m.post).toHaveBeenCalledWith({ handle: HANDLE, text: "Signups are up 12% this week." });
  });

  it("a host on another Sendblue line skips before claiming", async () => {
    process.env.SENDBLUE_FROM_NUMBER = "+13475559999";
    expect(await replyOne("run-1")).toEqual({ skip: "destination_not_served" });
    expect(m.state.claimInserts).toBe(0);
    expect(m.post).not.toHaveBeenCalled();
  });

  it("drops the reply when the thread is no longer this tenant's enabled binding", async () => {
    m.state.binding = null;
    expect(await replyOne("run-1")).toEqual({ skip: "binding_not_current" });
    expect(m.post).not.toHaveBeenCalled();
  });

  it("leaves non-iMessage runs and handed-off parents alone", async () => {
    m.state.run = { ...m.state.run!, trigger: "telegram" };
    expect(await replyOne("run-1")).toEqual({ skip: "not_imessage_triage" });
    m.state.run = { ...m.state.run!, trigger: "imessage", payload: { ...(m.state.run!.payload as object), imessage_reply_delegated: true } };
    expect(await replyOne("run-1")).toEqual({ skip: "imessage_reply_delegated" });
    expect(m.post).not.toHaveBeenCalled();
  });

  it("tombstones only this tenant's thread when the person opted out", async () => {
    m.state.send = { ok: false, gone: true, sent: 0, error: "OPTED_OUT" };
    expect(await replyOne("run-1")).toMatchObject({ skip: "recipient_gone" });
    expect(m.state.goneFilters).toEqual([
      ["line", LINE],
      ["handle", HANDLE],
      ["tenant_id", "t-1"],
    ]);
  });

  it("throws on a transient failure with nothing sent, releasing the claim first", async () => {
    m.state.send = { ok: false, sent: 0, error: "http_500" };
    await expect(replyOne("run-1")).rejects.toThrow(/imessage_send_failed/);
    expect(m.state.claimDeletes).toBe(1);
  });
});
