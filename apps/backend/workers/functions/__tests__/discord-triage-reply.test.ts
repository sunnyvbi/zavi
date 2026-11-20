
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state = {
    run: null as Record<string, unknown> | null,
    binding: null as { tenant_id: string } | null,
    send: { ok: true, chunks: 1 } as Record<string, unknown>,
    claimError: null as { message: string } | null,
    bindingFilters: [] as Array<[string, unknown]>,
    guildUpdates: 0,
    claimDeletes: 0,
    claimInserts: 0,
  };

  const from = vi.fn((table: string) => {
    if (table === "agent_runs") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.run, error: null }) }),
        }),
      };
    }
    if (table === "discord_guilds") {
      const sel = () => {
        const chain: Record<string, unknown> = {};
        chain.eq = (col: string, val: unknown) => {
          state.bindingFilters.push([col, val]);
          return chain;
        };
        chain.maybeSingle = async () => ({ data: state.binding, error: null });
        return chain;
      };
      const upd = () => {
        state.guildUpdates += 1;
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.then = (res: (v: unknown) => unknown) => res({ error: null });
        return chain;
      };
      return { select: sel, update: upd };
    }
    if (table === "discord_reply_claims") {
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
vi.mock("@/services/tools/discord/_client", () => ({ postDiscordReply: m.post }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("../client", () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, fn: unknown) => fn },
}));

import { replyOne } from "../discord-triage-reply";

const RUN = {
  tenant_id: "tenant-A",
  trigger: "discord",
  status: "success",
  output_text: "here is your answer",
  agent_slug: "operator",
  payload: { discord: { guild_id: "g-1", channel_id: "c-1", message_id: "9001" } },
};

beforeEach(() => {
  m.state.run = { ...RUN };
  m.state.binding = { tenant_id: "tenant-A" };
  m.state.send = { ok: true, chunks: 1 };
  m.state.claimError = null;
  m.state.bindingFilters = [];
  m.state.guildUpdates = 0;
  m.state.claimDeletes = 0;
  m.state.claimInserts = 0;
  m.post.mockClear();
});

describe("discord-triage-reply — destination is the BINDING, not the payload", () => {
  it("sends (as a reply to the triggering message) when the guild is still bound to the run's tenant", async () => {
    const res = (await replyOne("run-1")) as Record<string, unknown>;
    expect(res).toMatchObject({ sent: true });
    expect(m.post).toHaveBeenCalledWith({
      channel_id: "c-1",
      reply_to_message_id: "9001",
      text: "here is your answer",
    });
    expect(m.state.bindingFilters).toEqual([
      ["guild_id", "g-1"],
      ["tenant_id", "tenant-A"],
      ["status", "enabled"],
    ]);
  });

  it("DROPS the reply when the guild is no longer bound to this tenant (unbound or re-bound)", async () => {
    m.state.binding = null;
    const res = (await replyOne("run-1")) as Record<string, unknown>;
    expect(res).toMatchObject({ skip: "binding_not_current" });
    expect(m.post).not.toHaveBeenCalled();
    expect(m.state.claimInserts).toBe(0);
  });

  it("skips a payload with no guild routing (an old-shape or hand-edited run)", async () => {
    m.state.run = { ...RUN, payload: { discord: { channel_id: "c-1" } } };
    expect(await replyOne("run-1")).toMatchObject({ skip: "no_discord_routing" });
    expect(m.post).not.toHaveBeenCalled();
  });

  it("a channel-level 403/404 is terminal for the conversation but never touches the guild binding", async () => {
    m.state.send = { ok: false, gone: true, sent: 0, error: "Missing Access" };
    const res = (await replyOne("run-1")) as Record<string, unknown>;
    expect(res).toMatchObject({ skip: "channel_gone" });
    expect(m.state.guildUpdates).toBe(0);
    expect(m.state.claimDeletes).toBe(0);
  });
});

describe("discord-triage-reply — claims + retry contract", () => {
  it("second worker loses the claim insert → skips without sending", async () => {
    m.state.claimError = { message: "duplicate key value violates unique constraint" };
    expect(await replyOne("run-1")).toMatchObject({ skip: "reply_already_handled" });
    expect(m.post).not.toHaveBeenCalled();
  });

  it("a failed run posts the honest failure note (never a stack trace) and keeps its claim", async () => {
    m.state.run = {
      ...RUN,
      status: "failed",
      output_text: null,
      error: "TypeError: boom\n    at x.ts:1:1 sk-live-abc",
    };
    const res = (await replyOne("run-1")) as Record<string, unknown>;
    expect(res).toMatchObject({ sent: true, failure: true });
    expect(m.state.claimInserts).toBe(1);
    expect(m.state.claimDeletes).toBe(0);
    const text = (m.post.mock.calls[0] as unknown as [{ text: string }])[0].text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/at x\.ts/);
    expect(text).not.toMatch(/sk-live/);
  });

  it("a non-success run that still produced a real answer posts THAT answer", async () => {
    m.state.run = { ...RUN, status: "parse_failed", output_text: "Here is the CAC table…" };
    const res = (await replyOne("run-1")) as Record<string, unknown>;
    expect(res).toMatchObject({ sent: true, failure: false });
    expect((m.post.mock.calls[0] as unknown as [{ text: string }])[0].text).toContain("CAC table");
  });

  it("THROWS on a transient zero-chunk send failure so Inngest spends its retry", async () => {
    m.state.send = { ok: false, sent: 0, error: "ETIMEDOUT" };
    await expect(replyOne("run-1")).rejects.toThrow(/discord_send_failed/);
    expect(m.state.claimDeletes).toBe(1);
  });

  it("does NOT throw on a partial send — the delivered prefix must not be duplicated", async () => {
    m.state.send = { ok: false, sent: 2, error: "ETIMEDOUT" };
    const res = (await replyOne("run-1")) as Record<string, unknown>;
    expect(res).toMatchObject({ skip: "partial_send", sent: 2 });
    expect(m.state.claimDeletes).toBe(0);
  });

  it("does NOT throw when the surface was disabled mid-flight (a retry would fail identically)", async () => {
    m.state.send = { ok: false, disabled: true, sent: 0, error: "discord_disabled" };
    expect(await replyOne("run-1")).toMatchObject({ skip: "discord_disabled" });
    expect(m.state.claimDeletes).toBe(1);
  });

  it("skips a delegated parent (the handed-off child owns the one reply)", async () => {
    m.state.run = { ...RUN, payload: { ...RUN.payload, discord_reply_delegated: true } };
    expect(await replyOne("run-1")).toMatchObject({ skip: "discord_reply_delegated" });
    expect(m.post).not.toHaveBeenCalled();
  });

  it("skips a non-discord run outright (no cross-surface reply)", async () => {
    m.state.run = { ...RUN, trigger: "telegram" };
    expect(await replyOne("run-1")).toMatchObject({ skip: "not_discord_triage" });
    expect(m.post).not.toHaveBeenCalled();
  });
});
