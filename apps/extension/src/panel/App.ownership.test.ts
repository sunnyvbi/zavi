
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
import { ownTabId } from "./own-tab";

let server: FakeServer;
let chromeFake: FakeChrome;
const open: Panel[] = [];

async function panelFor(tabId: number | null): Promise<Panel> {
  const p = new Panel(tabId);
  open.push(p);
  await p.mount();
  return p;
}

beforeEach(() => {
  server = newServer();
  installFetch(server);
  chromeFake = installChrome();
  chromeFake.tabs[9] = {
    id: 9,
    windowId: 99,
    url: "https://bank.example.com/statements",
    title: "Bank statement",
    active: true,
  };
});

afterEach(() => {
  while (open.length) open.pop()?.unmount();
  vi.unstubAllGlobals();
});

describe("the header names THIS panel's tab", () => {
  it("does not repaint with another window's active tab", async () => {
    const p = await panelFor(1);
    expect(p.text).toContain("Slack | DM with Sam");

    await p.act(() => {
      chromeFake.tabs[1].active = false;
      chromeFake.tabs[9].active = true;
      chromeFake.fire.activated(9);
    });

    expect(p.text).toContain("Slack | DM with Sam");
    expect(p.text).not.toContain("Bank statement");
  });
});

describe("a panel with no tab of its own claims nothing", () => {
  it("ownTabId is null when the path carries no id", async () => {
    window.history.replaceState({}, "", "/panel.html");
    expect(ownTabId()).toBeNull();
  });

  it("sends text-only rather than photographing a tab it guessed at", async () => {
    const p = await panelFor(null);
    await p.ask("what is on this page?");
    const [body] = callsTo(server, "POST", "/api/agents/operator/chat").map(
      (c) => c.body as Record<string, unknown>,
    );
    expect(body.image_paths).toBeUndefined();
    expect(body.page_context).toBeUndefined();
    expect(callsTo(server, "POST", "/api/extension/screenshot")).toHaveLength(0);
  });
});

describe("the operator's words survive a screen change", () => {
  it("every keystroke reaches the parent, so a screen swap can hand it back", async () => {
    const seen: string[] = [];
    const { Composer } = await import("./components/Composer");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const React = await import("react");

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(Composer, {
          busy: false,
          onSend: () => undefined,
          onTextChange: (t: string) => seen.push(t),
        }),
      );
    });

    const box = host.querySelector("textarea");
    if (!box) throw new Error("composer not rendered");
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (!setValue) throw new Error("no native value setter");
    await act(async () => {
      setValue.call(box, "summarise this thread");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(seen).toContain("summarise this thread");
    await act(async () => root.unmount());
    host.remove();
  });
});
