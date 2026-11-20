import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import {
  approve,
  listChannelActions,
  listChannelMetrics,
  redoChannelAction,
  setChannelAction,
} from "./channelActionsApi";

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => apiFetch.mockReset());

describe("channelActionsApi", () => {
  it("lists the top actions as the server sent them", async () => {
    const row = { id: "a1", action_type: "fix", source: "channel_action", executable: false, exec_status: null, edited_body: null };
    apiFetch.mockResolvedValueOnce(ok({ actions: [row], more: 3, store: "channel_actions" }));
    const r = await listChannelActions("x_organic");
    expect(apiFetch).toHaveBeenCalledWith("/api/channels/x_organic/actions");
    expect(r.more).toBe(3);
    expect(r.store).toBe("channel_actions");
    expect(r.actions).toEqual([row]);
  });

  it("keeps the channel's plan the server sent", async () => {
    const plan = { id: "p1", title: "Your blog strategy", content: "# Plan", proposed_at: "2026-09-24T00:00:00Z", status: "pending" };
    apiFetch.mockResolvedValueOnce(ok({ actions: [], more: 0, store: "channel_actions", plan }));
    const r = await listChannelActions("blog");
    expect(r.plan).toEqual(plan);
  });

  it("approves with a request_id, generating one when absent", async () => {
    apiFetch.mockResolvedValue(ok({ ok: true }));
    await approve("a1", "req-1");
    expect(apiFetch).toHaveBeenCalledWith("/api/channel-actions/a1/approve", { method: "POST", body: JSON.stringify({ request_id: "req-1" }) });
    await approve("a2");
    const [path, init] = apiFetch.mock.calls[1];
    expect(path).toBe("/api/channel-actions/a2/approve");
    expect(JSON.parse(init.body).request_id.length).toBeGreaterThan(8);
  });

  it("asks for everything with all=1", async () => {
    apiFetch.mockResolvedValueOnce(ok({ actions: [], more: 0, store: "decisions" }));
    await listChannelActions("google_ads", { all: true });
    expect(apiFetch).toHaveBeenCalledWith("/api/channels/google_ads/actions?all=1");
  });

  it("posts a status with a request_id, generating one when absent", async () => {
    apiFetch.mockResolvedValue(ok({ ok: true }));
    await setChannelAction("a1", { action: "rejected", note: "Off brand" });
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe("/api/channel-actions/a1");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ action: "rejected", note: "Off brand" });
    expect(typeof sent.request_id).toBe("string");
    expect(sent.request_id.length).toBeGreaterThan(8);

    await setChannelAction("a1", { action: "snoozed", until: "2026-09-25T00:00:00Z", request_id: "fixed-id" });
    expect(JSON.parse(apiFetch.mock.calls[1][1].body).request_id).toBe("fixed-id");
  });

  it("posts a redo note", async () => {
    apiFetch.mockResolvedValueOnce(ok({ ok: true }));
    await redoChannelAction("a1", "Make it shorter");
    expect(apiFetch).toHaveBeenCalledWith("/api/channel-actions/a1/redo", { method: "POST", body: JSON.stringify({ note: "Make it shorter" }), idempotent: true });
  });

  it("reads metrics", async () => {
    const metric = { key: "impressions", value: 10, unit: "count", window_kind: "7d", day: "2026-09-17", grounded: true, prev_value: 8, prev_day: "2026-09-10" };
    apiFetch.mockResolvedValueOnce(ok({ metrics: [metric] }));
    expect(await listChannelMetrics("x_organic")).toEqual([metric]);
    expect(apiFetch).toHaveBeenCalledWith("/api/channels/x_organic/metrics");
  });

  it("throws the server's message on an error", async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "illegal transition" } }), { status: 409 }));
    await expect(setChannelAction("a1", { action: "acted" })).rejects.toThrow("illegal transition");
  });
});
