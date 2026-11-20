// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
  posts: [] as Array<{ path: string; body: unknown }>,
  confirms: [] as Array<{ options: Record<string, unknown>; resolve: (v: boolean) => void }>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: { method?: string; body?: string }) => {
    const key = path.split("?")[0]!;
    if (init?.method === "POST") {
      net.posts.push({ path: key, body: init.body ? JSON.parse(init.body) : null });
    }
    return new Promise((resolve) => {
      const queue = net.pending.get(key) ?? [];
      queue.push((r: Reply) =>
        resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          json: async () => r.body,
        }),
      );
      net.pending.set(key, queue);
    });
  },
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: () => {},
}));
vi.mock("@/lib/workspace/useBuildPreview", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/workspace/useBuildPreview")>();
  return {
    ...real,
    pollDelayMs: () => 5,
    sharedBuildRead: (path: string) => real.sharedBuildRead(path, { fresh: true }),
  };
});
vi.mock("@/components/ui/ConfirmDialog", () => ({
  confirmAction: (options: Record<string, unknown>) =>
    new Promise<boolean>((resolve) => {
      net.confirms.push({ options, resolve });
    }),
}));

import { BuildTranscript } from "./BuildModePane";

const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";
const UNDO = "/api/workspace/autopilot/refine-undo";
const LIVE = "https://yoga-flow.zaviagent.com/";

const run = {
  id: SESSION,
  objective: "Build product: Yoga studio booking",
  status: "done",
  created_at: "2026-09-29T06:55:00.000Z",
  updated_at: "2026-09-29T07:10:00.000Z",
  stages: [],
};

const edit = (id: string, message: string, minute: number, extra: Record<string, unknown> = {}) => ({
  id,
  message,
  status: "done",
  created_at: `2026-09-29T08:${String(minute).padStart(2, "0")}:00.000Z`,
  finished_at: `2026-09-29T08:${String(minute + 1).padStart(2, "0")}:00.000Z`,
  summary: `Changed: ${message}`,
  kind: "change",
  ...extra,
});

const headline = edit("edit-1", "Make the hero say Breathe. Stretch. Belong.", 1, { undoable: false });
const colour = edit("edit-2", "Change the primary color to sage green", 5, { undoable: false });
const better = edit("edit-3", "Make it better", 9, { undoable: true });
const undoRow = {
  id: "undo-1",
  message: "Undid the last change",
  status: "done",
  created_at: "2026-09-29T08:20:00.000Z",
  kind: "undo",
  parent_conductor_run_id: "edit-3",
};

async function reply(path: string, r: Reply) {
  await waitFor(() => expect(net.pending.get(path)?.length ?? 0).toBeGreaterThan(0));
  const next = net.pending.get(path)!.shift()!;
  await act(async () => {
    next(r);
  });
}

async function mount(refines: unknown[]) {
  render(<BuildTranscript sessionId={SESSION} />);
  await reply(STATUS, { status: 200, body: { run, target: { live_url: LIVE } } });
  await reply(REFINES, { status: 200, body: { refines: [...refines].reverse() } });
}

async function answerConfirm(value: boolean) {
  await waitFor(() => expect(net.confirms.length).toBeGreaterThan(0));
  const c = net.confirms.shift()!;
  await act(async () => {
    c.resolve(value);
  });
  return c.options;
}

function undoButtons() {
  return screen.queryAllByRole("button", { name: /Undo this change/ });
}

afterEach(() => {
  cleanup();
  net.pending.clear();
  net.posts.length = 0;
  net.confirms.length = 0;
});

describe("Undo this change on an edit reply (DEL-1323 B29, Q13)", () => {
  it("the ticket's three edits: only the newest live one offers Undo, and it reverts that edit and shows the undo", async () => {
    await mount([headline, colour, better]);
    await waitFor(() => expect(undoButtons()).toHaveLength(1));
    const replies = screen.getAllByTestId("build-reply");
    const newest = replies.find((r) => r.textContent?.includes("Make it better"))!;
    expect(newest.contains(undoButtons()[0]!)).toBe(true);

    fireEvent.click(undoButtons()[0]!);
    const options = await answerConfirm(true);
    expect(options.title).toBe("Undo this change?");

    await waitFor(() => expect(net.posts).toEqual([{ path: UNDO, body: { conductor_run_id: "edit-3" } }]));
    await reply(UNDO, { status: 200, body: { ok: true, undo_conductor_run_id: "undo-1" } });

    await waitFor(() => expect(undoButtons()).toHaveLength(0));
    await reply(REFINES, {
      status: 200,
      body: { refines: [undoRow, { ...better, undoable: false }, colour, headline] },
    });
    await waitFor(() => screen.getByText("Undid the last change"));
    expect(undoButtons()).toHaveLength(0);
    expect(net.posts).toHaveLength(1);
  });

  it("cancelling the confirm never reverts anything", async () => {
    await mount([headline, better]);
    await waitFor(() => expect(undoButtons()).toHaveLength(1));
    fireEvent.click(undoButtons()[0]!);
    await answerConfirm(false);
    expect(net.posts).toEqual([]);
    expect(undoButtons()).toHaveLength(1);
  });

  it("pressing twice before confirming asks once and reverts once", async () => {
    await mount([better]);
    await waitFor(() => expect(undoButtons()).toHaveLength(1));
    fireEvent.click(undoButtons()[0]!);
    fireEvent.click(undoButtons()[0]!);
    await answerConfirm(true);
    await waitFor(() => expect(net.posts).toHaveLength(1));
    expect(net.confirms).toHaveLength(0);
    screen.getByRole("button", { name: /Undoing/ });
    expect((screen.getByRole("button", { name: /Undoing/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a refused undo explains why in plain words and keeps the change", async () => {
    await mount([better]);
    await waitFor(() => expect(undoButtons()).toHaveLength(1));
    fireEvent.click(undoButtons()[0]!);
    await answerConfirm(true);
    await reply(UNDO, { status: 404, body: { error: { code: "no_undoable_refine", message: "no shipped refine to undo" } } });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "This change can't be undone any more, because a newer change or undo came after it.",
      ),
    );
    expect(screen.queryByText(/no shipped refine/)).toBeNull();
  });

  it.each([
    [403, "forbidden", "Viewers can't undo changes. Ask a workspace owner, admin or member."],
    [403, "product_builder_disabled", "Changing your app is turned off right now, so nothing was undone."],
    [409, "newer_change", "This change can't be undone any more, because your app changed after it."],
    [409, "build_in_progress", "Wait for the change that's running to finish, then try again."],
    [409, "undo_in_progress", "This change is already being undone."],
    [
      409,
      "undo_commit_not_found",
      "We couldn't find the saved version of this change, so it can't be undone from here. Your site hasn't changed.",
    ],
    [
      409,
      "unpublished_draft",
      "Your preview has edits that aren't published yet. Publish or discard them, then try again.",
    ],
  ])("a %i %s refusal says what actually happened and keeps the button", async (status, code, copy) => {
    await mount([better]);
    await waitFor(() => expect(undoButtons()).toHaveLength(1));
    fireEvent.click(undoButtons()[0]!);
    await answerConfirm(true);
    await reply(UNDO, { status, body: { error: { code, message: "server words" } } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(copy));
    expect(screen.queryByText(/server words/)).toBeNull();
    expect(screen.queryByText(/a newer change or undo came after it/)).toBeNull();
    expect(undoButtons()).toHaveLength(1);
  });

  it("an undo that landed but did not republish or reset the preview says so instead of promising the live site", async () => {
    await mount([better]);
    await waitFor(() => expect(undoButtons()).toHaveLength(1));
    fireEvent.click(undoButtons()[0]!);
    await answerConfirm(true);
    await reply(UNDO, {
      status: 200,
      body: { ok: true, undo_conductor_run_id: "undo-1", republished: false, draft_reset: false, history_recorded: true },
    });
    await waitFor(() => expect(undoButtons()).toHaveLength(0));
    const notice = await screen.findByTestId("refine-undo-notice");
    expect(notice.textContent).toBe(
      "The change was undone, but the live site didn't update. Publish your site again to put the undo live. Your preview may still show the old change. Discard the preview draft before your next edit.",
    );
    expect(net.posts).toHaveLength(1);
  });

  it("a clean undo shows no warning", async () => {
    await mount([better]);
    await waitFor(() => expect(undoButtons()).toHaveLength(1));
    fireEvent.click(undoButtons()[0]!);
    await answerConfirm(true);
    await reply(UNDO, { status: 200, body: { ok: true, republished: true, draft_reset: true, history_recorded: true } });
    await waitFor(() => expect(undoButtons()).toHaveLength(0));
    expect(screen.queryByTestId("refine-undo-notice")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Undo sits in the reply's action row as the same button as Copy, icon size and colour included", async () => {
    await mount([better]);
    await waitFor(() => expect(undoButtons()).toHaveLength(1));
    const undo = undoButtons()[0]!;
    const row = undo.parentElement!;
    const copy = Array.from(row.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Copy message")!;
    expect(copy).toBeTruthy();
    const classes = (b: Element) => b.className.split(/\s+/).filter((c) => c !== "disabled:opacity-60").sort();
    expect(classes(undo)).toEqual(classes(copy));
    const icon = (b: Element) => {
      const svg = b.querySelector("svg")!;
      return [svg.getAttribute("width"), svg.getAttribute("height"), svg.getAttribute("stroke-width")];
    };
    expect(icon(undo)).toEqual(icon(copy));
    expect(undo.className).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("key off (no undoable flag): no Undo button on any reply", async () => {
    const { undoable: _drop, ...plain } = better as typeof better & { undoable?: boolean };
    await mount([headline, plain]);
    await waitFor(() => screen.getByText("Make it better"));
    expect(undoButtons()).toHaveLength(0);
  });

  it("an edit that failed or is still in draft never shows Undo even if flagged", async () => {
    await mount([
      edit("edit-4", "Add a pricing page", 12, { status: "failed", undoable: true }),
      edit("edit-5", "Add a FAQ", 15, { status: "active", undoable: true }),
    ]);
    await waitFor(() => screen.getByText("Add a FAQ"));
    expect(undoButtons()).toHaveLength(0);
  });
});
