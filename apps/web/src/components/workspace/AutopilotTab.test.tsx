import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  seedComposer: vi.fn(),
  chats: [] as Array<Record<string, unknown>>,
  listChats: vi.fn(),
  openAgentTab: vi.fn(),
  setActiveTab: vi.fn(),
  setTabThreadId: vi.fn(),
  tabs: [] as unknown[],
}));

vi.mock("@/lib/workspace/agentChatsApi", () => ({ listAgentChats: h.listChats }));

vi.mock("@/lib/workspace/useGrowthStrategy", () => ({
  useGrowthStrategy: () => ({ strategy: {}, intakeStarted: true, loading: false, reload: vi.fn() }),
}));
vi.mock("./WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({
    seedComposer: h.seedComposer,
    tabs: h.tabs,
    openAgentTab: h.openAgentTab,
    setActiveTab: h.setActiveTab,
    setTabThreadId: h.setTabThreadId,
  }),
}));
vi.mock("./GrowthCoachPage", () => ({
  GrowthCoachPage: ({ onAsk }: { onAsk?: (text: string) => void }) => (
    <button type="button" onClick={() => onAsk?.("Tell me about my goal")}>
      Ask Zavi
    </button>
  ),
}));
vi.mock("./sidechat/SideChat", async (orig) => ({
  ...(await orig<typeof import("./sidechat/SideChat")>()),
  SideChat: (props: Record<string, unknown>) => {
    h.chats.push(props);
    return (
      <aside id={props.id as string} hidden={!props.open}>
        <span>{props.title as string}</span>
        <span>{props.contextLine as string}</span>
        {props.headerActions as ReactNode}
        <button type="button" onClick={props.onClose as () => void}>
          Hide the chat
        </button>
        <textarea aria-label="Growth draft" />
      </aside>
    );
  },
}));

import { AutopilotTab } from "./AutopilotTab";

function setCompact(compact: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: compact && query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  h.seedComposer.mockReset();
  h.chats = [];
  h.listChats.mockReset();
  h.openAgentTab.mockReset();
  h.setActiveTab.mockReset();
  h.setTabThreadId.mockReset();
  h.tabs = [];
  h.listChats.mockResolvedValue([]);
  setCompact(false);
});
afterEach(cleanup);

const chatShown = (c: HTMLElement) => {
  const aside = c.querySelector("#growth-chat-panel");
  return !!aside && !aside.hasAttribute("hidden");
};

it("desktop: the chat is open beside the plan, as the CGO", () => {
  const view = render(<AutopilotTab />);
  expect(chatShown(view.container)).toBe(true);
  expect(screen.getByText("Zavi")).toBeTruthy();
  expect(screen.getByText("Growth strategy")).toBeTruthy();
  const props = h.chats.at(-1)!;
  expect(props.agentSlug).toBe("cgo");
  expect(props.thread).toBe("fresh");
  expect(props.tabId).toBe("growth");
  expect(screen.queryByRole("button", { name: "Show the chat" })).toBeNull();
});

it("resumes the conversation its tab bound, so coming back to Growth is not a blank chat", () => {
  h.tabs = [{ id: "growth", payload: { kind: "autopilot", threadId: "thread-kept" } }];
  render(<AutopilotTab />);
  expect(h.chats.at(-1)!.boundThreadId).toBe("thread-kept");
});

it("folds to the 48px rail and comes back with the draft intact", () => {
  const view = render(<AutopilotTab />);
  const draft = screen.getByRole("textbox", { name: "Growth draft" });
  fireEvent.change(draft, { target: { value: "Focus on activation" } });
  fireEvent.click(screen.getByRole("button", { name: "Hide the chat" }));
  expect(chatShown(view.container)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Show the chat" }));
  expect(chatShown(view.container)).toBe(true);
  expect(screen.getByRole("textbox", { name: "Growth draft" })).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe("Focus on activation");
});

it("remembers the fold across a reload", () => {
  render(<AutopilotTab />);
  fireEvent.click(screen.getByRole("button", { name: "Hide the chat" }));
  cleanup();
  const again = render(<AutopilotTab />);
  expect(chatShown(again.container)).toBe(false);
  expect(screen.getByRole("button", { name: "Show the chat" })).toBeTruthy();
});

it("a phone lands on the plan, with the chat one tap away", () => {
  setCompact(true);
  const view = render(<AutopilotTab />);
  expect(chatShown(view.container)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Chat with Zavi about your growth" }));
  expect(chatShown(view.container)).toBe(true);
  expect(h.chats.at(-1)!.fullBleed).toBe(true);
  expect(screen.queryByRole("button", { name: "Chat with Zavi about your growth" })).toBeNull();
});

it("l5.16: the phone chat slide-in starts below the outage banner, so the banner never covers its header", () => {
  setCompact(true);
  const view = render(<AutopilotTab />);
  fireEvent.click(screen.getByRole("button", { name: "Chat with Zavi about your growth" }));
  const overlay = [...view.container.querySelectorAll("div")].find((d) => d.className.includes("fixed") && d.className.includes("z-40"));
  expect(overlay).toBeTruthy();
  expect(overlay!.className).toContain("top-[var(--service-banner-h,0px)]");
  expect(overlay!.className).not.toMatch(/\binset-0\b/);
});

it("never mounts two chats on the same tab (a seed would be drained twice)", () => {
  const view = render(<AutopilotTab />);
  expect(view.container.querySelectorAll("#growth-chat-panel")).toHaveLength(1);
});

it("Ask Zavi opens a folded chat and prefills it, without sending", () => {
  const view = render(<AutopilotTab />);
  fireEvent.click(screen.getByRole("button", { name: "Hide the chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Ask Zavi" }));
  expect(chatShown(view.container)).toBe(true);
  expect(h.seedComposer).toHaveBeenCalledWith({
    agentSlug: "cgo",
    tabId: "growth",
    text: "Tell me about my goal",
  });
});

it("crossing the phone breakpoint keeps the SAME chat, so the draft survives", () => {
  const view = render(<AutopilotTab />);
  const draft = screen.getByRole("textbox", { name: "Growth draft" });
  fireEvent.change(draft, { target: { value: "Half a question" } });
  setCompact(true);
  view.rerender(<AutopilotTab />);
  expect(screen.getByRole("textbox", { name: "Growth draft", hidden: true })).toBe(draft);
  expect(h.chats.at(-1)!.fullBleed).toBe(true);
  setCompact(false);
  view.rerender(<AutopilotTab />);
  expect(screen.getByRole("textbox", { name: "Growth draft" })).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe("Half a question");
});

it("hydrates without a server/client mismatch", async () => {
  const html = renderToString(<AutopilotTab />);
  const host = document.createElement("div");
  const recoverableErrors: unknown[] = [];
  host.innerHTML = html;
  document.body.appendChild(host);
  const root = hydrateRoot(host, <AutopilotTab />, {
    onRecoverableError: (error) => recoverableErrors.push(error),
  });
  await act(async () => Promise.resolve());
  expect(recoverableErrors).toEqual([]);
  act(() => root.unmount());
  host.remove();
});

const row = (id: string, title: string) => ({
  id,
  title,
  preview: null,
  last_message_at: "2026-10-16T00:00:00Z",
  channel_action_id: null,
  card_title: null,
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

it("reopens the CGO's latest chat, holding the loading state until the lookup answers", async () => {
  let answer!: (rows: unknown[]) => void;
  h.listChats.mockReturnValueOnce(new Promise((r) => (answer = r)));
  render(<AutopilotTab />);
  expect(h.listChats).toHaveBeenCalledWith("cgo");
  expect(h.chats.at(-1)!.resolvingThread).toBe(true);
  await act(async () => answer([row("t-new", "Latest"), row("t-old", "Older")]));
  await settle();
  const props = h.chats.at(-1)!;
  expect(props.threadId).toBe("t-new");
  expect(props.resolvingThread).toBe(false);
  expect(screen.getByRole("button", { name: "New chat" })).toHaveProperty("disabled", false);
});

it("no earlier chat, or a failed lookup: starts fresh", async () => {
  h.listChats.mockRejectedValueOnce(new Error("offline"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  render(<AutopilotTab />);
  await settle();
  expect(h.chats.at(-1)!.threadId).toBeNull();
  expect(h.chats.at(-1)!.resolvingThread).toBe(false);
  expect(screen.getByRole("button", { name: "New chat" })).toHaveProperty("disabled", true);
  warn.mockRestore();
});

it("a send made before the lookup answers wins", async () => {
  let answer!: (rows: unknown[]) => void;
  h.listChats.mockReturnValueOnce(new Promise((r) => (answer = r)));
  render(<AutopilotTab />);
  act(() => (h.chats.at(-1)!.onThreadIdChange as (id: string) => void)("t-sent"));
  await act(async () => answer([row("t-new", "Latest")]));
  await settle();
  expect(h.chats.at(-1)!.threadId).toBe("t-sent");
});

it("New chat starts a fresh one; Past chats opens the picked one", async () => {
  h.listChats.mockResolvedValue([row("t-new", "Latest"), row("t-old", "Older chat")]);
  render(<AutopilotTab />);
  await settle();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  });
  expect(h.chats.at(-1)!.threadId).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
  });
  await settle();
  expect(screen.getByRole("dialog", { name: "Past chats on Growth" })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByText("Older chat"));
  });
  expect(h.chats.at(-1)!.threadId).toBe("t-old");
  expect(screen.queryByRole("dialog")).toBeNull();
});

const homeRow = (id: string, title: string) => ({ ...row(id, title), from_home: true });

it("never reopens a from-Home chat in the CGO side chat", async () => {
  h.listChats.mockResolvedValue([homeRow("t-home", "From Home"), row("t-own", "Own chat")]);
  render(<AutopilotTab />);
  await settle();
  expect(h.chats.at(-1)!.threadId).toBe("t-own");
});

it("a from-Home row is tagged and opens on Home, not in this side chat", async () => {
  h.listChats.mockResolvedValue([homeRow("t-home", "From Home")]);
  render(<AutopilotTab />);
  await settle();
  expect(h.chats.at(-1)!.threadId).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
  });
  await settle();
  expect(screen.getByText("from Home")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByText("From Home"));
  });
  expect(h.openAgentTab).toHaveBeenCalledWith("operator", { threadId: "t-home", push: true });
  expect(h.chats.at(-1)!.threadId).toBeNull();
});

it("a from-Home row binds into an open Home chat tab in one step", async () => {
  h.tabs = [
    { id: "op-1", kind: "agent", title: "operator", payload: { kind: "agent", slug: "operator", threadId: null }, dirty: false, pinned: false },
  ];
  h.listChats.mockResolvedValue([homeRow("t-home", "From Home")]);
  render(<AutopilotTab />);
  await settle();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
  });
  await settle();
  await act(async () => {
    fireEvent.click(screen.getByText("From Home"));
  });
  expect(h.setTabThreadId).toHaveBeenCalledWith("op-1", "t-home", { activate: true, push: true });
  expect(h.openAgentTab).not.toHaveBeenCalled();
});

it("a reload on an email chat the URL names stays on it", async () => {
  window.history.replaceState(null, "", `/workspace?tab=growth-strategy&chat=${B}`);
  h.listChats.mockResolvedValue([row(A, "Latest"), { ...row(B, "Re: budget"), from_email: true }]);
  render(<AutopilotTab />);
  await settle();
  expect(h.chats.at(-1)!.threadId).toBe(B);
});

it("a from-Home row opens on the pinned Home tab when there is one", async () => {
  h.tabs = [
    { id: "home-default", kind: "home", title: "Home", payload: { kind: "home" }, dirty: false, pinned: true },
    { id: "growth", kind: "autopilot", title: "Growth", payload: { kind: "autopilot" }, dirty: false, pinned: false },
  ];
  h.listChats.mockResolvedValue([homeRow("t-home", "From Home")]);
  render(<AutopilotTab />);
  await settle();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
  });
  await settle();
  await act(async () => {
    fireEvent.click(screen.getByText("From Home"));
  });
  expect(h.setTabThreadId).toHaveBeenCalledWith("home-default", "t-home", { activate: true, push: true });
  expect(h.openAgentTab).not.toHaveBeenCalled();
  expect(h.chats.at(-1)!.threadId).toBeNull();
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const chatParam = () => new URLSearchParams(window.location.search).get("chat");

it("a reload reopens the chat the URL names, not just the newest", async () => {
  window.history.replaceState(null, "", `/workspace?tab=growth-strategy&chat=${B}`);
  h.listChats.mockResolvedValue([row(A, "Latest"), row(B, "Older")]);
  render(<AutopilotTab />);
  await settle();
  expect(h.chats.at(-1)!.threadId).toBe(B);
  expect(chatParam()).toBe(B);
});

it("an unknown or from-Home id in the URL falls back to the newest, and the URL follows", async () => {
  window.history.replaceState(null, "", `/workspace?tab=growth-strategy&chat=${B}`);
  h.listChats.mockResolvedValue([row(A, "Latest"), homeRow(B, "From Home")]);
  render(<AutopilotTab />);
  await settle();
  expect(h.chats.at(-1)!.threadId).toBe(A);
  expect(chatParam()).toBe(A);
});

it("opening a chat writes it to the URL; New chat drops it", async () => {
  window.history.replaceState(null, "", "/workspace?tab=growth-strategy#ad-budget");
  h.listChats.mockResolvedValue([]);
  render(<AutopilotTab />);
  await settle();
  expect(chatParam()).toBeNull();
  act(() => (h.chats.at(-1)!.onThreadIdChange as (id: string) => void)(A));
  expect(chatParam()).toBe(A);
  expect(window.location.hash).toBe("#ad-budget");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  });
  expect(chatParam()).toBeNull();
});

it("leaves the URL alone while Growth is not the page on screen", async () => {
  window.history.replaceState(null, "", "/workspace?tab=channels");
  h.listChats.mockResolvedValue([row(A, "Latest")]);
  render(<AutopilotTab isActive={false} />);
  await settle();
  expect(window.location.search).toBe("?tab=channels");
});

it("a failed lookup keeps ?chat= so a later reload can still open it", async () => {
  window.history.replaceState(null, "", `/workspace?tab=growth-strategy&chat=${B}`);
  h.listChats.mockRejectedValueOnce(new Error("offline"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  render(<AutopilotTab />);
  await settle();
  expect(h.chats.at(-1)!.threadId).toBeNull();
  expect(chatParam()).toBe(B);
  warn.mockRestore();
});

const emailRow = (id: string, title: string) => ({ ...row(id, title), from_email: true });

it("never reopens an email conversation's chat; reopens the last app chat instead", async () => {
  h.listChats.mockResolvedValue([emailRow("t-email", "Raise Rent a car at $35 per day"), row("t-own", "Own chat")]);
  render(<AutopilotTab />);
  await settle();
  expect(h.chats.at(-1)!.threadId).toBe("t-own");
});

it("an email chat is tagged Email in Past chats and opens here when picked", async () => {
  h.listChats.mockResolvedValue([emailRow("t-email", "Raise Rent a car at $35 per day")]);
  render(<AutopilotTab />);
  await settle();
  expect(h.chats.at(-1)!.threadId).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
  });
  await settle();
  expect(screen.getByText("Email")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByText("Raise Rent a car at $35 per day"));
  });
  expect(h.chats.at(-1)!.threadId).toBe("t-email");
  expect(h.openAgentTab).not.toHaveBeenCalled();
});
