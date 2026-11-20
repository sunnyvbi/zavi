// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  chatArgs: [] as unknown[][],
  rows: [] as unknown[],
  composerProps: null as null | Record<string, unknown>,
  systemRows: vi.fn(),
  apiFetch: vi.fn(() => Promise.resolve({ ok: true })),
  teamNote: null as null | Record<string, unknown>,
  stripProps: [] as Array<Record<string, unknown>>,
  status: [] as Array<{ runId: string; onComplete: (s: "success" | "error" | "failed" | "cancelled") => void }>,
}));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));

vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: (...args: unknown[]) => {
    h.chatArgs.push(args);
    return {
      rows: h.rows,
      activityRows: [],
      loading: false,
      errorMsg: null,
      activeRunId: null,
      activeTrigger: null,
      activeRunStartedAt: null,
      activeRunTurnStartedAt: null,
      offeredTeamNote: h.teamNote,
      refetch: () => {},
      markRunStopped: () => {},
      unmarkRunStopped: () => {},
      appendOptimisticUser: () => undefined,
      appendOptimisticSystem: h.systemRows,
    };
  },
}));
vi.mock("../ChatThread", () => ({ ChatThread: () => <div data-testid="chat-thread" /> }));
vi.mock("../InlineStatusRow", () => ({
  InlineStatusRow: (p: { runId: string; onComplete: (s: "success" | "error" | "failed" | "cancelled") => void }) => {
    h.status.push({ runId: p.runId, onComplete: p.onComplete });
    return null;
  },
}));
vi.mock("../LowCreditsWarning", () => ({ LowCreditsWarning: () => null }));
vi.mock("../useAgentThreads", () => ({ notifyThreadsChanged: () => {} }));
vi.mock("../CreditWallNotice", () => ({
  CreditWallNotice: ({ wall }: { wall: { message: string } }) => (
    <div role="alert">{wall.message}</div>
  ),
}));
vi.mock("../chat/TeamNoteStrip", () => ({
  TeamNoteStrip: (props: Record<string, unknown>) => {
    h.stripProps.push(props);
    return <div data-testid="team-note-strip-mock" />;
  },
}));
vi.mock("../Composer", () => ({
  Composer: (props: Record<string, unknown>) => {
    h.composerProps = props;
    return <textarea aria-label="Message" />;
  },
}));

import { SideChat, type SideChatProps } from "./SideChat";

const base: SideChatProps = {
  agentSlug: "cgo",
  tabId: "growth",
  thread: "latest",
  avatar: <span data-testid="avatar" />,
  title: "Zavi",
  contextLine: "Your Chief Growth Officer",
  ariaLabel: "Growth chat",
  open: true,
  onClose: () => {},
  widthKey: "test.width",
  resizeLabel: "Resize",
};

beforeEach(() => {
  h.chatArgs = [];
  h.rows = [];
  h.composerProps = null;
  h.teamNote = null;
  h.stripProps = [];
  h.status = [];
  h.systemRows.mockReset();
  h.apiFetch.mockClear();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("the frame every page gets", () => {
  it("draws the header, the bar under it, and folds from the header", () => {
    const onClose = vi.fn();
    render(
      <SideChat {...base} onClose={onClose} contextBar={<p>Pinned to: Google Ads</p>} />,
    );
    expect(screen.getByText("Zavi")).toBeTruthy();
    expect(screen.getByText("Your Chief Growth Officer")).toBeTruthy();
    expect(screen.getByTestId("avatar")).toBeTruthy();
    expect(screen.getByText("Pinned to: Google Ads")).toBeTruthy();
    expect(screen.getByTestId("side-chat-resizer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide the chat" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("hideAvatarWhenEmpty leaves the header face out of a blank chat and shows it once there is a message", () => {
    const view = render(<SideChat {...base} hideAvatarWhenEmpty />);
    expect(screen.queryByTestId("avatar")).toBeNull();
    h.rows = [{ kind: "chat_user", id: "u1" }];
    view.rerender(<SideChat {...base} hideAvatarWhenEmpty />);
    expect(screen.getByTestId("avatar")).toBeTruthy();
  });

  it("on a phone it fills the slide-in: an X, no divider", () => {
    render(<SideChat {...base} fullBleed />);
    expect(screen.getByRole("button", { name: "Close the chat" })).toBeTruthy();
    expect(screen.queryByTestId("side-chat-resizer")).toBeNull();
  });

  it("folded, it stays mounted and out of the layout", () => {
    const { container } = render(<SideChat {...base} open={false} />);
    const aside = container.querySelector("aside")!;
    expect(aside.hasAttribute("hidden")).toBe(true);
    expect(screen.queryByTestId("side-chat-resizer")).toBeNull();
  });

  it("a credit wall becomes a card in the conversation, and a send clears it", () => {
    render(<SideChat {...base} />);
    const onCreditWall = h.composerProps!.onCreditWall as (w: unknown) => void;
    act(() => onCreditWall({ message: "Out of credits", kind: "credits" }));
    expect(screen.getByRole("alert").textContent).toBe("Out of credits");
    act(() => (h.composerProps!.onSent as (id: string) => void)("run-1"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dragging a file over the conversation offers to attach it", () => {
    const { container } = render(<SideChat {...base} />);
    const zone = container.querySelector("aside > div.relative") as HTMLElement;
    fireEvent.dragEnter(zone, { dataTransfer: { items: [{ kind: "file" }], files: [] } });
    expect(screen.getByText("Drop files to attach")).toBeTruthy();
    const file = new File(["x"], "a.txt");
    fireEvent.drop(zone, { dataTransfer: { items: [{ kind: "file" }], files: [file] } });
    expect(screen.queryByText("Drop files to attach")).toBeNull();
    expect((h.composerProps!.droppedFiles as { files: File[] }).files).toEqual([file]);
  });
});

describe("what each page decides passes straight through", () => {
  it("'latest' resumes the newest conversation and SENDS into it, not a new one", () => {
    render(<SideChat {...base} />);
    expect(h.chatArgs[0]!.slice(0, 2)).toEqual(["cgo", undefined]);
    expect(h.composerProps!.tabId).toBe("growth");
    expect(h.composerProps!.threadId).toBeUndefined();
    const onThreadLoaded = h.chatArgs[0]![2] as (t: { id: string }) => void;
    act(() => onThreadLoaded({ id: "thread-a" }));
    expect(h.composerProps!.threadId).toBe("thread-a");
    expect(h.chatArgs.at(-1)!.slice(0, 2)).toEqual(["cgo", "thread-a"]);
  });

  it("a send that opens a conversation binds it", () => {
    render(<SideChat {...base} />);
    act(() => (h.composerProps!.onThreadBound as (id: string) => void)("thread-new"));
    expect(h.composerProps!.threadId).toBe("thread-new");
  });

  it("'fresh' starts a new conversation bound to the panel", () => {
    render(<SideChat {...base} agentSlug="operator" tabId="panel" thread="fresh" />);
    expect(h.chatArgs[0]!.slice(0, 2)).toEqual(["operator", null]);
    expect(typeof h.composerProps!.onThreadBound).toBe("function");
  });

  it("a conversation the host already bound wins over 'fresh' on mount", () => {
    render(<SideChat {...base} thread="fresh" boundThreadId="thread-kept" />);
    expect(h.chatArgs[0]!.slice(0, 2)).toEqual(["cgo", "thread-kept"]);
    expect(h.composerProps!.threadId).toBe("thread-kept");
  });

  it("scope, chips and seed reach the composer as given", () => {
    const seed = { text: "hi", nonce: 1 };
    render(
      <SideChat
        {...base}
        stickyChannels={["google_ads"]}
        starterChips={["How is Google Ads doing?"]}
        seed={seed}
      />,
    );
    expect(h.composerProps!.stickyChannels).toEqual(["google_ads"]);
    expect(h.composerProps!.starterChips).toEqual(["How is Google Ads doing?"]);
    expect(h.composerProps!.seed).toBe(seed);
  });

  it("the send intercept gets the conversation's system-row writer", async () => {
    const onBeforeSend = vi.fn(async (_m: string, chat: { appendSystem: (t: string, o?: { persists?: boolean }) => void }) => {
      chat.appendSystem("noted", { persists: false });
      return { handled: true };
    });
    render(<SideChat {...base} onBeforeSend={onBeforeSend} />);
    const intercept = h.composerProps!.onBeforeSend as (m: string) => Promise<unknown>;
    await act(async () => {
      await intercept("redo this");
    });
    expect(onBeforeSend.mock.calls[0]![0]).toBe("redo this");
    expect(h.systemRows).toHaveBeenCalledWith("noted", { persists: false });
  });

  it("starter chips only on an empty conversation", () => {
    h.rows = [{ kind: "chat_assistant", id: "m1" }];
    render(<SideChat {...base} starterChips={["How is Google Ads doing?"]} />);
    expect(h.composerProps!.starterChips).toEqual([]);
  });

  it("Escape stops the run in flight, through the Stop button's endpoint", () => {
    render(<SideChat {...base} />);
    act(() => (h.composerProps!.onSent as (id: string) => void)("run-9"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(h.apiFetch).toHaveBeenCalledWith("/api/agents/runs/run-9/cancel", { method: "POST" });
  });

  it("a chat in a background tab never cancels on Escape", () => {
    render(
      <div aria-hidden="true">
        <SideChat {...base} />
      </div>,
    );
    act(() => (h.composerProps!.onSent as (id: string) => void)("run-9"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("a folded chat never cancels on Escape", () => {
    render(<SideChat {...base} open={false} />);
    act(() => (h.composerProps!.onSent as (id: string) => void)("run-9"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("an Escape something else handled (the slash menu) does not cancel", () => {
    render(<SideChat {...base} />);
    act(() => (h.composerProps!.onSent as (id: string) => void)("run-9"));
    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    ev.preventDefault();
    document.dispatchEvent(ev);
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("Escape with nothing running does nothing", () => {
    render(<SideChat {...base} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("an open dialog owns Escape: it closes, the run keeps going", () => {
    render(
      <>
        <div role="dialog" aria-modal="true" />
        <SideChat {...base} />
      </>,
    );
    act(() => (h.composerProps!.onSent as (id: string) => void)("run-9"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("a dialog left open in a background tab does not block Escape-to-stop", () => {
    render(
      <>
        <div aria-hidden="true">
          <div role="dialog" aria-modal="true" />
        </div>
        <SideChat {...base} />
      </>,
    );
    act(() => (h.composerProps!.onSent as (id: string) => void)("run-9"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(h.apiFetch).toHaveBeenCalledWith("/api/agents/runs/run-9/cancel", { method: "POST" });
  });
});

describe("full screen (desktop)", () => {
  const expand = () => fireEvent.click(screen.getByRole("button", { name: "Full screen" }));

  it("covers the page row, hides the drag handle, and comes back from the header", () => {
    window.localStorage.setItem("test.width", "500");
    const { container } = render(<SideChat {...base} />);
    expand();
    const aside = container.querySelector("aside")!;
    expect(aside.className).toContain("absolute");
    expect(aside.style.width).toBe("");
    expect(screen.queryByTestId("side-chat-resizer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(aside.className).not.toContain("absolute");
    expect(screen.getByTestId("side-chat-resizer")).toBeTruthy();
    expect(window.localStorage.getItem("test.width")).toBe("500");
  });

  it("is not offered on a phone (the slide-in is already full screen)", () => {
    render(<SideChat {...base} fullBleed />);
    expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
  });

  it("folding the chat ends full screen", () => {
    const { container, rerender } = render(<SideChat {...base} />);
    expand();
    rerender(<SideChat {...base} open={false} />);
    rerender(<SideChat {...base} open />);
    expect(container.querySelector("aside")!.className).not.toContain("absolute");
    expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
  });

  it("Escape exits when nothing is running", () => {
    render(<SideChat {...base} />);
    expand();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
  });

  it("Escape stops a running reply first and stays full screen", () => {
    render(<SideChat {...base} />);
    expand();
    act(() => (h.composerProps!.onSent as (id: string) => void)("run-9"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(h.apiFetch).toHaveBeenCalledWith("/api/agents/runs/run-9/cancel", { method: "POST" });
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBeTruthy();
  });

  it("an open popover owns Escape: full screen stays", () => {
    render(<SideChat {...base} escapeOwnedElsewhere />);
    expand();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBeTruthy();
  });
});

describe("Report to Zavi team strip", () => {
  it("renders above the composer by default (operator / cgo hosts), fed by the chat", () => {
    const note = { messageId: "m1", offerId: "o1", note: "It failed.", offerStop: false, state: "shown" };
    h.teamNote = note;
    render(<SideChat {...base} />);
    expect(screen.getByTestId("team-note-strip-mock")).toBeTruthy();
    const last = h.stripProps[h.stripProps.length - 1];
    expect(last.teamNote).toBe(note);
    expect(last.replying).toBe(false);
    const strip = screen.getByTestId("team-note-strip-mock");
    const composer = screen.getByLabelText("Message");
    expect(strip.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a host can opt out", () => {
    render(<SideChat {...base} showTeamNoteStrip={false} />);
    expect(screen.queryByTestId("team-note-strip-mock")).toBeNull();
  });
});

describe("channel page Past chats hooks (spec 2026-10-14)", () => {
  it("an uncontrolled chat (Growth) draws no Past chats / New chat and keeps its own binding", () => {
    render(<SideChat {...base} thread="fresh" />);
    expect(screen.queryByRole("button", { name: "Past chats" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(h.composerProps!.pageChannel).toBeUndefined();
    act(() => {
      (h.composerProps!.onThreadBound as (id: string) => void)("T9");
    });
    expect(h.chatArgs.at(-1)![1]).toBe("T9");
  });

  it("a controlled chat reads the host's thread and REPORTS a binding instead of storing it", () => {
    const onThreadIdChange = vi.fn();
    render(
      <SideChat
        {...base}
        thread="fresh"
        threadId="T1"
        onThreadIdChange={onThreadIdChange}
        pageChannel="meta_ads"
        headerActions={<button type="button">Past chats</button>}
      />,
    );
    expect(h.chatArgs.at(-1)![1]).toBe("T1");
    expect(h.composerProps!.threadId).toBe("T1");
    expect(h.composerProps!.pageChannel).toBe("meta_ads");
    expect(screen.getByRole("button", { name: "Past chats" })).toBeTruthy();
    act(() => {
      (h.composerProps!.onThreadBound as (id: string) => void)("T2");
    });
    expect(onThreadIdChange).toHaveBeenCalledWith("T2");
    expect(h.chatArgs.at(-1)![1]).toBe("T1");
  });

  it("while the host resolves which chat to open: loading, and no starter chips", () => {
    render(
      <SideChat
        {...base}
        thread="fresh"
        threadId={null}
        onThreadIdChange={() => {}}
        resolvingThread
        starterChips={["How is Meta doing?"]}
      />,
    );
    expect(h.composerProps!.starterChips).toEqual([]);
  });
});

describe("what the host hears when a run ends", () => {
  const failureReply = (runId: string) => ({
    id: "m:failure",
    kind: "chat_assistant",
    agent_run_id: runId,
    body: { text: "Zavi hit an error and could not finish this. Try again." },
    citations: [],
    created_at: "2026-10-29T10:00:00Z",
    trigger: "chat",
  });

  it("does not call a failed run a success when its failure reply lands, and still passes on the real status", () => {
    const onRunFinished = vi.fn();
    const view = render(<SideChat {...base} onRunFinished={onRunFinished} />);
    act(() => (h.composerProps!.onSent as (id: string) => void)("run-f"));
    h.rows = [failureReply("run-f")];
    view.rerender(<SideChat {...base} onRunFinished={onRunFinished} />);
    expect(onRunFinished).toHaveBeenCalledTimes(1);
    expect(onRunFinished.mock.calls.some((c) => c[1] === "success")).toBe(false);
    expect(onRunFinished).toHaveBeenLastCalledWith("run-f", "unknown");
    view.rerender(<SideChat {...base} onRunFinished={onRunFinished} />);
    expect(onRunFinished).toHaveBeenCalledTimes(1);
    const row = h.status.filter((s) => s.runId === "run-f").at(-1)!;
    act(() => row.onComplete("failed"));
    expect(onRunFinished).toHaveBeenCalledTimes(2);
    expect(onRunFinished).toHaveBeenLastCalledWith("run-f", "failed");
    act(() => row.onComplete("failed"));
    expect(onRunFinished).toHaveBeenCalledTimes(2);
    expect(onRunFinished.mock.calls.some((c) => c[1] === "success")).toBe(false);
  });

  it("says nothing more when the reply lands after the real status was heard", () => {
    const onRunFinished = vi.fn();
    const view = render(<SideChat {...base} onRunFinished={onRunFinished} />);
    act(() => (h.composerProps!.onSent as (id: string) => void)("run-e"));
    const row = h.status.filter((s) => s.runId === "run-e").at(-1)!;
    act(() => row.onComplete("error"));
    h.rows = [failureReply("run-e")];
    view.rerender(<SideChat {...base} onRunFinished={onRunFinished} />);
    expect(onRunFinished.mock.calls).toEqual([["run-e", "error"]]);
  });
});
