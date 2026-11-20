// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string }>,
  mine: { requests: [] as unknown[], updates: 0 },
  failMine: false,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts?: { method?: string }) => {
    const method = opts?.method ?? "GET";
    state.calls.push({ path, method });
    if (path === "/api/feedback/product/mine") {
      if (state.failMine) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      const body = state.mine;
      state.mine = { ...state.mine, updates: 0 };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  },
}));

import { FeedbackRequestList } from "./FeedbackRequestList";
import { useMyFeedback } from "@/lib/workspace/useMyFeedback";

function Badge() {
  const { updates } = useMyFeedback();
  return <span data-testid="badge">{updates}</span>;
}

beforeEach(() => {
  state.calls = [];
  state.failMine = false;
  state.mine = { requests: [], updates: 0 };
});
afterEach(() => cleanup());

describe("FeedbackRequestList", () => {
  it("shows the empty state in the same list", async () => {
    render(<FeedbackRequestList />);
    expect(await screen.findByText("Nothing sent yet. What you send shows here with its status.")).toBeTruthy();
    expect(screen.getByText("We email you when it's done or closed.")).toBeTruthy();
  });

  it("says it could not load", async () => {
    state.failMine = true;
    render(<FeedbackRequestList />);
    expect(await screen.findByText("Couldn't load your requests.")).toBeTruthy();
  });

  it("shows each status in words, the team note, and marks updated rows", async () => {
    state.mine = {
      requests: [
        { id: "a", body: "Fix the report", created_at: "2026-10-21T12:00:00Z", status: "done", staff_note: "Fixed on our side.", updated: true },
        { id: "b", body: "Weekly email time", created_at: "2026-10-16T12:00:00Z", status: "working", staff_note: null, updated: false },
        { id: "c", body: "Pick a day", created_at: "2026-10-15T12:00:00Z", status: "wont_do", staff_note: null, updated: false },
      ],
      updates: 1,
    };
    render(<FeedbackRequestList />);
    expect(await screen.findByText("Done")).toBeTruthy();
    expect(screen.getByText("Working on it")).toBeTruthy();
    expect(screen.getByText("Not planned")).toBeTruthy();
    expect(screen.getByText("Fixed on our side.")).toBeTruthy();
    expect(screen.getAllByText("● Updated")).toHaveLength(1);
  });

  it("opening the list clears the badge on a sidebar that is already showing", async () => {
    state.mine = {
      requests: [{ id: "a", body: "Fix it", created_at: "2026-10-21T12:00:00Z", status: "done", staff_note: null, updated: true }],
      updates: 1,
    };
    render(<Badge />);
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("1"));
    state.mine = { ...state.mine, updates: 1 };
    render(<FeedbackRequestList />);
    await waitFor(() => expect(state.calls.some((c) => c.path === "/api/feedback/product/seen" && c.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("badge").textContent).toBe("0"));
    expect(screen.getByText("● Updated")).toBeTruthy();
  });
});

describe("useMyFeedback ordering and reload failures", () => {
  it("never shows an old empty list after a reload fails", async () => {
    render(<FeedbackRequestList />);
    expect(await screen.findByText("Nothing sent yet. What you send shows here with its status.")).toBeTruthy();
    state.failMine = true;
    window.dispatchEvent(new Event("zavi:feedback-changed"));
    expect(await screen.findByText("Couldn't load your requests.")).toBeTruthy();
    expect(screen.queryByText("Nothing sent yet. What you send shows here with its status.")).toBeNull();
  });
});
