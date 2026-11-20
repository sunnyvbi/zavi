// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunEndThreadEvent } from "@/lib/workspace/decideRunUnread";

const TENANT = "tenant-1";

let captured: ((row: RunEndThreadEvent) => void) | null = null;
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: { onInsert: (row: RunEndThreadEvent) => void }) => {
    captured = opts.onInsert;
  },
}));

let mockTenant: string | null = TENANT;
vi.mock("./brain/useActiveTenant", () => ({
  useActiveTenant: () => mockTenant,
}));

const toastAdd = vi.fn();
vi.mock("@/components/ui/toast", () => ({ toast: { add: toastAdd, close: vi.fn() } }));

const markTabUnread = vi.fn();
const markThreadSeen = vi.fn();
let mockTabs: Array<{
  id: string;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
}> = [];
let mockActiveTabId = "";
vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({
    tabs: mockTabs,
    activeTabId: mockActiveTabId,
    markTabUnread,
    markThreadSeen,
  }),
}));

let onScreen = new Set<string>();
vi.mock("./onScreenThreads", () => ({
  isThreadOnScreen: (id: string | null) => id !== null && onScreen.has(id),
}));

let readable = new Set<string>();
let threadTitles: Record<string, string | null> = {};
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => ({
            data: readable.has(id) ? { id, title: threadTitles[id] ?? null } : null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

const { RunCompletionWatcher } = await import("./RunCompletionWatcher");
const { resetTabTitle } = await import("@/lib/workspace/tabTitle");
const { ATTENTION_CHANGED_EVENT } = await import("@/lib/workspace/needsYou");
function agentTab(id: string, slug: string, threadId: string | null = null) {
  return { id, kind: "agent", title: slug, payload: { kind: "agent", slug, threadId } };
}

function runEnd(over: Partial<RunEndThreadEvent> = {}): RunEndThreadEvent {
  return {
    id: 1,
    kind: "run_end",
    tenant_id: TENANT,
    agent_slug: "engineer",
    agent_run_id: `run-${Math.random()}`,
    thread_id: null,
    body: { status: "success" },
    ...over,
  };
}

function mount(): (row: RunEndThreadEvent) => void {
  captured = null;
  renderToStaticMarkup(React.createElement(RunCompletionWatcher));
  if (!captured) throw new Error("useRealtimeChannel never received an onInsert");
  return captured;
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  if (!hidden) document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  setHidden(false);
  resetTabTitle();
});

beforeEach(() => {
  markTabUnread.mockClear();
  markThreadSeen.mockClear();
  toastAdd.mockClear();
  onScreen = new Set();
  readable = new Set(["thread-1"]);
  threadTitles = {};
  document.title = "Zavi";
  mockTenant = TENANT;
  mockTabs = [];
  mockActiveTabId = "";
});

describe("RunCompletionWatcher — handler trust boundary", () => {
  it("ignores a non-run_end event kind", () => {
    mockTabs = [agentTab("tab-1", "engineer")];
    mockActiveTabId = "other";
    mount()(runEnd({ kind: "tool_call" }));
    expect(markTabUnread).not.toHaveBeenCalled();
  });

  it("ignores a row from a FOREIGN tenant (defense-in-depth recheck)", () => {
    mockTabs = [agentTab("tab-1", "engineer")];
    mockActiveTabId = "other";
    mount()(runEnd({ tenant_id: "some-other-tenant" }));
    expect(markTabUnread).not.toHaveBeenCalled();
  });
});

describe("RunCompletionWatcher — the active tab is never flagged unread", () => {
  it("does not flag the active tab for a bound-thread run on that thread", () => {
    mockTabs = [agentTab("tab-1", "engineer", "thread-1")];
    mockActiveTabId = "tab-1";
    mount()(runEnd({ thread_id: "thread-1" }));
    expect(markTabUnread).not.toHaveBeenCalled();
  });

  it("does not flag the active tab for a broadcast run", () => {
    mockTabs = [agentTab("tab-1", "engineer")];
    mockActiveTabId = "tab-1";
    mount()(runEnd({ thread_id: null }));
    expect(markTabUnread).not.toHaveBeenCalled();
  });

  it("still flags a BACKGROUND tab bound to that thread", () => {
    mockTabs = [agentTab("tab-1", "engineer", "thread-1"), agentTab("tab-2", "pm")];
    mockActiveTabId = "tab-2";
    mount()(runEnd({ thread_id: "thread-1" }));
    expect(markTabUnread).toHaveBeenCalledWith("tab-1");
  });
});

describe("RunCompletionWatcher — broadcast coverage (the signal with no other surface)", () => {
  it("flags a background tab of the same slug for a broadcast run", () => {
    mockTabs = [agentTab("tab-1", "engineer"), agentTab("tab-2", "pm")];
    mockActiveTabId = "tab-2";
    mount()(runEnd({ thread_id: null }));
    expect(markTabUnread).toHaveBeenCalledWith("tab-1");
  });

  it("a broadcast run does not flag a tab bound to a THREAD (it would light that thread's bell)", () => {
    mockTabs = [agentTab("tab-1", "engineer", "thread-1"), agentTab("tab-2", "pm")];
    mockActiveTabId = "tab-2";
    mount()(runEnd({ thread_id: null }));
    expect(markTabUnread).not.toHaveBeenCalled();
  });

  it("does not flag a tab belonging to a DIFFERENT agent", () => {
    mockTabs = [agentTab("tab-1", "pm")];
    mockActiveTabId = "other";
    mount()(runEnd({ agent_slug: "engineer", thread_id: null }));
    expect(markTabUnread).not.toHaveBeenCalled();
  });

  it("does not flag a non-agent tab", () => {
    mockTabs = [{ id: "tab-1", kind: "brain", title: "Brain", payload: { kind: "brain" } }];
    mockActiveTabId = "other";
    mount()(runEnd({ thread_id: null }));
    expect(markTabUnread).not.toHaveBeenCalled();
  });

  it("skips a cancelled run — the user stopped it on purpose", () => {
    mockTabs = [agentTab("tab-1", "engineer")];
    mockActiveTabId = "other";
    mount()(runEnd({ thread_id: null, body: { status: "cancelled" } }));
    expect(markTabUnread).not.toHaveBeenCalled();
  });

  it("flags an ERRORED bound run — TabActivityWatcher cannot see it", () => {
    mockTabs = [agentTab("tab-1", "engineer", "thread-1"), agentTab("tab-2", "pm")];
    mockActiveTabId = "tab-2";
    mount()(runEnd({ thread_id: "thread-1", body: { status: "error" } }));
    expect(markTabUnread).toHaveBeenCalledWith("tab-1");
  });
});

describe("RunCompletionWatcher — dedupe", () => {
  it("flags a given run only once, even if the row arrives twice", () => {
    mockTabs = [agentTab("tab-1", "engineer")];
    mockActiveTabId = "other";
    const onInsert = mount();
    const row = runEnd({ thread_id: null, agent_run_id: "run-dup" });
    onInsert(row);
    onInsert(row);
    expect(markTabUnread).toHaveBeenCalledTimes(1);
  });
});

function notifiable(over: Partial<RunEndThreadEvent> = {}): RunEndThreadEvent {
  return runEnd({
    thread_id: "thread-1",
    body: { status: "success", trigger: "chat", answered: true },
    ...over,
  });
}

function listen(): { count: () => number; off: () => void } {
  let n = 0;
  const fn = () => {
    n += 1;
  };
  window.addEventListener(ATTENTION_CHANGED_EVENT, fn);
  return { count: () => n, off: () => window.removeEventListener(ATTENTION_CHANGED_EVENT, fn) };
}

describe("RunCompletionWatcher — no popup", () => {
  it("never raises a toast, for a reply or a question", async () => {
    const onInsert = mount();
    onInsert(notifiable());
    onInsert(notifiable({ agent_run_id: "q", body: { status: "success", trigger: "chat", question: true } }));
    await flush();
    expect(toastAdd).not.toHaveBeenCalled();
  });
});

describe("RunCompletionWatcher — the needs-you refetch", () => {
  it("the attention doorbell asks for a refetch and nothing else", () => {
    mockTabs = [agentTab("tab-1", "engineer")];
    mockActiveTabId = "other";
    const l = listen();
    mount()(runEnd({ kind: "attention" as RunEndThreadEvent["kind"], body: {} as RunEndThreadEvent["body"] }));
    expect(l.count()).toBe(1);
    expect(markTabUnread).not.toHaveBeenCalled();
    l.off();
  });

  it("a foreign-tenant doorbell is ignored", () => {
    const l = listen();
    mount()(runEnd({ kind: "attention" as RunEndThreadEvent["kind"], tenant_id: "other" }));
    expect(l.count()).toBe(0);
    l.off();
  });

  it("every run_end asks for a refetch (a question lands on the line)", () => {
    const l = listen();
    mount()(notifiable());
    expect(l.count()).toBe(1);
    l.off();
  });
});

describe("RunCompletionWatcher — a reply you watch land is read", () => {
  it("re-marks the thread seen when its reply lands on screen", () => {
    onScreen = new Set(["thread-1"]);
    mount()(notifiable());
    expect(markThreadSeen).toHaveBeenCalledWith("thread-1", { again: true });
  });

  it("does not mark a reply seen when its thread is not on screen", () => {
    mount()(notifiable());
    expect(markThreadSeen).not.toHaveBeenCalled();
  });

  it("does not mark it seen when the browser tab is hidden, even with the thread rendered", () => {
    onScreen = new Set(["thread-1"]);
    setHidden(true);
    mount()(notifiable());
    expect(markThreadSeen).not.toHaveBeenCalled();
  });
});

describe("RunCompletionWatcher — the background-tab title", () => {
  it("counts a reply in the title while the browser tab is hidden", async () => {
    setHidden(true);
    mount()(notifiable());
    await flush();
    expect(document.title).toBe("(1) Engineer replied · Zavi");
  });

  it("says needs you for a question", async () => {
    setHidden(true);
    mount()(notifiable({ body: { status: "success", trigger: "chat", question: true } }));
    await flush();
    expect(document.title).toMatch(/^\(1\) .+ needs you · Zavi$/);
  });

  it("counts a redelivered run once", async () => {
    setHidden(true);
    const onInsert = mount();
    const row = notifiable({ agent_run_id: "run-same" });
    onInsert(row);
    onInsert(row);
    await flush();
    expect(document.title).toBe("(1) Engineer replied · Zavi");
  });

  it("leaves the title alone while the tab is visible", async () => {
    mount()(notifiable());
    await flush();
    expect(document.title).toBe("Zavi");
  });

  it("does not count a TEAMMATE's chat run (a thread this user cannot read)", async () => {
    setHidden(true);
    readable = new Set();
    mount()(notifiable());
    await flush();
    expect(document.title).toBe("Zavi");
  });

  it("does not count a Slack or cron run", async () => {
    setHidden(true);
    const onInsert = mount();
    onInsert(notifiable({ body: { status: "success", trigger: "slack", answered: true } }));
    onInsert(notifiable({ agent_run_id: "c", thread_id: null, body: { status: "success", trigger: "cron" } }));
    await flush();
    expect(document.title).toBe("Zavi");
  });

  it("restores the title when the founder comes back", async () => {
    setHidden(true);
    mount()(notifiable());
    await flush();
    setHidden(false);
    expect(document.title).toBe("Zavi");
  });
});
