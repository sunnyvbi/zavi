// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const session = vi.hoisted(() => ({ value: {} as Record<string, unknown>, ids: [] as Array<string | null> }));
const api = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body: unknown }> }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string, init?: { body?: string }) => {
    api.calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
    return new Response("{}", { status: 202 });
  }),
}));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  useBuildSession: (id: string | null) => {
    session.ids.push(id);
    return session.value;
  },
}));

import { BuildHistoryPanel, buildCheckpoints, checkpointPreviewUrl, formatStamp, prewarmCheckpointId } from "./BuildHistoryPanel";

const RUN = {
  id: "run-1",
  objective: "Build product: Mohit — A coming-soon page",
  status: "done",
  createdAt: "2026-09-24T06:55:00.000Z",
  updatedAt: "2026-09-24T07:10:00.000Z",
  stages: [],
  failure: null,
};
const refine = (id: string, at: string, status: string, message: string, summary: string | null = null) => ({
  id,
  message,
  status,
  created_at: at,
  summary,
  failure_message: status === "failed" ? "Deploy failed" : null,
});

afterEach(() => {
  cleanup();
  session.ids.length = 0;
});

describe("buildCheckpoints", () => {
  it("lists the first build and every change, newest first", () => {
    const list = buildCheckpoints(RUN, [
      refine("r1", "2026-09-24T08:00:00.000Z", "done", "Darker hero"),
      refine("r2", "2026-09-24T09:00:00.000Z", "running", "Add FAQ"),
    ]);
    expect(list.map((c) => c.id)).toEqual(["r2", "r1", "run-1"]);
    expect(list.map((c) => c.state)).toEqual(["working", "shipped", "shipped"]);
    expect(list[2]).toMatchObject({ title: "A coming-soon page", kind: "build" });
  });

  it("marks a stopped change as failed and keeps its reason", () => {
    const [failed] = buildCheckpoints(null, [refine("r1", "2026-09-24T08:00:00.000Z", "failed", "Add pricing")]);
    expect(failed).toMatchObject({ state: "failed", summary: "Deploy failed" });
  });

  it("never marks a discarded draft as live", () => {
    const [discarded] = buildCheckpoints(null, [
      { ...refine("r1", "2026-09-24T08:00:00.000Z", "done", "Try a darker hero"), discarded: true },
    ]);
    expect(discarded).toMatchObject({ state: "shipped", live: false, discarded: true });
  });

  it("a discarded draft never carries the change summary of the change that was thrown away", () => {
    const [discarded, kept] = buildCheckpoints(null, [
      {
        ...refine("r1", "2026-09-24T08:00:00.000Z", "done", "Try a darker hero"),
        draft: true,
        discarded: true,
        summary: "The hero is darker.",
      },
      { ...refine("r2", "2026-09-23T08:00:00.000Z", "done", "Green button"), summary: "The button is green." },
    ]);
    expect(discarded).toMatchObject({ id: "r1", discarded: true, summary: null });
    expect(kept).toMatchObject({ id: "r2", summary: "The button is green." });
  });
});

describe("formatStamp", () => {
  it("reads like the reference: short month, day and time", () => {
    const at = new Date(2026, 8, 24, 13, 48).toISOString();
    expect(formatStamp(at)).toBe("Sep 24, 1:48 PM");
    expect(formatStamp(null)).toBe("");
    expect(formatStamp("not a date")).toBe("");
  });
});

describe("BuildHistoryPanel", () => {
  const show = (value: Record<string, unknown>, onClose = vi.fn()) => {
    session.value = { loaded: true, run: RUN, refines: [], ...value };
    render(<BuildHistoryPanel sessionId="run-1" onClose={onClose} />);
    return onClose;
  };

  it("reads this build's own session", () => {
    show({});
    expect(session.ids.every((id) => id === "run-1")).toBe(true);
  });

  it("marks the newest shipped checkpoint as current, not one still in progress", () => {
    show({
      refines: [
        refine("r1", "2026-09-24T08:00:00.000Z", "done", "Darker hero"),
        refine("r2", "2026-09-24T09:00:00.000Z", "running", "Add FAQ"),
      ],
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((li) => li.textContent?.startsWith("Add FAQ") || li.textContent?.startsWith("Darker hero") || li.textContent?.startsWith("A coming-soon page"))).toEqual([true, true, true]);
    const current = rows.filter((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(within(current[0]!).getByText("Darker hero")).toBeTruthy();
    expect(within(rows[0]!).getByText("In progress")).toBeTruthy();
  });

  it("does not call a change current while it is saved but not live yet", () => {
    show({
      refines: [
        refine("r1", "2026-09-24T08:00:00.000Z", "done", "Darker hero"),
        { ...refine("r2", "2026-09-24T09:00:00.000Z", "done", "Add FAQ"), awaiting_review: true },
      ],
    });
    const rows = screen.getAllByRole("listitem");
    const current = rows.filter((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(within(current[0]!).getByText("Darker hero")).toBeTruthy();
    expect(within(rows[0]!).getByText("Add FAQ")).toBeTruthy();
    expect(within(rows[0]!).getByText("Not live yet")).toBeTruthy();
  });

  it("falls back to the first build as current when every change is parked or failed", () => {
    show({
      refines: [
        { ...refine("r1", "2026-09-24T08:00:00.000Z", "done", "Darker hero"), awaiting_review: true },
        refine("r2", "2026-09-24T09:00:00.000Z", "failed", "Add FAQ"),
      ],
    });
    const current = screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(within(current[0]!).getByText("A coming-soon page")).toBeTruthy();
  });

  it("shows a failed change that was retried once, as its retry, not as a second Stopped row", () => {
    show({
      refines: [
        refine("r1", "2026-09-24T08:00:00.000Z", "failed", "Add pricing"),
        { ...refine("r2", "2026-09-24T08:05:00.000Z", "done", "Add pricing"), retry_of: "r1" },
      ],
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(screen.getAllByText("Add pricing")).toHaveLength(1);
    expect(screen.queryByText("Stopped")).toBeNull();
    expect(screen.getByRole("heading", { name: /^History/ }).textContent).toBe("History2");
    const current = rows.filter((li) => li.getAttribute("aria-current") === "step");
    expect(within(current[0]!).getByText("Add pricing")).toBeTruthy();
  });

  it("has one sticky History heading and no tabs", () => {
    show({});
    const heading = screen.getByRole("heading", { name: /^History/ });
    expect(heading.parentElement?.className).toContain("sticky");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText(/Bookmark/)).toBeNull();
    expect(document.activeElement).toBe(heading);
  });

  it("closes on Escape", () => {
    const onClose = show({});
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says there are no checkpoints when the build has none", () => {
    show({ run: null, refines: [] });
    expect(screen.getByText("No history yet")).toBeTruthy();
  });

  it("shows a skeleton, not an empty state, while the build loads", () => {
    show({ loaded: false, run: null, refines: [] });
    expect(screen.queryByText("No history yet")).toBeNull();
    expect(screen.getByText("Loading history…")).toBeTruthy();
  });
});

describe("BuildHistoryPanel — a checkpoint opens its own preview", () => {
  const LIVE = "https://acme.zaviagent.com";
  const show = (refines: unknown[], props: Record<string, unknown> = {}) => {
    const onSelect = vi.fn();
    session.value = { loaded: true, run: RUN, refines };
    render(<BuildHistoryPanel sessionId="run-1" liveUrl={LIVE} onSelect={onSelect} onClose={vi.fn()} {...props} />);
    return onSelect;
  };

  it("a parked change never reuses its old branch preview link: it opens with no url so the version boots fresh", () => {
    const onSelect = show([
      { ...refine("r1", "2026-09-24T08:00:00.000Z", "done", "Add FAQ"), awaiting_review: true, preview_url: "https://pr-12.preview.example" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Add FAQ/ }));
    expect(onSelect).toHaveBeenCalledWith({ id: "r1", title: "Add FAQ", url: null, restorable: false });
  });

  it("a live-edit draft change is never the published app and can be previewed but not reverted to", () => {
    const onSelect = show([
      refine("r1", "2026-09-24T08:00:00.000Z", "done", "Darker hero"),
      { ...refine("r2", "2026-09-24T09:00:00.000Z", "done", "Add FAQ"), draft: true },
    ]);
    const faq = screen.getByRole("button", { name: /Add FAQ/ });
    expect(within(faq).getByText("Not live yet")).toBeTruthy();
    expect(within(faq).queryByText("Published")).toBeNull();
    expect(within(screen.getByRole("button", { name: /Darker hero/ })).getByText("Published")).toBeTruthy();
    fireEvent.click(faq);
    expect(onSelect).toHaveBeenCalledWith({ id: "r2", title: "Add FAQ", url: LIVE, restorable: false, draft: true });
  });

  it("an older shipped change that is no longer live opens with no url, never the current app", () => {
    const onSelect = show([
      refine("r1", "2026-09-24T08:00:00.000Z", "done", "Darker hero"),
      refine("r2", "2026-09-24T09:00:00.000Z", "done", "Add FAQ"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Darker hero/ }));
    fireEvent.click(screen.getByRole("button", { name: /A coming-soon page/ }));
    expect(onSelect.mock.calls.map((c) => c[0].url)).toEqual([null, null]);
    fireEvent.click(screen.getByRole("button", { name: /Add FAQ/ }));
    expect(onSelect.mock.calls[2][0]).toMatchObject({ id: "r2", url: LIVE });
  });

  it("only the live checkpoint opens the live app", () => {
    const onSelect = show([refine("r1", "2026-09-24T08:00:00.000Z", "done", "Darker hero")]);
    fireEvent.click(screen.getByRole("button", { name: /Darker hero/ }));
    fireEvent.click(screen.getByRole("button", { name: /A coming-soon page/ }));
    expect(onSelect.mock.calls.map((c) => c[0].url)).toEqual([LIVE, null]);
  });

  it("a change that never finished is disabled; a parked change without a saved preview still opens (with no url) so it can be reverted", () => {
    const onSelect = show([
      refine("r1", "2026-09-24T08:00:00.000Z", "failed", "Add pricing"),
      refine("r2", "2026-09-24T09:00:00.000Z", "running", "Add FAQ"),
      { ...refine("r3", "2026-09-24T10:00:00.000Z", "done", "Parked"), awaiting_review: true },
    ]);
    for (const name of [/Add pricing/, /Add FAQ/]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Parked/ }));
    expect(onSelect).toHaveBeenCalledWith({ id: "r3", title: "Parked", url: null, restorable: false });
  });

  it("a build that stopped at its preview and was never published shows no Published row and maps no live address", () => {
    const onSelect = vi.fn();
    session.value = { loaded: true, run: RUN, refines: [], sitePublished: false };
    render(<BuildHistoryPanel sessionId="run-1" liveUrl={LIVE} onSelect={onSelect} onClose={vi.fn()} />);
    expect(screen.queryByText("Published")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /A coming-soon page/ }));
    expect(onSelect.mock.calls[0][0].url).toBeNull();
  });

  it("while a change waits for Publish, the pane's draft address opens that change and the published row opens its own version", () => {
    const onSelect = show([
      refine("r1", "2026-09-24T08:00:00.000Z", "done", "Darker hero"),
      { ...refine("r2", "2026-09-24T09:00:00.000Z", "done", "Add FAQ"), draft: true },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Add FAQ/ }));
    fireEvent.click(screen.getByRole("button", { name: /Darker hero/ }));
    expect(onSelect.mock.calls.map((c) => [c[0].id, c[0].url])).toEqual([["r2", LIVE], ["r1", null]]);
    expect(within(screen.getByRole("button", { name: /Darker hero/ })).getByText("Published")).toBeTruthy();
  });

  it("ignores a preview_url that is not an http(s) link", () => {
    const [c] = buildCheckpoints(null, [{ ...refine("r1", "2026-09-24T08:00:00.000Z", "done", "X"), awaiting_review: true, preview_url: "javascript:alert(1)" }]);
    expect(c.previewUrl).toBeNull();
    expect(checkpointPreviewUrl(c, LIVE, "other")).toBeNull();
    expect(checkpointPreviewUrl(c, LIVE, c.id)).toBe(LIVE);
  });

  it("marks the selected checkpoint as pressed", () => {
    show([refine("r1", "2026-09-24T08:00:00.000Z", "done", "Darker hero")], { selectedId: "r1" });
    expect(screen.getByRole("button", { name: /Darker hero/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /A coming-soon page/ }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("BuildHistoryPanel — Lovable-style rows", () => {
  it("badges the live version as Published and outlines the selected row", () => {
    session.value = {
      loaded: true,
      run: RUN,
      refines: [refine("r1", "2026-09-24T08:00:00.000Z", "done", "Darker hero")],
    };
    render(<BuildHistoryPanel sessionId="run-1" liveUrl="https://acme.zaviagent.com" selectedId="run-1" onSelect={vi.fn()} onClose={vi.fn()} />);
    const live = screen.getByRole("button", { name: /Darker hero/ });
    expect(within(live).getByText("Published")).toBeTruthy();
    const selected = screen.getByRole("button", { name: /A coming-soon page/ });
    expect(within(selected).queryByText("Published")).toBeNull();
    expect(selected.className).toContain("border-ink/30");
    expect(live.className).not.toContain("border-ink/30");
    expect(document.body.innerHTML).not.toMatch(/#3b4fd8|#eef2ff/);
  });
});

describe("BuildHistoryPanel — reverts are versions too", () => {
  it("lists a restore row as the published version with its own mark", () => {
    session.value = {
      loaded: true,
      run: RUN,
      refines: [
        refine("r1", "2026-09-24T08:00:00.000Z", "done", "Darker hero"),
        { ...refine("rs", "2026-09-24T09:00:00.000Z", "done", "Reverted to A coming-soon page"), kind: "restore" },
      ],
    };
    render(<BuildHistoryPanel sessionId="run-1" liveUrl="https://acme.zaviagent.com" onSelect={vi.fn()} onClose={vi.fn()} />);
    const rows = screen.getAllByRole("button");
    expect(rows[0].textContent).toContain("Reverted to A coming-soon page");
    expect(within(rows[0]).getByText("Published")).toBeTruthy();
    expect(within(rows[1]).queryByText("Published")).toBeNull();
    expect(document.body.innerHTML).not.toContain("bg-ink px-2.5");
  });
});

describe("BuildHistoryPanel — what can be reverted to", () => {
  it("the original build and landed changes are restorable; a parked change is not", () => {
    const onSelect = vi.fn();
    session.value = {
      loaded: true,
      run: RUN,
      refines: [
        refine("r1", "2026-09-24T08:00:00.000Z", "done", "Landed"),
        { ...refine("r2", "2026-09-24T09:00:00.000Z", "done", "Parked"), awaiting_review: true },
      ],
    };
    render(<BuildHistoryPanel sessionId="run-1" liveUrl="https://acme.zaviagent.com" onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /A coming-soon page/ }));
    fireEvent.click(screen.getByRole("button", { name: /Landed/ }));
    fireEvent.click(screen.getByRole("button", { name: /Parked/ }));
    expect(onSelect.mock.calls.map((c) => [c[0].id, c[0].restorable])).toEqual([["run-1", true], ["r1", true], ["r2", false]]);
  });
});

describe("BuildHistoryPanel — older shipped versions stay revertible; a superseded session never claims the live app", () => {
  it("an older landed change is restorable even though a newer change is the published one", () => {
    const onSelect = vi.fn();
    session.value = {
      loaded: true,
      run: RUN,
      refines: [
        refine("r1", "2026-09-24T08:00:00.000Z", "done", "Older landed"),
        refine("r2", "2026-09-24T09:00:00.000Z", "done", "Newest landed"),
      ],
    };
    render(<BuildHistoryPanel sessionId="run-1" liveUrl="https://acme.zaviagent.com" onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Older landed/ }));
    expect(onSelect).toHaveBeenCalledWith({ id: "r1", title: "Older landed", url: null, restorable: true });
    expect(within(screen.getByRole("button", { name: /Newest landed/ })).getByText("Published")).toBeTruthy();
  });

  it("a session that is no longer current maps nothing to the live URL and shows no Published mark", () => {
    const onSelect = vi.fn();
    session.value = { loaded: true, isCurrent: false, run: RUN, refines: [refine("r1", "2026-09-24T08:00:00.000Z", "done", "Old app change")] };
    render(<BuildHistoryPanel sessionId="run-1" liveUrl="https://acme.zaviagent.com" onSelect={onSelect} onClose={vi.fn()} />);
    expect(screen.queryByText("Published")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Old app change/ }));
    expect(onSelect.mock.calls[0][0].url).toBeNull();
  });
});

describe("prewarm: History builds the likely next pick ahead of the click", () => {
  const refines = [
    refine("r3", "2026-09-24T10:00:00.000Z", "running", "Add FAQ"),
    refine("r2", "2026-09-24T09:00:00.000Z", "done", "Darker hero"),
    { ...refine("r1", "2026-09-24T08:00:00.000Z", "done", "Try green"), discarded: true },
  ];

  it("picks the newest finished version the pane cannot already show", () => {
    const list = buildCheckpoints(RUN, refines);
    expect(prewarmCheckpointId(list, "https://live.example/", "r2", null)).toBe("run-1");
    expect(prewarmCheckpointId(list, null, null, null)).toBe("r2");
    expect(prewarmCheckpointId([], null, null, null)).toBeNull();
  });

  it("asks once per version, only for a site session", () => {
    api.calls.length = 0;
    session.value = { loaded: true, run: RUN, refines: [refine("r9", "2026-09-24T09:00:00.000Z", "done", "Bigger logo")], isCurrent: true, sitePublished: true };
    const { unmount } = render(<BuildHistoryPanel sessionId="s-warm" liveUrl="https://live.example/" onClose={() => {}} />);
    expect(api.calls).toEqual([]);
    unmount();
    render(<BuildHistoryPanel sessionId="s-warm" liveUrl="https://live.example/" prewarm onClose={() => {}} />);
    cleanup();
    render(<BuildHistoryPanel sessionId="s-warm" liveUrl="https://live.example/" prewarm onClose={() => {}} />);
    expect(api.calls).toEqual([{ path: "/api/workspace/autopilot/version-preview", body: { conductor_run_id: "run-1", prewarm: true } }]);
  });
});
