// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HomeDecision } from "@/lib/approvals/decisionApi";
import type { WorkspaceThreadMeta } from "../useAgentThreads";

const openStatic = vi.fn();
const openAgentTab = vi.fn(async () => "tab-new");
const setActiveTab = vi.fn();
let tenantId: string | undefined = "t1";
let viewMode: "chat" | "threaded" = "chat";
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantId, openAgentTab, setActiveTab, viewMode }),
}));
vi.mock("./shared", () => ({
  cx: (...p: unknown[]) => p.filter(Boolean).join(" "),
  useOpenStatic: () => openStatic,
}));
let threads: WorkspaceThreadMeta[] = [];
vi.mock("../useAgentThreads", () => ({ useWorkspaceThreads: () => ({ threads, loaded: true, refresh: vi.fn() }) }));
const holders: Record<string, string> = {};
const requestThreadPane = vi.fn();
vi.mock("../onScreenThreads", () => ({
  tabShowingThread: (id: string) => holders[id] ?? null,
  requestThreadPane: (...a: unknown[]) => requestThreadPane(...a),
}));
const fetchHome = vi.fn();
vi.mock("@/lib/approvals/decisionApi", () => ({ fetchHome: (...a: unknown[]) => fetchHome(...a) }));
vi.mock("../growth/ReviewRow", () => ({
  reviewDecisionText: (d: { body: { title?: string } }) => ({ title: d.body.title ?? "", why: "", agent: "Zavi" }),
}));

const { NeedsYouLine } = await import("./NeedsYouLine");
const { resetNeedsYouStore, ATTENTION_CHANGED_EVENT } = await import("@/lib/workspace/needsYou");
const { resetTabTitle } = await import("@/lib/workspace/tabTitle");

function decision(id: string, at: string, title: string): HomeDecision {
  return {
    id,
    agent_run_id: null,
    decision_class: "google.budget",
    handler: null,
    body: { title },
    status: "proposed",
    emitted_at: at,
    dispatched_at: null,
    dispatch_error: null,
    home: "growth",
    home_channel: null,
    channel_slug: null,
    agent_slug: "cgo",
    thread_id: null,
    run_stopped: false,
    needs_owner_admin: false,
  } as HomeDecision;
}

const page = (decisions: HomeDecision[]) => ({ decisions, next_cursor: null, totals: { needs_you: 0, growth: decisions.length, channel: 0 } });
const settle = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

beforeEach(() => {
  resetNeedsYouStore();
  fetchHome.mockReset();
  openStatic.mockReset();
  openAgentTab.mockClear();
  setActiveTab.mockReset();
  requestThreadPane.mockReset();
  threads = [];
  tenantId = "t1";
  viewMode = "chat";
  for (const k of Object.keys(holders)) delete holders[k];
});
afterEach(() => {
  cleanup();
  resetTabTitle();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

describe("NeedsYouLine", () => {
  it("renders nothing when nothing waits", async () => {
    fetchHome.mockResolvedValue(page([]));
    const { container } = render(<NeedsYouLine />);
    await settle();
    expect(container.innerHTML).toBe("");
  });

  it("shows the newest item with who, what, and how many more", async () => {
    fetchHome.mockResolvedValue(
      page([decision("d1", "2026-10-24T10:00:00Z", "Raise Google Sales Search $270 to $284 a day"), decision("d0", "2026-10-24T09:00:00Z", "Pause ad set B")]),
    );
    render(<NeedsYouLine />);
    await settle();
    const line = screen.getByTestId("needs-you-line");
    expect(line.textContent).toContain("needs you");
    expect(line.textContent).toContain("Raise Google Sales Search $270 to $284 a day");
    expect(line.textContent).toContain("and 1 more");
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  });

  it("Review opens Needs you on that card, which routes it to where it lives", async () => {
    fetchHome.mockResolvedValue(page([decision("d1", "2026-10-24T10:00:00Z", "Raise budget")]));
    render(<NeedsYouLine />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(openStatic).toHaveBeenCalledWith("needs-you", { decision: "d1" });
  });

  it("a chat question says Answer and opens that chat", async () => {
    fetchHome.mockResolvedValue(page([]));
    viewMode = "threaded";
    threads = [
      {
        id: "th1",
        agent_slug: "cgo",
        title: "x",
        last_message_at: null,
        created_at: null,
        last_message: null,
        run_status: null,
        pending: null,
        unread: true,
        unread_reply: { head: "Which campaign? There are two.", kind: "question", at: "2026-10-24T11:00:00Z" },
      },
    ];
    render(<NeedsYouLine />);
    await settle();
    expect(screen.getByTestId("needs-you-line").textContent).toContain("Which campaign?");
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await settle();
    expect(openAgentTab).toHaveBeenCalledWith("cgo", { threadId: "th1" });
    expect(requestThreadPane).toHaveBeenCalledWith("tab-new", "th1");
  });

  it("goes back to the tab already holding that chat", async () => {
    fetchHome.mockResolvedValue(page([]));
    holders.th1 = "tab-held";
    threads = [
      {
        id: "th1",
        agent_slug: "cgo",
        title: "x",
        last_message_at: null,
        created_at: null,
        last_message: null,
        run_status: null,
        pending: null,
        unread: true,
        unread_reply: { head: "Which?", kind: "question", at: "2026-10-24T11:00:00Z" },
      },
    ];
    render(<NeedsYouLine />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(setActiveTab).toHaveBeenCalledWith("tab-held");
    expect(openAgentTab).not.toHaveBeenCalled();
  });

  it("one × closes the whole line, however many items wait", async () => {
    fetchHome.mockResolvedValue(
      page([decision("d2", "2026-10-24T11:00:00Z", "First"), decision("d1", "2026-10-24T10:00:00Z", "Second"), decision("d0", "2026-10-24T09:00:00Z", "Third")]),
    );
    const { container } = render(<NeedsYouLine />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(container.innerHTML).toBe("");
  });

  it("after ×, only a new item brings the line back", async () => {
    fetchHome.mockResolvedValue(page([decision("d1", "2026-10-24T10:00:00Z", "Old")]));
    render(<NeedsYouLine />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => {
      window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
    });
    await settle();
    expect(screen.queryByTestId("needs-you-line")).toBeNull();
    fetchHome.mockResolvedValue(page([decision("d2", "2026-10-24T12:00:00Z", "New card"), decision("d1", "2026-10-24T10:00:00Z", "Old")]));
    await act(async () => {
      window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
    });
    await settle();
    const line = screen.getByTestId("needs-you-line");
    expect(line.textContent).toContain("New card");
    expect(line.textContent).not.toContain("and 1 more");
  });

  it("refetches on the attention doorbell and diffs by id: a new card shows even when the count stays flat", async () => {
    fetchHome.mockResolvedValueOnce(page([decision("d1", "2026-10-24T10:00:00Z", "Old card")]));
    render(<NeedsYouLine />);
    await settle();
    fetchHome.mockResolvedValueOnce(page([decision("d2", "2026-10-24T12:00:00Z", "New card")]));
    await act(async () => {
      window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
    });
    await settle();
    expect(screen.getByTestId("needs-you-line").textContent).toContain("New card");
  });

  it("counts a card that arrives while the browser tab is hidden in the title", async () => {
    document.title = "Zavi";
    fetchHome.mockResolvedValueOnce(page([]));
    render(<NeedsYouLine />);
    await settle();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    fetchHome.mockResolvedValueOnce(page([decision("d9", "2026-10-24T12:00:00Z", "Raise")]));
    await act(async () => {
      window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
    });
    await settle();
    expect(document.title).toMatch(/^\(1\) .+ needs you · Zavi$/);
  });

  it("does not count what was already there on first load", async () => {
    document.title = "Zavi";
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    fetchHome.mockResolvedValue(page([decision("d1", "2026-10-24T10:00:00Z", "Old")]));
    render(<NeedsYouLine />);
    await settle();
    expect(document.title).toBe("Zavi");
  });

  it("counts 'and N more' from the true totals, not the loaded page", async () => {
    fetchHome.mockResolvedValue({
      decisions: [decision("d1", "2026-10-24T10:00:00Z", "One"), decision("d0", "2026-10-24T09:00:00Z", "Two")],
      next_cursor: "c",
      totals: { needs_you: 10, growth: 30, channel: 10 },
    });
    render(<NeedsYouLine />);
    await settle();
    expect(screen.getByTestId("needs-you-line").textContent).toContain("and 49 more");
  });

  it("× also hides the count of cards not loaded yet", async () => {
    fetchHome.mockResolvedValue({ decisions: [decision("d1", "2026-10-24T10:00:00Z", "Only")], next_cursor: "c", totals: { needs_you: 0, growth: 5, channel: 0 } });
    const { container } = render(<NeedsYouLine />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(container.innerHTML).toBe("");
  });

  it("after ×, an older unloaded card sliding into the page does not bring the line back", async () => {
    fetchHome.mockResolvedValue({ decisions: [decision("d2", "2026-10-24T12:00:00Z", "Newest"), decision("d1", "2026-10-24T11:00:00Z", "Mid")], next_cursor: "c", totals: { needs_you: 0, growth: 3, channel: 0 } });
    render(<NeedsYouLine />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fetchHome.mockResolvedValue({ decisions: [decision("d1", "2026-10-24T11:00:00Z", "Mid"), decision("d0", "2026-10-24T09:00:00Z", "Old")], next_cursor: null, totals: { needs_you: 0, growth: 2, channel: 0 } });
    await act(async () => {
      window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
    });
    await settle();
    expect(screen.queryByTestId("needs-you-line")).toBeNull();
  });

  it("'and N more' opens the next item where it lives: a chat question opens its chat", async () => {
    fetchHome.mockResolvedValue(page([decision("d1", "2026-10-24T12:00:00Z", "Raise")]));
    threads = [
      {
        id: "th1",
        agent_slug: "cgo",
        title: "x",
        last_message_at: null,
        created_at: null,
        last_message: null,
        run_status: null,
        pending: null,
        unread: true,
        unread_reply: { head: "Which?", kind: "question", at: "2026-10-24T11:00:00Z" },
      },
    ];
    render(<NeedsYouLine />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "and 1 more" }));
    await settle();
    expect(openAgentTab).toHaveBeenCalledWith("cgo", { threadId: "th1" });
    expect(openStatic).not.toHaveBeenCalled();
  });

  it("leaves chat questions out of the title count (the run watcher counts them once)", async () => {
    document.title = "Zavi";
    fetchHome.mockResolvedValue(page([]));
    const view = render(<NeedsYouLine />);
    await settle();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    threads = [
      {
        id: "th1",
        agent_slug: "cgo",
        title: "x",
        last_message_at: null,
        created_at: null,
        last_message: null,
        run_status: null,
        pending: null,
        unread: true,
        unread_reply: { head: "Which?", kind: "question", at: "2026-10-24T11:00:00Z" },
      },
    ];
    view.rerender(<NeedsYouLine />);
    await settle();
    expect(screen.getByTestId("needs-you-line").textContent).toContain("Which?");
    expect(document.title).toBe("Zavi");
  });

  it("does nothing without an active company", async () => {
    tenantId = undefined;
    const { container } = render(<NeedsYouLine />);
    await settle();
    expect(fetchHome).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });

  it("on phones hides the message instead of squeezing it to one letter, and the title takes the room", async () => {
    const msg = "Local test of the bulk email flow before the real send";
    fetchHome.mockResolvedValue(page([decision("d1", "2026-10-24T10:00:00Z", msg), decision("d0", "2026-10-24T09:00:00Z", "Pause ad set B")]));
    render(<NeedsYouLine />);
    await settle();
    const line = screen.getByTestId("needs-you-line");
    const message = Array.from(line.children).find((el) => el.textContent === msg) as HTMLElement;
    expect(message).toBeTruthy();
    const mc = message.className.split(/\s+/);
    expect(mc).toContain("hidden");
    expect(mc).toContain("sm:block");
    expect(mc).not.toContain("block");
    expect(mc).not.toContain("inline");
    const title = Array.from(line.children).find((el) => el.textContent?.endsWith("needs you")) as HTMLElement;
    const tc = title.className.split(/\s+/);
    expect(tc).not.toContain("max-w-[40%]");
    expect(tc).toContain("flex-1");
    expect(tc).toContain("sm:max-w-[40%]");
    expect(tc).toContain("sm:flex-initial");
  });

  it("on phones gives Close and 'and N more' a 44px tap target without making the line taller", async () => {
    fetchHome.mockResolvedValue(page([decision("d1", "2026-10-24T10:00:00Z", "Raise budget"), decision("d0", "2026-10-24T09:00:00Z", "Pause ad set B")]));
    render(<NeedsYouLine />);
    await settle();
    const close = screen.getByRole("button", { name: "Close" }).className.split(/\s+/);
    const more = screen.getByRole("button", { name: "and 1 more" }).className.split(/\s+/);
    for (const c of [close, more]) {
      expect(c).toContain("compact:min-h-11");
      expect(c).toContain("compact:-my-3");
      expect(c.some((t) => /^min-h-|^-my-/.test(t))).toBe(false);
    }
    expect(close).toContain("compact:min-w-11");
    expect(close.some((t) => /^min-w-/.test(t))).toBe(false);
  });

  it("on phones gives Review the same 44px tap target as Close", async () => {
    fetchHome.mockResolvedValue(page([decision("d1", "2026-10-24T10:00:00Z", "Raise budget")]));
    render(<NeedsYouLine />);
    await settle();
    const close = screen.getByRole("button", { name: "Close" }).className.split(/\s+/);
    const review = screen.getByRole("button", { name: "Review" }).className.split(/\s+/);
    for (const c of ["compact:min-h-11", "compact:min-w-11", "compact:-my-3"]) {
      expect(review).toContain(c);
    }
    expect(close).toContain("compact:min-h-11");
    expect(review.some((t) => /^min-h-|^min-w-|^-my-/.test(t))).toBe(false);
  });
});
