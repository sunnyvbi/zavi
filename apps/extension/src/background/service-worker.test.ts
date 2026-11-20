
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fakeSessionArea } from "../panel/test-harness";

type Listener = (...args: unknown[]) => unknown;

type Harness = {
  clickTab: Listener | null;
  removeTab: Listener | null;
  installed: Listener | null;
  setOptions: Mock<unknown[], Promise<void>>;
  open: Mock<unknown[], Promise<void>>;
  setPanelBehavior: Mock<unknown[], Promise<void>>;
  session: Record<string, unknown>;
};

let h: Harness;

async function loadWorker(): Promise<void> {
  h = {
    clickTab: null,
    removeTab: null,
    installed: null,
    setOptions: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
    open: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
    setPanelBehavior: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
    session: {},
  };
  vi.stubGlobal("chrome", {
    action: {
      onClicked: { addListener: (fn: Listener) => (h.clickTab = fn) },
    },
    tabs: {
      onRemoved: { addListener: (fn: Listener) => (h.removeTab = fn) },
    },
    runtime: {
      onInstalled: { addListener: (fn: Listener) => (h.installed = fn) },
      onMessage: { addListener: vi.fn() },
    },
    sidePanel: {
      setOptions: h.setOptions,
      open: h.open,
      setPanelBehavior: h.setPanelBehavior,
    },
    identity: { launchWebAuthFlow: vi.fn() },
    storage: { session: fakeSessionArea(h.session) },
  });
  vi.resetModules();
  await import("./service-worker");
}

beforeEach(async () => {
  await loadWorker();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the toolbar click opens the panel for THAT tab only", () => {
  it("enables the clicked tab, with its own id in the path, and opens it", async () => {
    expect(h.clickTab).toBeTypeOf("function");
    h.clickTab?.({ id: 42, windowId: 3 });

    expect(h.setOptions).toHaveBeenCalledTimes(1);
    expect(h.setOptions).toHaveBeenCalledWith({
      tabId: 42,
      path: "panel.html?tabId=42",
      enabled: true,
    });
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.open).toHaveBeenCalledWith({ tabId: 42 });
  });

  it("names no other tab: a second click enables only the second tab", () => {
    h.clickTab?.({ id: 42, windowId: 3 });
    h.clickTab?.({ id: 77, windowId: 3 });

    const ids = h.setOptions.mock.calls.map((c) => (c[0] as { tabId: number }).tabId);
    expect(ids).toEqual([42, 77]);
    for (const call of h.setOptions.mock.calls) {
      expect(call[0]).toHaveProperty("tabId");
    }
    expect(h.open.mock.calls.map((c) => c[0])).toEqual([{ tabId: 42 }, { tabId: 77 }]);
  });

  it("sets options BEFORE open, so the tab has a path to open", () => {
    h.clickTab?.({ id: 42, windowId: 3 });
    expect(h.setOptions.mock.invocationCallOrder[0]).toBeLessThan(
      h.open.mock.invocationCallOrder[0],
    );
  });

  it("opens nothing for a tab with no id", () => {
    h.clickTab?.({ windowId: 3 });
    expect(h.setOptions).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("never hands the click back to Chrome's global panel behaviour", () => {
    h.installed?.();
    expect(h.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
  });
});

describe("closing a tab drops its conversation", () => {
  it("onRemoved clears that tab's mapping and leaves the others alone", async () => {
    h.session["zv:tab-threads"] = { "42": "thread-a", "77": "thread-b" };

    h.removeTab?.(42, { windowId: 3, isWindowClosing: false });
    await new Promise((r) => setTimeout(r, 0));

    expect(h.session["zv:tab-threads"]).toEqual({ "77": "thread-b" });
  });

  it("a tab with no conversation is a no-op, not a throw", async () => {
    h.session["zv:tab-threads"] = { "77": "thread-b" };
    h.removeTab?.(42, { windowId: 3, isWindowClosing: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.session["zv:tab-threads"]).toEqual({ "77": "thread-b" });
  });
});
