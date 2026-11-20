import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { listChannelThreads } from "./channelThreadsApi";

const CARD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const row = { id: "t1", title: "x", preview: null, last_message_at: null, channel_action_id: null, card_title: null };

beforeEach(() => apiFetch.mockReset());

describe("listChannelThreads", () => {
  it("asks for the channel and returns the rows", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ threads: [row] }) });
    await expect(listChannelThreads("chatgpt_ads")).resolves.toEqual([row]);
    expect(apiFetch).toHaveBeenCalledWith("/api/workspace/channel-threads?channel=chatgpt_ads");
  });

  it("adds the card when given", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ threads: [] }) });
    await listChannelThreads("chatgpt_ads", CARD);
    expect(apiFetch).toHaveBeenCalledWith(
      `/api/workspace/channel-threads?channel=chatgpt_ads&action=${CARD}`,
    );
  });

  it("a payload-built card (non-uuid) answers empty without a request", async () => {
    await expect(listChannelThreads("chatgpt_ads", "staged-post")).resolves.toEqual([]);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("throws on a failed response", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: "db down" } }),
    });
    await expect(listChannelThreads("chatgpt_ads")).rejects.toThrow("db down");
  });
});
