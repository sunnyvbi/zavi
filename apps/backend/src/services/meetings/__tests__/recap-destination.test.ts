import { describe, it, expect, vi } from "vitest";
import {
  planRecapDelivery,
  findPostableChannel,
  normalizeChannelName,
  channelNotFoundMessage,
  cannotJoinMessage,
  type SlackCall,
} from "../recap-destination";
import { ExpectedToolError } from "@/services/tools/types";

describe("planRecapDelivery: the summary goes only where the team chose", () => {
  const base = { slackChannelId: "C1", slackChannelName: "standups", summonedFromThread: true };

  it("not chosen: nothing is sent anywhere, not even the summon thread; the owner is asked", () => {
    expect(planRecapDelivery({ ...base, destination: null })).toEqual({ email: false, channel: null, thread: false, askOwner: true });
    expect(planRecapDelivery({ ...base, destination: "everyone" }).askOwner).toBe(true);
  });

  it("off: nothing is sent and nobody is asked", () => {
    expect(planRecapDelivery({ ...base, destination: "off" })).toEqual({ email: false, channel: null, thread: false, askOwner: false });
  });

  it("email: the email, plus the summon thread when there is one; never a channel even with an old channel saved", () => {
    expect(planRecapDelivery({ ...base, destination: "email" })).toEqual({ email: true, channel: null, thread: true, askOwner: false });
    expect(planRecapDelivery({ ...base, destination: "email", summonedFromThread: false }).thread).toBe(false);
  });

  it("slack: the team channel (and the summon thread), no email", () => {
    expect(planRecapDelivery({ ...base, destination: "slack" })).toEqual({
      email: false,
      channel: { id: "C1", name: "standups" },
      thread: true,
      askOwner: false,
    });
    expect(planRecapDelivery({ ...base, destination: "slack", slackChannelId: " " }).channel).toBeNull();
  });
});

type Page = { channels: Array<Record<string, unknown>>; next?: string };
function fakeSlack(pages: Page[], opts: { joinFails?: boolean; listThrows?: unknown } = {}) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const call = vi.fn(async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body });
    if (method === "conversations.list") {
      if (opts.listThrows) throw opts.listThrows;
      const i = body.cursor ? Number(String(body.cursor).slice(1)) : 0;
      const p = pages[i] ?? { channels: [] };
      return { channels: p.channels, response_metadata: { next_cursor: p.next ?? "" } };
    }
    if (method === "conversations.join") {
      if (opts.joinFails) throw new ExpectedToolError("slack_api_error", "missing_scope");
      return { ok: true };
    }
    throw new Error(`unexpected ${method}`);
  }) as unknown as SlackCall;
  return { call, calls };
}

describe("findPostableChannel: a channel by name, across every page", () => {
  it("normalizes what the admin typed", () => {
    expect(normalizeChannelName("  ##Standups ")).toBe("standups");
  });

  it("finds a channel on a later page and stops paging once found", async () => {
    const { call, calls } = fakeSlack([
      { channels: [{ id: "C1", name: "general", is_member: true }], next: "p1" },
      { channels: [{ id: "C2", name: "standups", is_member: true }], next: "p2" },
      { channels: [{ id: "C3", name: "never-read" }] },
    ]);
    expect(await findPostableChannel("#Standups", call)).toEqual({ ok: true, id: "C2", name: "standups", joined: false });
    expect(calls.filter((c) => c.method === "conversations.list")).toHaveLength(2);
    expect(calls[1].body.cursor).toBe("p1");
  });

  it("joins a public channel Zavi is not in", async () => {
    const { call, calls } = fakeSlack([{ channels: [{ id: "C9", name: "team-notes", is_private: false, is_member: false }] }]);
    expect(await findPostableChannel("team-notes", call)).toEqual({ ok: true, id: "C9", name: "team-notes", joined: true });
    expect(calls.at(-1)).toEqual({ method: "conversations.join", body: { channel: "C9" } });
  });

  it("a public channel Zavi cannot join says to invite @Zavi", async () => {
    const { call } = fakeSlack([{ channels: [{ id: "C9", name: "team-notes", is_member: false }] }], { joinFails: true });
    expect(await findPostableChannel("team-notes", call)).toEqual({ ok: false, code: "cannot_join", message: cannotJoinMessage("team-notes") });
  });

  it("a private channel without Zavi is refused (never joined), and one Slack does not list reads as not found with the invite hint", async () => {
    const listed = fakeSlack([{ channels: [{ id: "G1", name: "leads", is_private: true, is_member: false }] }]);
    expect(await findPostableChannel("leads", listed.call)).toEqual({ ok: false, code: "cannot_join", message: cannotJoinMessage("leads") });
    expect(listed.calls.some((c) => c.method === "conversations.join")).toBe(false);

    const hidden = fakeSlack([{ channels: [{ id: "C1", name: "general", is_member: true }] }]);
    const out = await findPostableChannel("leads", hidden.call);
    expect(out).toEqual({ ok: false, code: "channel_not_found", message: channelNotFoundMessage("leads") });
    expect(channelNotFoundMessage("leads")).toContain("invite @Zavi to #leads first");
  });

  it("ignores archived channels and rejects names Slack cannot have", async () => {
    const { call } = fakeSlack([{ channels: [{ id: "C1", name: "old", is_archived: true, is_member: true }] }]);
    expect((await findPostableChannel("old", call)).ok).toBe(false);
    const none = fakeSlack([]);
    expect(await findPostableChannel("two words", none.call)).toMatchObject({ ok: false, code: "bad_channel_name" });
    expect(await findPostableChannel("#", none.call)).toMatchObject({ ok: false, code: "bad_channel_name" });
    expect(none.calls).toHaveLength(0);
  });

  it("no Slack connection and a Slack outage are told apart", async () => {
    const off = fakeSlack([], { listThrows: new ExpectedToolError("slack_not_connected", "no token") });
    expect(await findPostableChannel("standups", off.call)).toMatchObject({ ok: false, code: "slack_not_connected" });
    const down = fakeSlack([], { listThrows: new ExpectedToolError("slack_timeout", "timeout") });
    expect(await findPostableChannel("standups", down.call)).toMatchObject({ ok: false, code: "slack_error" });
  });
});
