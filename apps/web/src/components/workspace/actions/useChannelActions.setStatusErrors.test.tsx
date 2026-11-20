// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { useChannelActions } from "./useChannelActions";
import { makeAction } from "./__tests__/fixtures";

const SLUG = "email_marketing";
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const card = makeAction("send_message", { id: "ca-1", channel_slug: SLUG });

let closedElsewhere = false;
let post: () => Promise<unknown>;
const listReads = () => apiFetch.mock.calls.filter(([p, init]) => !init?.method && /\/actions(\?|$)/.test(String(p))).length;

beforeEach(() => {
  closedElsewhere = false;
  apiFetch.mockReset().mockImplementation((path: string, init?: { method?: string }) => {
    const u = String(path);
    if (init?.method === "POST") return post();
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({ actions: closedElsewhere ? [] : [card], more: 0, store: "channel_actions", plan: null });
  });
});
afterEach(cleanup);

const mount = async () => {
  const hook = renderHook(() => useChannelActions(SLUG));
  await waitFor(() => expect(hook.result.current.actions).toHaveLength(1));
  return hook;
};

describe("I did this / Not now when the write fails", () => {
  it("a card closed in another tab (409) says so in plain words and reloads the list", async () => {
    const { result } = await mount();
    post = () => {
      closedElsewhere = true;
      return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: { code: "illegal_transition", message: "That action can't be changed from here." } }) });
    };
    const before = listReads();
    let saved: unknown;
    await act(async () => {
      saved = await result.current.handlers.onSetStatus(card, "acted");
    });
    expect(saved).toBe(false);
    expect(result.current.notice).toBe("This card changed somewhere else, so the list now shows the latest.");
    await waitFor(() => expect(listReads()).toBeGreaterThan(before));
    await waitFor(() => expect(result.current.actions).toHaveLength(0));
  });

  it("a card removed elsewhere (404) on Not now reloads too", async () => {
    const { result } = await mount();
    post = () => {
      closedElsewhere = true;
      return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: { code: "not_found", message: "That action can't be changed from here." } }) });
    };
    await act(async () => {
      await result.current.handlers.onSetStatus(card, "snoozed", { until: "2026-11-04T00:00:00Z" });
    });
    expect(result.current.notice).toBe("This card changed somewhere else, so the list now shows the latest.");
    await waitFor(() => expect(result.current.actions).toHaveLength(0));
  });

  it("a dropped connection does not show the browser's raw text and does not reload", async () => {
    const { result } = await mount();
    post = () => Promise.reject(new TypeError("Failed to fetch"));
    const before = listReads();
    await act(async () => {
      await result.current.handlers.onSetStatus(card, "acted");
    });
    expect(result.current.notice).toBe("Zavi could not save that. Try again.");
    expect(listReads()).toBe(before);
    expect(result.current.actions).toHaveLength(1);
  });

  it("a server error with no message does not show an HTTP code", async () => {
    const { result } = await mount();
    post = () => Promise.resolve({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } });
    await act(async () => {
      await result.current.handlers.onSetStatus(card, "acted");
    });
    expect(result.current.notice).toBe("Zavi could not save that. Try again.");
    expect(result.current.notice).not.toMatch(/HTTP|\d{3}|undefined|null/);
  });

  it("a change still being applied (409 exec_in_flight) says to wait, not that the card changed elsewhere, and keeps the card", async () => {
    const { result } = await mount();
    post = () => Promise.resolve({ ok: false, status: 409, json: async () => ({ error: { code: "exec_in_flight", message: "That action can't be changed from here." } }) });
    const before = listReads();
    let saved: unknown;
    await act(async () => {
      saved = await result.current.handlers.onSetStatus(card, "snoozed", { until: "2026-11-04T00:00:00Z" });
    });
    expect(saved).toBe(false);
    expect(result.current.notice).toBe("Zavi is making this change now. Wait for it to finish, then try again.");
    expect(result.current.notice).not.toMatch(/somewhere else|can't be changed/);
    await waitFor(() => expect(listReads()).toBeGreaterThan(before));
    expect(result.current.actions).toHaveLength(1);
  });

  it("a refusal with no words (4xx) does not ask for a retry that cannot work and shows no HTTP code", async () => {
    const { result } = await mount();
    post = () => Promise.resolve({ ok: false, status: 413, json: async () => { throw new SyntaxError("Unexpected token <"); } });
    const before = listReads();
    await act(async () => {
      await result.current.handlers.onSetStatus(card, "rejected", { note: "x" });
    });
    expect(result.current.notice).toBe("Zavi could not save that.");
    expect(result.current.notice).not.toMatch(/HTTP|\d{3}|Try again/);
    expect(listReads()).toBe(before);
  });

  it("a plain refusal keeps the server's own words", async () => {
    const { result } = await mount();
    post = () => Promise.resolve({ ok: false, status: 400, json: async () => ({ error: { code: "bad_request", message: "That note is too long." } }) });
    await act(async () => {
      await result.current.handlers.onSetStatus(card, "rejected", { note: "x" });
    });
    expect(result.current.notice).toBe("That note is too long.");
  });
});
