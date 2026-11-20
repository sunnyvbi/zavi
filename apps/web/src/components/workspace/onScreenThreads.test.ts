// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import {
  onThreadPaneRequest,
  onThreadViewsChanged,
  requestThreadPane,
  setThreadView,
  tabShowingThread,
  takeThreadPaneRequest,
} from "./onScreenThreads";
import { vi } from "vitest";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.getElementById("thread") as HTMLElement;
}

afterEach(() => {
  setThreadView("v", null);
  document.body.innerHTML = "";
});

describe("tabShowingThread", () => {
  it("returns the tab when the view is hidden only because its tab is inactive", () => {
    const el = mount(`<div data-tab-id="tab-d" style="display:none"><div id="thread"></div></div>`);
    setThreadView("v", { threadId: "t1", el: () => el });
    expect(tabShowingThread("t1")).toBe("tab-d");
  });

  it("skips a view hidden INSIDE its tab (folded chat): activating the tab reveals nothing", () => {
    const el = mount(
      `<div data-tab-id="tab-c"><aside style="display:none"><div id="thread"></div></aside></div>`,
    );
    setThreadView("v", { threadId: "t1", el: () => el });
    expect(tabShowingThread("t1")).toBeNull();
  });

  it("skips a view outside any tab (the channel column)", () => {
    const el = mount(`<div><div id="thread"></div></div>`);
    setThreadView("v", { threadId: "t1", el: () => el });
    expect(tabShowingThread("t1")).toBeNull();
  });

  it("ignores views of other threads", () => {
    const el = mount(`<div data-tab-id="tab-d"><div id="thread"></div></div>`);
    setThreadView("v", { threadId: "t2", el: () => el });
    expect(tabShowingThread("t1")).toBeNull();
  });
});

describe("change notifications", () => {
  it("tells listeners when a view registers or leaves", () => {
    const fn = vi.fn();
    const off = onThreadViewsChanged(fn);
    setThreadView("v", { threadId: "t1", el: () => null });
    setThreadView("v", null);
    off();
    setThreadView("v", { threadId: "t1", el: () => null });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("thread pane requests", () => {
  it("holds a request until the tab takes it, once", () => {
    requestThreadPane("tab-1", "t1");
    expect(takeThreadPaneRequest("tab-2")).toBeNull();
    expect(takeThreadPaneRequest("tab-1")).toBe("t1");
    expect(takeThreadPaneRequest("tab-1")).toBeNull();
  });

  it("pings a mounted tab so it can take the request now", () => {
    const fn = vi.fn();
    const off = onThreadPaneRequest(fn);
    requestThreadPane("tab-1", "t1");
    off();
    expect(fn).toHaveBeenCalledWith("tab-1");
    takeThreadPaneRequest("tab-1");
  });
});
