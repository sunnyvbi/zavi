import { describe, it, expect, vi, beforeEach } from "vitest";

const switchedChannelForRun = vi.fn();
const healChatRunStamp = vi.fn();
vi.mock("@/services/channels/channel-actions", () => ({
  switchedChannelForRun: (...a: unknown[]) => switchedChannelForRun(...a),
}));
vi.mock("@/services/channels/direct-run", () => ({
  healChatRunStamp: (...a: unknown[]) => healChatRunStamp(...a),
}));

import { resolveChannelExecEmit } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";

const emit_decision = vi.fn(async () => "decision-1");
const write = vi.fn(async () => "action-1");
const META: ReadonlySet<string> = new Set(["meta_ads"]);
const chat = { tenant_id: "t-1", run_id: "r-1", emit_decision, run_trigger: "chat" };

beforeEach(() => {
  vi.clearAllMocks();
  switchedChannelForRun.mockResolvedValue(null);
});

describe("resolveChannelExecEmit — unstamped channel chat run", () => {
  it("a healed stamp sends the proposal to the channel's card rail, not decisions", async () => {
    healChatRunStamp.mockResolvedValue("meta_ads");
    const emit = await resolveChannelExecEmit(META, chat, write);
    expect(emit).not.toBe(emit_decision);
    expect(healChatRunStamp).toHaveBeenCalledWith("t-1", "r-1");
  });

  it.each([["failed"], ["unreadable"]])("a %s heal resolves normally (reads keep working) and refuses only when a proposal is made", async (outcome) => {
    healChatRunStamp.mockResolvedValue(outcome);
    const emit = await resolveChannelExecEmit(META, chat, write);
    expect(emit).toBeTypeOf("function");
    await expect(emit!("meta_ads.status_change", {})).rejects.toBeInstanceOf(ExpectedToolError);
    expect(write).not.toHaveBeenCalled();
    expect(emit_decision).not.toHaveBeenCalled();
  });

  it("a chat run never takes the unbounded stamp read; an unreadable row is retried once", async () => {
    healChatRunStamp.mockResolvedValueOnce("unreadable").mockResolvedValueOnce("meta_ads");
    const emit = await resolveChannelExecEmit(META, chat, write);
    expect(emit).not.toBe(emit_decision);
    expect(healChatRunStamp).toHaveBeenCalledTimes(2);
    expect(switchedChannelForRun).not.toHaveBeenCalled();
  });

  it("the CallMcpContext name (trigger) is read too", async () => {
    healChatRunStamp.mockResolvedValue("meta_ads");
    const { run_trigger: _r, ...rest } = chat;
    expect(await resolveChannelExecEmit(META, { ...rest, trigger: "chat" }, write)).not.toBe(emit_decision);
  });

  it("a run that is not a chat never heals and keeps its own path", async () => {
    const emit = await resolveChannelExecEmit(META, { ...chat, run_trigger: "a2a" }, write);
    expect(emit).toBe(emit_decision);
    expect(healChatRunStamp).not.toHaveBeenCalled();
  });

  it("a chat run that is not a channel agent's keeps its own path", async () => {
    healChatRunStamp.mockResolvedValue(null);
    expect(await resolveChannelExecEmit(META, chat, write)).toBe(emit_decision);
  });
});
