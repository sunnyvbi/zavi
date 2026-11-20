// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
const clearers = vi.hoisted(() => [] as Array<() => void>);
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("./sessionScopedCache", () => ({ registerSessionScopedCache: (c: () => void) => clearers.push(c) }));

import { flushTabs, persistTabs } from "./tabsSession";

const state = { tabs: [], active_tab_id: "a" };
const save = async (s = state) => {
  persistTabs(s);
  await vi.advanceTimersByTimeAsync(600);
};

describe("saving the tab session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetch.mockReset();
    for (const clear of clearers) clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the same tabs twice send one save; different tabs send again", async () => {
    apiFetch.mockResolvedValue({ ok: true });
    await save();
    await save();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await save({ tabs: [], active_tab_id: "b" });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("a failed save is sent again", async () => {
    apiFetch.mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    await save();
    await save();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("a switch back while a save is in flight is still saved last", async () => {
    let finishB!: (v: unknown) => void;
    apiFetch.mockResolvedValueOnce({ ok: true }).mockReturnValueOnce(new Promise((r) => (finishB = r))).mockResolvedValue({ ok: true });
    const a = { tabs: [], active_tab_id: "a" };
    await save(a);
    await save({ tabs: [], active_tab_id: "b" });
    await save(a);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    finishB({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(apiFetch.mock.calls[2][1].body).active_tab_id).toBe("a");
  });

  it("closing the page sends the newest tabs and drops an older queued save", async () => {
    let finishB!: (v: unknown) => void;
    apiFetch.mockReturnValueOnce(new Promise((r) => (finishB = r))).mockResolvedValue({ ok: true });
    await save({ tabs: [], active_tab_id: "b" });
    await save({ tabs: [], active_tab_id: "queued" });
    persistTabs({ tabs: [], active_tab_id: "closing" });
    flushTabs();
    finishB({ ok: true });
    await vi.advanceTimersByTimeAsync(600);
    const sent = apiFetch.mock.calls.map((c) => JSON.parse(c[1].body).active_tab_id);
    expect(sent).toEqual(["b", "closing"]);
  });

  it("the same tabs after a sign-out are saved for the next person", async () => {
    apiFetch.mockResolvedValue({ ok: true });
    await save();
    for (const clear of clearers) clear();
    await save();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
