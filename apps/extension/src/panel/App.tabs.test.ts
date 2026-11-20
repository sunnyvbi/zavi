
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({
  supabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: "test-token" } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  }),
}));
vi.mock("./auth", () => ({ signOut: vi.fn() }));
vi.mock("../shared/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/config")>()),
  ANSWER_POLL_MS: 0,
  THREAD_IDLE_POLL_MS: 3_600_000,
}));

import {
  Panel,
  callsTo,
  installChrome,
  installFetch,
  newServer,
  type FakeChrome,
  type FakeServer,
} from "./test-harness";

let server: FakeServer;
let chromeFake: FakeChrome;
const open: Panel[] = [];

async function panelFor(tabId: number): Promise<Panel> {
  const p = new Panel(tabId);
  open.push(p);
  await p.mount();
  return p;
}

function chatBodies(): Record<string, unknown>[] {
  return callsTo(server, "POST", "/api/agents/operator/chat").map(
    (c) => c.body as Record<string, unknown>,
  );
}

beforeEach(() => {
  server = newServer();
  installFetch(server);
  chromeFake = installChrome();
  chromeFake.tabs[2] = {
    id: 2,
    windowId: 7,
    url: "https://mail.google.com/mail/u/0?compose=new",
    title: "Inbox",
    active: true,
  };
});

afterEach(() => {
  while (open.length) open.pop()?.unmount();
  vi.unstubAllGlobals();
});

describe("each tab has its own conversation", () => {
  it("two tabs get two thread ids and neither shows the other's messages", async () => {
    chromeFake.tabs[2].active = false;
    const one = await panelFor(1);
    await one.ask("what did Sam commit to?");
    expect(one.text).toContain("answer 1");
    one.unmount();

    chromeFake.tabs[1].active = false;
    chromeFake.tabs[2].active = true;
    const two = await panelFor(2);
    expect(two.text).not.toContain("answer 1");
    await two.ask("and this invoice?");

    const [first, second] = chatBodies();
    expect(first.thread_id).toBeNull();
    expect(second.thread_id).toBeNull();
    expect(server.threadSeq).toBe(2);
    expect(two.text).toContain("answer 2");
    expect(two.text).not.toContain("answer 1");
  });

  it("re-mounting the panel on the same tab restores that tab's thread", async () => {
    chromeFake.tabs[2].active = false;
    const one = await panelFor(1);
    await one.ask("what did Sam commit to?");
    one.unmount();

    const again = await panelFor(1);
    expect(again.text).toContain("answer 1");

    await again.ask("and the deadline?");
    const bodies = chatBodies();
    expect(bodies[1].thread_id).toBe("thread-1");
    expect(server.threadSeq).toBe(1);
  });

  it("a different tab restored from storage stays different", async () => {
    chromeFake.tabs[2].active = false;
    const one = await panelFor(1);
    await one.ask("tab one question");
    one.unmount();

    chromeFake.tabs[1].active = false;
    chromeFake.tabs[2].active = true;
    const two = await panelFor(2);
    await two.ask("tab two question");
    two.unmount();

    chromeFake.tabs[2].active = false;
    chromeFake.tabs[1].active = true;
    const back = await panelFor(1);
    expect(back.text).toContain("answer 1");
    expect(back.text).not.toContain("answer 2");
  });

  it("navigating the tab keeps the conversation", async () => {
    chromeFake.tabs[2].active = false;
    const one = await panelFor(1);
    await one.ask("what is this?");

    chromeFake.tabs[1].url = "https://github.com/rravi149/praxis/pull/1";
    chromeFake.tabs[1].title = "Pull request";
    await one.act(() => {
      chromeFake.fire.updated(1, { status: "loading", url: chromeFake.tabs[1].url });
      chromeFake.fire.updated(1, { status: "complete", title: "Pull request" });
      chromeFake.fire.updated(1, { url: "https://github.com/rravi149/praxis/pull/1/files" });
      chromeFake.fire.activated(1);
    });

    await one.ask("and now?");

    const bodies = chatBodies();
    expect(bodies[1].thread_id).toBe("thread-1");
    expect(server.threadSeq).toBe(1);
    expect(one.text).toContain("answer 1");
    expect(one.text).toContain("answer 2");
  });
});

describe("a Send photographs the panel's own tab", () => {
  it("captures tab 1's window and labels it with tab 1, while tab 2 is in front", async () => {
    chromeFake.tabs[2].windowId = 9;
    chromeFake.tabs[2].active = true;

    const one = await panelFor(1);
    await one.ask("what is on this page?");

    expect(chromeFake.captureVisibleTab).toHaveBeenCalledWith(7, {
      format: "jpeg",
      quality: 70,
    });
    const body = chatBodies()[0];
    expect(body.page_context).toEqual({
      mode: "screenshot",
      url: "https://app.slack.com/client/T1/D1",
      title: "Slack | DM with Sam",
    });
  });

  it("sends text only when the panel's own tab is not the one in front", async () => {
    chromeFake.tabs[1].active = false;
    chromeFake.tabs[2].active = true;

    const one = await panelFor(1);
    await one.ask("what is on this page?");

    expect(chromeFake.captureVisibleTab).not.toHaveBeenCalled();
    expect(callsTo(server, "POST", "/api/extension/screenshot")).toHaveLength(0);
    expect(chatBodies()[0]).not.toHaveProperty("page_context");
  });
});

describe("the tab to thread map", () => {
  it("is written to chrome.storage.session, not to anything that outlives Chrome", async () => {
    chromeFake.tabs[2].active = false;
    const one = await panelFor(1);
    await one.ask("remember me");
    expect(chromeFake.session["zv:tab-threads"]).toEqual({ "1": "thread-1" });
  });

  it("starting a new thread clears the tab's row rather than leaving a stale one", async () => {
    chromeFake.tabs[2].active = false;
    const one = await panelFor(1);
    await one.ask("remember me");
    await one.click('button[aria-label="Start a new thread"]');
    expect(chromeFake.session["zv:tab-threads"]).toEqual({});
  });
});
