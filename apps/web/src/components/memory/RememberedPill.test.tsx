// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RememberedPill, pillLabel } from "./RememberedPill";
import { UNDO_WINDOW_MS } from "./useForgetWithUndo";
import { POLL_DELAYS_MS, __resetMemoryWritesCache, dropCachedNote } from "@/lib/memory/useMemoryWrites";
import { normalizeWrites, type MemoryApi, type MemoryWrites } from "@/lib/memory/writesApi";
import { memoryPillRowIndexes } from "@/lib/memory/pillRows";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function fakeApi(writes: MemoryWrites | MemoryWrites[] | null): Mocked<MemoryApi> {
  const queue = Array.isArray(writes) ? [...writes] : null;
  return {
    getWrites: vi.fn(async () => (queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : writes as MemoryWrites | null)),
    forget: vi.fn(async () => ({ undo_token: "tok-1" })),
    undoForget: vi.fn(async () => {}),
    undoUpdate: vi.fn(async () => {}),
    keepConflict: vi.fn(async () => {}),
    listConflicts: vi.fn(async () => [
      {
        pair_id: "pair-9",
        values: [
          { note_id: "n-new", title: "Meta pixel ID: 222", body_excerpt: "" },
          { note_id: "n-old", title: "Meta pixel ID: 111", body_excerpt: "" },
        ],
      },
    ]),
  } as unknown as Mocked<MemoryApi>;
}

const TWO_FACTS: MemoryWrites = {
  status: "done",
  items: [
    { note_id: "a", kind: "added", title: "Goal: 25 paying customers by December 23", body_excerpt: "" },
    { note_id: "b", kind: "added", title: "Reddit outreach: use personal accounts only", body_excerpt: "" },
  ],
};

const flush = () => act(async () => {});

beforeEach(() => __resetMemoryWritesCache());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RememberedPill", () => {
  it("renders nothing when the reply saved nothing", async () => {
    const api = fakeApi({ status: "done", items: [] });
    render(<RememberedPill runId="r1" api={api} />);
    await flush();
    expect(api.getWrites).toHaveBeenCalledWith({ runId: "r1" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing and never fetches when not enabled", async () => {
    const api = fakeApi(TWO_FACTS);
    render(<RememberedPill runId="r1" api={api} enabled={false} />);
    await flush();
    expect(api.getWrites).not.toHaveBeenCalled();
  });

  it("shows Saving to memory while pending, then the count once saved", async () => {
    vi.useFakeTimers();
    const api = fakeApi([{ status: "pending", items: [] }, TWO_FACTS]);
    render(<RememberedPill runId="r1" api={api} />);
    await flush();
    expect(screen.getByRole("status").textContent).toContain("Saving to memory…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]);
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /Remembered 2 facts/ })).toBeTruthy();
  });

  it("stops polling after the cap and shows nothing", async () => {
    vi.useFakeTimers();
    const api = fakeApi({ status: "pending", items: [] });
    render(<RememberedPill runId="r1" api={api} />);
    await flush();
    for (const d of POLL_DELAYS_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(d);
      });
    }
    expect(api.getWrites).toHaveBeenCalledTimes(POLL_DELAYS_MS.length + 1);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(api.getWrites).toHaveBeenCalledTimes(POLL_DELAYS_MS.length + 1);
  });

  it("shares one request per run and caches a finished answer", async () => {
    const api = fakeApi(TWO_FACTS);
    render(
      <>
        <RememberedPill runId="r1" api={api} />
        <RememberedPill runId="r1" api={api} />
      </>,
    );
    await flush();
    expect(api.getWrites).toHaveBeenCalledTimes(1);
    cleanup();
    render(<RememberedPill runId="r1" api={api} />);
    await flush();
    expect(api.getWrites).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Remembered 2 facts/ })).toBeTruthy();
  });

  it("opens inline with a Forget per fact and an Open memory link", async () => {
    const api = fakeApi(TWO_FACTS);
    render(<RememberedPill runId="r1" api={api} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Remembered 2 facts/ }));
    expect(screen.getAllByRole("button", { name: "Forget" })).toHaveLength(2);
    const link = screen.getByRole("link", { name: /Open memory/ });
    expect(link.getAttribute("href")).toBe("/workspace?tab=memory&h=a,b");
    for (const el of [...screen.getAllByRole("button", { name: "Forget" }), link]) {
      const cls = el.className.split(/\s+/);
      expect(cls).toEqual(expect.arrayContaining(["h-8", "relative", "after:absolute", "after:-inset-y-1.5", "after:content-['']"]));
    }
  });

  it("Forget hides the fact at once, Undo within the window restores it", async () => {
    const api = fakeApi(TWO_FACTS);
    render(<RememberedPill runId="r1" api={api} defaultOpen />);
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0]!);
    await flush();
    expect(api.forget).toHaveBeenCalledWith("a");
    expect(screen.getByText("Forgotten")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Remembered 1 fact/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await flush();
    expect(api.undoForget).toHaveBeenCalledWith("tok-1");
    expect(screen.queryByText("Forgotten")).toBeNull();
    expect(screen.getByRole("button", { name: /Remembered 2 facts/ })).toBeTruthy();
  });

  it("after the undo window the forgotten fact is gone", async () => {
    vi.useFakeTimers();
    const api = fakeApi(TWO_FACTS);
    render(<RememberedPill runId="r1" api={api} defaultOpen />);
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0]!);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    });
    expect(screen.queryByText("Forgotten")).toBeNull();
    expect(screen.queryByText(/Goal: 25/)).toBeNull();
    expect(screen.getByText(/Reddit outreach/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Remembered 1 fact/ })).toBeTruthy();
    expect(api.undoForget).not.toHaveBeenCalled();
  });

  it("a failed forget puts the fact back with an error line", async () => {
    const api = fakeApi(TWO_FACTS);
    api.forget.mockRejectedValueOnce(new Error("HTTP 500"));
    render(<RememberedPill runId="r1" api={api} defaultOpen />);
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0]!);
    await flush();
    expect(screen.getByText("Could not forget this. Try again.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Forget" })).toHaveLength(2);
  });

  it("a failed Undo keeps the fact forgotten with Undo to retry, using the same token", async () => {
    const api = fakeApi(TWO_FACTS);
    api.undoForget.mockRejectedValueOnce(new Error("HTTP 500"));
    render(<RememberedPill runId="r1" api={api} defaultOpen />);
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0]!);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await flush();
    expect(screen.getByText("Could not undo. Try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await flush();
    expect(api.undoForget).toHaveBeenCalledTimes(2);
    expect(api.undoForget).toHaveBeenLastCalledWith("tok-1");
    expect(screen.getAllByRole("button", { name: "Forget" })).toHaveLength(2);
  });

  it("while Forget is in flight nothing can be pressed on that row", async () => {
    const api = fakeApi(TWO_FACTS);
    let fail!: (e: Error) => void;
    api.forget.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    render(<RememberedPill runId="r1" api={api} defaultOpen />);
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0]!);
    await flush();
    expect(screen.getByText("Forgetting…")).toBeTruthy();
    const undoBtn = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
    fireEvent.click(undoBtn);
    await act(async () => fail(new Error("HTTP 500")));
    await flush();
    expect(screen.getByText("Could not forget this. Try again.")).toBeTruthy();
    expect(api.undoForget).not.toHaveBeenCalled();
  });

  it("a slow Forget that fails after the window keeps the fact and the cache", async () => {
    vi.useFakeTimers();
    const api = fakeApi(TWO_FACTS);
    let fail!: (e: Error) => void;
    api.forget.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    render(<RememberedPill runId="r1" api={api} defaultOpen />);
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0]!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    });
    expect(screen.getByText("Forgetting…")).toBeTruthy();
    await act(async () => fail(new Error("HTTP 500")));
    await flush();
    expect(screen.getByText("Could not forget this. Try again.")).toBeTruthy();
    expect(screen.getByText(/Goal: 25/)).toBeTruthy();
    cleanup();
    render(<RememberedPill runId="r1" api={api} />);
    await flush();
    expect(screen.getByRole("button", { name: /Remembered 2 facts/ })).toBeTruthy();
  });

  it("while Undo is in flight the row offers no Forget, so a second Forget cannot race it", async () => {
    const api = fakeApi(TWO_FACTS);
    let finish!: () => void;
    api.undoForget.mockReturnValueOnce(new Promise<void>((r) => (finish = r)));
    render(<RememberedPill runId="r1" api={api} defaultOpen />);
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0]!);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await flush();
    expect(screen.getByText("Restoring…")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Forget" })).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    await flush();
    expect(screen.getAllByRole("button", { name: "Forget" })).toHaveLength(2);
    expect(api.forget).toHaveBeenCalledTimes(1);
  });

  it("the expiry timer is paused while Undo is in flight, so a late success keeps the fact and the cache", async () => {
    vi.useFakeTimers();
    const api = fakeApi(TWO_FACTS);
    let finish!: () => void;
    api.undoForget.mockReturnValueOnce(new Promise<void>((r) => (finish = r)));
    render(<RememberedPill runId="r1" api={api} defaultOpen />);
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0]!);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    });
    expect(screen.getByText("Restoring…")).toBeTruthy();
    await act(async () => finish());
    await flush();
    expect(screen.getByRole("button", { name: /Remembered 2 facts/ })).toBeTruthy();
    cleanup();
    render(<RememberedPill runId="r1" api={api} />);
    await flush();
    expect(screen.getByRole("button", { name: /Remembered 2 facts/ })).toBeTruthy();
  });

  it("a failed Undo re-arms only the rest of the window", async () => {
    vi.useFakeTimers();
    const api = fakeApi(TWO_FACTS);
    api.undoForget.mockRejectedValueOnce(new Error("HTTP 500"));
    render(<RememberedPill runId="r1" api={api} defaultOpen />);
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0]!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await flush();
    expect(screen.getByText("Could not undo. Try again.")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS - 4_000);
    });
    expect(screen.queryByText(/Goal: 25/)).toBeNull();
  });

  it("a fact forgotten elsewhere (the /memory page) drops out of every cached pill", async () => {
    const api = fakeApi(TWO_FACTS);
    render(<RememberedPill runId="r1" api={api} />);
    await flush();
    cleanup();
    dropCachedNote("a");
    render(<RememberedPill runId="r1" api={api} />);
    await flush();
    expect(api.getWrites).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Remembered 1 fact/ })).toBeTruthy();
  });

  it("an update reads Updated <subject>, shows was, and Undo calls undo-update", async () => {
    const api = fakeApi({
      status: "done",
      items: [
        {
          note_id: "g2",
          kind: "updated",
          title: "Goal: 40 paying customers by December 23",
          body_excerpt: "",
          previous: { note_id: "g1", title: "Goal: 25 paying customers by December 23" },
        },
      ],
    });
    render(<RememberedPill runId="r1" api={api} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Updated goal/ }));
    expect(screen.getByText("was Goal: 25 paying customers by December 23")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await flush();
    expect(api.undoUpdate).toHaveBeenCalledWith("g2");
    expect(screen.getByText("Change undone")).toBeTruthy();
  });

  it("a conflict reads Two values on record and Keep this answers the pair", async () => {
    const api = fakeApi({
      status: "done",
      items: [
        {
          note_id: "n-new",
          kind: "conflict",
          title: "Meta pixel ID: 222",
          body_excerpt: "",
          conflict_with: { note_id: "n-old", title: "Meta pixel ID: 111" },
        },
      ],
    });
    render(<RememberedPill runId="r1" api={api} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Two values on record/ }));
    const keeps = screen.getAllByRole("button", { name: "Keep this" });
    expect(keeps).toHaveLength(2);
    fireEvent.click(keeps[1]!);
    await flush();
    expect(api.listConflicts).toHaveBeenCalled();
    expect(api.keepConflict).toHaveBeenCalledWith("pair-9", "n-old");
    expect(screen.getByText("Meta pixel ID: 111")).toBeTruthy();
    expect(screen.getByText("Kept. The other value is marked out of date.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Keep this" })).toBeNull();
  });

  it("a conflict row shows each value, not the shared title", async () => {
    const api = fakeApi(
      normalizeWrites({
        status: "done",
        items: [
          {
            note_id: "n-new",
            kind: "conflict",
            title: "company take rate",
            body_excerpt: "Take rate is 15%.",
            conflict_with: { note_id: "n-old", title: "company take rate", body_excerpt: "Take rate is 12%." },
          },
        ],
      }),
    );
    render(<RememberedPill runId="r1" api={api} defaultOpen />);
    await flush();
    expect(screen.getByText("Take rate is 15%.")).toBeTruthy();
    expect(screen.getByText("Take rate is 12%.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Keep this" })[1]!);
    await flush();
    expect(screen.getByText("Take rate is 12%.")).toBeTruthy();
    expect(screen.getByText("Kept. The other value is marked out of date.")).toBeTruthy();
  });

  it("uses the pair id from the write item when the server sends one", async () => {
    const api = fakeApi({
      status: "done",
      items: [
        {
          note_id: "n-new",
          kind: "conflict",
          title: "Take rate: 12%",
          body_excerpt: "",
          pair_id: "p-direct",
          conflict_with: { note_id: "n-old", title: "Take rate: 10%" },
        },
      ],
    });
    render(<RememberedPill runId="r1" api={api} defaultOpen />);
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Keep this" })[0]!);
    await flush();
    expect(api.listConflicts).not.toHaveBeenCalled();
    expect(api.keepConflict).toHaveBeenCalledWith("p-direct", "n-new");
  });

  it("a caption shows only when there is a pill", async () => {
    const api = fakeApi({ status: "done", items: [] });
    render(<RememberedPill runId="r1" api={api} caption="From the latest run, today" />);
    await flush();
    expect(screen.queryByText("From the latest run, today")).toBeNull();
  });
});

describe("pillLabel", () => {
  it("counts kept facts, names a single update, flags a conflict", () => {
    const add = { note_id: "x", kind: "added" as const, title: "A", body_excerpt: "" };
    expect(pillLabel([add], 1)).toBe("Remembered 1 fact");
    expect(pillLabel([add, { ...add, note_id: "y" }], 2)).toBe("Remembered 2 facts");
    expect(
      pillLabel([{ ...add, kind: "updated", title: "Price: $20", previous: { note_id: "p", title: "Price: $10" } }], 1),
    ).toBe("Updated price");
    expect(
      pillLabel([{ ...add, kind: "updated", title: "no subject here", previous: { note_id: "p", title: "old" } }], 1),
    ).toBe("Updated 1 fact");
    expect(pillLabel([add, { ...add, kind: "conflict", conflict_with: { note_id: "o", title: "B" } }], 2)).toBe(
      "Two values on record",
    );
  });
});

describe("normalizeWrites", () => {
  it("drops malformed items and downgrades an update with no previous note", () => {
    const out = normalizeWrites({
      status: "done",
      items: [
        { note_id: "a", kind: "added", title: "ok" },
        { note_id: "", kind: "added", title: "no id" },
        { note_id: "b", kind: "weird", title: "bad kind" },
        { note_id: "c", kind: "updated", title: "no previous" },
      ],
    });
    expect(out?.items.map((i) => [i.note_id, i.kind])).toEqual([
      ["a", "added"],
      ["c", "added"],
    ]);
    expect(normalizeWrites({ status: "nope", items: [] })).toBeNull();
  });
});

describe("memoryPillRowIndexes", () => {
  it("picks the latest replies only, one per run", () => {
    const rows = [
      { kind: "chat_user", agent_run_id: "r1" },
      { kind: "chat_assistant", agent_run_id: "r1" },
      { kind: "chat_assistant", agent_run_id: "r2" },
      { kind: "chat_assistant", agent_run_id: "r2" },
      { kind: "chat_assistant", agent_run_id: null },
      { kind: "chat_assistant", agent_run_id: "r3" },
    ];
    expect([...memoryPillRowIndexes(rows)].sort()).toEqual([1, 3, 5]);
    expect([...memoryPillRowIndexes(rows, 2)].sort()).toEqual([3, 5]);
  });
});
