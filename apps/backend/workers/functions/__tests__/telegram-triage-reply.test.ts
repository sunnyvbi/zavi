
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state = {
    run: null as Record<string, unknown> | null,
    binding: null as { tenant_id: string } | null,
    send: { ok: true, chunks: 1 } as Record<string, unknown>,
    claimError: null as { message: string } | null,
    goneUpdateFilters: [] as Array<[string, unknown]>,
    claimDeletes: 0,
    claimInserts: 0,
  };

  const from = vi.fn((table: string) => {
    if (table === "agent_runs") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.run, error: null }) }) }),
      };
    }
    if (table === "telegram_chats") {
      const sel = () => {
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({ data: state.binding, error: null });
        return chain;
      };
      const upd = () => {
        const chain: Record<string, unknown> = {};
        chain.eq = (col: string, val: unknown) => {
          state.goneUpdateFilters.push([col, val]);
          return chain;
        };
        chain.then = (res: (v: unknown) => unknown) => res({ error: null });
        return chain;
      };
      return { select: sel, update: upd };
    }
    if (table === "telegram_reply_claims") {
      return {
        insert: async () => {
          state.claimInserts += 1;
          return { error: state.claimError };
        },
        delete: () => ({
          eq: async () => {
            state.claimDeletes += 1;
            return { error: null };
          },
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });

  const post = vi.fn(async () => state.send);
  return { state, from, post };
});

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: m.from }) }));
vi.mock("@/services/tools/telegram/_client", () => ({ postTelegramReply: m.post }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("../client", () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, fn: unknown) => fn },
}));

import { replyOne } from "../telegram-triage-reply";

const RUN = {
  tenant_id: "tenant-A",
  trigger: "telegram",
  status: "success",
  output_text: "here is your answer",
  agent_slug: "operator",
  payload: { telegram: { chat_id: -100123, message_id: 7 } },
};

beforeEach(() => {
  m.state.run = { ...RUN };
  m.state.binding = { tenant_id: "tenant-A" };
  m.state.send = { ok: true, chunks: 1 };
  m.state.claimError = null;
  m.state.goneUpdateFilters = [];
  m.state.claimDeletes = 0;
  m.state.claimInserts = 0;
  m.post.mockClear();
});

describe("telegram-triage-reply — destination is the BINDING, not the payload", () => {
  it("sends when the payload chat is still an enabled binding for the run's tenant", async () => {
    const res = (await replyOne("run-1")) as Record<string, unknown>;
    expect(res).toMatchObject({ sent: true });
    expect(m.post).toHaveBeenCalledTimes(1);
  });

  it("DROPS the reply when the chat is no longer bound to this tenant (unbound or re-bound)", async () => {
    m.state.binding = null;
    const res = (await replyOne("run-1")) as Record<string, unknown>;
    expect(res).toMatchObject({ skip: "binding_not_current" });
    expect(m.post).not.toHaveBeenCalled();
    expect(m.state.claimInserts).toBe(0);
  });

  it("scopes the terminal 'chat gone' disable by tenant_id (never another tenant's binding)", async () => {
    m.state.send = { ok: false, gone: true, sent: 0, error: "Forbidden: bot was kicked" };
    const res = (await replyOne("run-1")) as Record<string, unknown>;
    expect(res).toMatchObject({ skip: "chat_gone" });
    expect(m.state.goneUpdateFilters).toEqual([
      ["chat_id", -100123],
      ["tenant_id", "tenant-A"],
    ]);
  });
});

describe("telegram-triage-reply — retry contract", () => {
  it("THROWS on a transient zero-chunk send failure so Inngest spends its retry", async () => {
    m.state.send = { ok: false, sent: 0, error: "ETIMEDOUT" };
    await expect(replyOne("run-1")).rejects.toThrow(/telegram_send_failed/);
    expect(m.state.claimDeletes).toBe(1);
  });

  it("does NOT throw on a partial send — the delivered prefix must not be duplicated", async () => {
    m.state.send = { ok: false, sent: 2, error: "ETIMEDOUT" };
    const res = (await replyOne("run-1")) as Record<string, unknown>;
    expect(res).toMatchObject({ skip: "partial_send", sent: 2 });
    expect(m.state.claimDeletes).toBe(0);
  });

  it("does NOT throw when the surface was disabled mid-flight (a retry would fail identically)", async () => {
    m.state.send = { ok: false, disabled: true, sent: 0, error: "telegram_disabled" };
    const res = (await replyOne("run-1")) as Record<string, unknown>;
    expect(res).toMatchObject({ skip: "telegram_disabled" });
    expect(m.state.claimDeletes).toBe(1);
  });

  it("skips a non-telegram run outright (no cross-surface reply)", async () => {
    m.state.run = { ...RUN, trigger: "slack" };
    expect(await replyOne("run-1")).toMatchObject({ skip: "not_telegram_triage" });
    expect(m.post).not.toHaveBeenCalled();
  });
});
