import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { useChannelActions } from "./useChannelActions";
import { makeAction } from "./__tests__/fixtures";

const SLUG = "linkedin_ads";
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const card = makeAction("check", { id: "ca-1", channel_slug: SLUG });

let staleList = true;
let post: () => Promise<unknown>;
const listReads = () => apiFetch.mock.calls.filter(([p, init]) => !init?.method && /\/actions(\?|$)/.test(String(p))).length;

beforeEach(() => {
  staleList = true;
  apiFetch.mockReset().mockImplementation((path: string, init?: { method?: string }) => {
    const u = String(path);
    if (init?.method === "POST") return post();
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({ actions: staleList ? [card] : [], more: 0, store: "channel_actions", plan: null });
  });
});
afterEach(cleanup);

const mount = async () => {
  const hook = renderHook(() => useChannelActions(SLUG));
  await waitFor(() => expect(hook.result.current.actions).toHaveLength(1));
  return hook;
};

const refusal = (status: number, code: string, message: string) => () =>
  Promise.resolve({ ok: false, status, json: async () => ({ error: { code, message } }) });

describe("Redo on a card that was handled somewhere else", () => {
  for (const status of ["acted", "redone"]) {
    it(`a 409 'action is ${status}' says so in plain words, drops the card at once and reloads the list`, async () => {
      const { result } = await mount();
      post = refusal(409, "not_open", `action is ${status}`);
      const before = listReads();
      let started: unknown;
      await act(async () => {
        started = await result.current.handlers.onRedo(card, "shorter please");
      });
      expect(started).toBe(false);
      expect(result.current.notice).toBe("This card was already handled, so Zavi refreshed the list.");
      expect(result.current.notice).not.toMatch(/action is/);
      expect(result.current.actions.map((a) => a.id)).not.toContain("ca-1");
      await waitFor(() => expect(listReads()).toBeGreaterThan(before));
      expect(result.current.actions).toHaveLength(0);
      expect(result.current.redoState["ca-1"]).toBeUndefined();
    });
  }

  it("a card deleted elsewhere (404) is handled the same way", async () => {
    const { result } = await mount();
    post = refusal(404, "not_found", "Action not found.");
    await act(async () => {
      await result.current.handlers.onRedo(card, "again");
    });
    expect(result.current.notice).toBe("This card was already handled, so Zavi refreshed the list.");
    expect(result.current.actions).toHaveLength(0);
  });

  it("a redo already running (409 redo_in_flight) keeps the card and the server's own words", async () => {
    const { result } = await mount();
    const words = "Zavi is already redoing this card with your earlier note. Wait for it to finish, then redo it again.";
    post = refusal(409, "redo_in_flight", words);
    await act(async () => {
      await result.current.handlers.onRedo(card, "again");
    });
    expect(result.current.notice).toBe(words);
    expect(result.current.actions.map((a) => a.id)).toEqual(["ca-1"]);
  });
});
