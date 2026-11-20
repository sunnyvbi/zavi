// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryPageClient, sourceOf, type MemoryNoteRow, type MemoryPageApi } from "./MemoryPageClient";
import { UNDO_WINDOW_MS } from "./useForgetWithUndo";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const NOW = Date.parse("2026-09-29T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function note(p: Partial<MemoryNoteRow> & { id: string; title: string }): MemoryNoteRow {
  return {
    body_markdown: p.title,
    source: "auto_distill_chat",
    source_ref: "run-1",
    tags: ["agent:operator", "thread:th-1"],
    note_type: "tenant_reference",
    slug: null,
    created_at: minutesAgo(3),
    updated_at: minutesAgo(3),
    ...p,
  };
}

function fakeApi(notes: MemoryNoteRow[]): Mocked<MemoryPageApi> {
  return {
    listNotes: vi.fn(async () => notes),
    getWrites: vi.fn(async () => ({
      status: "done" as const,
      items: [
        {
          note_id: "goal-2",
          kind: "updated" as const,
          title: "Goal: 40 paying customers",
          body_excerpt: "",
          previous: { note_id: "goal-1", title: "Goal: 25 paying customers" },
        },
      ],
    })),
    forget: vi.fn(async () => ({ undo_token: "tok-9" })),
    undoForget: vi.fn(async () => {}),
    undoUpdate: vi.fn(async () => {}),
    keepConflict: vi.fn(async () => {}),
    listConflicts: vi.fn(async () => [
      {
        pair_id: "pair-1",
        values: [
          { note_id: "px-2", title: "Meta pixel ID: 222", body_excerpt: "" },
          { note_id: "px-1", title: "Meta pixel ID: 111", body_excerpt: "" },
        ],
      },
    ]),
  } as unknown as Mocked<MemoryPageApi>;
}

const NOTES = [
  note({ id: "goal-2", title: "Goal: 40 paying customers" }),
  note({
    id: "rule-1",
    title: "r/startups removes self-promotion posts on weekdays",
    source: "auto_distill_agent_run",
    source_ref: "run-2",
    tags: ["agent:reddit_organic", "trigger:cron"],
  }),
  note({ id: "old-1", title: "Main buyers: first-time founders", source: "human", created_at: minutesAgo(60 * 24 * 30) }),
  note({ id: "anchor", title: "Company overview", note_type: "anchor", slug: "company" }),
];

const flush = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"] });
  window.localStorage.setItem("zavi.memory.lastVisitAt", String(NOW - 60 * 60_000));
  window.history.replaceState(null, "", "/memory");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("MemoryPageClient", () => {
  it("pins open conflict pairs at the top and Keep this answers the pair", async () => {
    const api = fakeApi(NOTES);
    render(<MemoryPageClient api={api} />);
    await flush();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toMatch(/^Two values on record/);
    const pair = screen.getByTestId("conflict-pair");
    fireEvent.click(within(pair).getAllByRole("button", { name: "Keep this" })[1]!);
    await flush();
    expect(api.keepConflict).toHaveBeenCalledWith("pair-1", "px-1");
    expect(within(pair).getByText(/Kept: Meta pixel ID: 111/)).toBeTruthy();
  });

  it("puts facts saved since the last visit under New, the rest under Earlier, anchors nowhere", async () => {
    const api = fakeApi(NOTES);
    render(<MemoryPageClient api={api} />);
    await flush();
    const rows = screen.getAllByTestId("memory-row").map((r) => r.id);
    expect(rows).toEqual(["fact-goal-2", "fact-rule-1", "fact-old-1"]);
    expect(screen.getByText(/New since your last visit/).textContent).toContain("(2)");
    expect(screen.getByText(/^Earlier/).textContent).toContain("(1)");
    expect(screen.queryByText("Company overview")).toBeNull();
  });

  it("marks a fact that replaced an older one as Updated with was", async () => {
    const api = fakeApi(NOTES);
    render(<MemoryPageClient api={api} />);
    await flush();
    await flush();
    const row = document.getElementById("fact-goal-2")!;
    expect(within(row).getByText("Updated")).toBeTruthy();
    expect(within(row).getByText("Goal: 25 paying customers")).toBeTruthy();
    expect(api.getWrites).toHaveBeenCalledTimes(2);
  });

  it("links each new fact back to the chat or the channel run", async () => {
    const api = fakeApi(NOTES);
    render(<MemoryPageClient api={api} />);
    await flush();
    const chat = within(document.getElementById("fact-goal-2")!).getByRole("link", { name: /Open the chat/ });
    expect(chat.getAttribute("href")).toBe("/workspace/th-1");
    const run = within(document.getElementById("fact-rule-1")!).getByRole("link", { name: /Open the channel/ });
    expect(run.getAttribute("href")).toBe("/workspace?tab=channels&channel=reddit_organic");
    const edit = within(document.getElementById("fact-old-1")!).getByRole("link", { name: "Edit" });
    expect(edit.getAttribute("href")).toBe("/memory/old-1");
  });

  it("Forget removes the row at once, Undo restores it, the window closing removes it", async () => {
    const api = fakeApi(NOTES);
    render(<MemoryPageClient api={api} />);
    await flush();
    const row = () => document.getElementById("fact-old-1");
    fireEvent.click(within(row()!).getByRole("button", { name: "Forget" }));
    await flush();
    expect(api.forget).toHaveBeenCalledWith("old-1");
    expect(within(row()!).getByText("Forgotten. Zavi will not use this again.")).toBeTruthy();
    fireEvent.click(within(row()!).getByRole("button", { name: "Undo" }));
    await flush();
    expect(api.undoForget).toHaveBeenCalledWith("tok-9");
    expect(within(row()!).getByText("Main buyers: first-time founders")).toBeTruthy();

    fireEvent.click(within(row()!).getByRole("button", { name: "Forget" }));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    });
    expect(row()).toBeNull();
    expect(screen.getByText("Nothing saved before your last visit.")).toBeTruthy();
  });

  it("a double-run mount effect does not read its own last-visit stamp", async () => {
    const api = fakeApi(NOTES);
    render(
      <StrictMode>
        <MemoryPageClient api={api} />
      </StrictMode>,
    );
    await flush();
    expect(screen.getByText(/New since your last visit/).textContent).toContain("(2)");
  });

  it("keeps the layout with an empty slot when nothing is new", async () => {
    window.localStorage.setItem("zavi.memory.lastVisitAt", String(NOW));
    const api = fakeApi(NOTES);
    api.listConflicts.mockResolvedValueOnce([]);
    render(<MemoryPageClient api={api} />);
    await flush();
    expect(screen.getByText(/Nothing new since your last visit/)).toBeTruthy();
    expect(screen.queryByTestId("conflict-pair")).toBeNull();
    expect(api.getWrites).not.toHaveBeenCalled();
  });

  it("a linked fact (?h=) lands under New and is highlighted", async () => {
    window.localStorage.setItem("zavi.memory.lastVisitAt", String(NOW));
    window.history.replaceState(null, "", "/memory?h=old-1");
    const api = fakeApi(NOTES);
    render(<MemoryPageClient api={api} />);
    await flush();
    expect(screen.getAllByTestId("memory-row")[0]!.id).toBe("fact-old-1");
    expect(document.getElementById("fact-old-1")!.className).toContain("ring-2");
  });

  it("a failed conflicts read is an error, not an empty conflicts list", async () => {
    const api = fakeApi(NOTES);
    api.listConflicts.mockRejectedValueOnce(new Error("HTTP 500"));
    render(<MemoryPageClient api={api} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Could not load your memory.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(screen.getByTestId("conflict-pair")).toBeTruthy();
  });

  it("says so when the list cannot load, with Try again", async () => {
    const api = fakeApi(NOTES);
    api.listNotes.mockRejectedValueOnce(new Error("HTTP 500"));
    render(<MemoryPageClient api={api} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Could not load your memory.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(screen.getAllByTestId("memory-row")).toHaveLength(3);
  });
});

describe("sourceOf", () => {
  it("never shows internal source names", () => {
    const s = sourceOf(note({ id: "x", title: "t", source: "dream_cycle_merge", tags: [] }), NOW);
    expect(s.label).toBe("Saved by Zavi, 3 min ago");
  });
});
