// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { buildRunPanel } from "@zavi/shared";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    const key = path.split("?")[0]!;
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

import { BuildTranscript, CHANGE_TIP_MS, changeWaitTips } from "./BuildModePane";

const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";

const run = {
  id: SESSION,
  objective: "Build product: Mohit — A bike rental site",
  status: "done",
  created_at: "2026-09-28T06:55:00.000Z",
  updated_at: "2026-09-28T07:10:00.000Z",
  stages: [],
};

const livePanel = buildRunPanel(
  [
    {
      id: "1",
      kind: "reasoning",
      body: { text: "Reading the current hero section." },
    },
    { id: "2", kind: "file_edit", body: { path: "src/app/pricing.tsx" } },
  ],
  { state: "running" },
);

const refine = (extra: Record<string, unknown>) => ({
  id: "a0000000-0000-4000-8000-000000000000",
  message: "Add a pricing table",
  status: "active",
  created_at: "2026-09-28T08:00:00.000Z",
  ...extra,
});

async function reply(path: string, r: Reply) {
  await waitFor(() =>
    expect(net.pending.get(path)?.length ?? 0).toBeGreaterThan(0),
  );
  const next = net.pending.get(path)!.shift()!;
  await act(async () => {
    next(r);
  });
}

async function mount(refines: unknown[]) {
  render(<BuildTranscript sessionId={SESSION} />);
  await reply(STATUS, {
    status: 200,
    body: { run, target: { live_url: "https://shop.test" } },
  });
  await reply(REFINES, { status: 200, body: { refines } });
}

function reply_(): HTMLElement {
  return screen.getByTestId("build-reply");
}

afterEach(() => {
  cleanup();
  net.pending.clear();
});

describe("BuildTranscript — under the hood of a change being made", () => {

  it("estimates only from the founder's own finished changes, and the active step moves instead of sitting half full", async () => {
    const done = (id: string, start: string, end: string) =>
      refine({ id, status: "done", created_at: start, finished_at: end, summary: "Done." });
    await mount([
      done("a1000000-0000-4000-8000-000000000001", "2026-09-28T07:00:00.000Z", "2026-09-28T07:01:30.000Z"),
      done("a1000000-0000-4000-8000-000000000002", "2026-09-28T07:10:00.000Z", "2026-09-28T07:11:50.000Z"),
      refine({ id: "a1000000-0000-4000-8000-000000000003", panel: livePanel, created_at: new Date().toISOString() }),
    ]);
    const card = screen.getByTestId("change-progress");
    expect(within(card).getByText(/^\d+s elapsed · Your recent changes took about 2 minutes$/)).toBeTruthy();
    const working = within(card).getByTestId("change-working");
    expect(working.className).toContain("animate-indeterminate-bar");
    expect(working.className).not.toContain("animate-pulse");
  });

  it("frames a change as an edit, never as the from-scratch build checklist", async () => {
    await mount([refine({ panel: livePanel })]);
    const wrap = reply_();
    const card = within(wrap).getByTestId("change-progress");
    expect(within(card).getByText("Changing your site")).toBeTruthy();
    expect(within(card).getByText(/^[\dhms ]+ elapsed$/)).toBeTruthy();
    expect(within(card).queryByText(/minutes total/)).toBeNull();
    for (const label of [
      "Understanding your request",
      "Inspecting the current app",
      "Applying the update",
      "Checking and publishing",
    ]) {
      expect(within(wrap).queryByText(label)).toBeNull();
    }
    expect(within(wrap).queryByRole("list", { name: "Update progress" })).toBeNull();
    for (const step of ["Editing", "Checking", "Going live", "Ready in preview"]) {
      expect(within(card).queryByText(step)).toBeNull();
    }
    expect(within(card).getByTestId("change-tip").textContent).toBe(changeWaitTips(false)[0]);
  });

  it("keeps the agent's live sentence and its work one tap away", async () => {
    await mount([refine({ panel: livePanel })]);
    const card = within(reply_()).getByTestId("change-progress");
    const fold = card.querySelector("details") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    const summary = fold.querySelector("summary")!;
    expect(within(summary).getByText("Reading the current hero section.")).toBeTruthy();
    expect(within(summary).getByText("Update in progress").className).toContain("sr-only");
    expect(fold.contains(within(card).getByText("Edited code"))).toBe(true);
    expect(within(reply_()).queryByText("Zavi is working")).toBeNull();
  });

  it("before the engineer says anything it still shows the edit card, with no empty fold", async () => {
    await mount([refine({ panel: null })]);
    const card = within(reply_()).getByTestId("change-progress");
    expect(within(card).getByText("Getting started…")).toBeTruthy();
    expect(card.querySelector("details")).toBeNull();
    expect(within(card).getByTestId("change-working")).toBeTruthy();
  });

  it("keeps the agent's line live when its work has settled but the change is not ready yet", async () => {
    await mount([
      refine({
        panel: { ...livePanel, state: "finished", summary: "Edited 1 file" },
      }),
    ]);
    const card = within(reply_()).getByTestId("change-progress");
    expect(within(card).getByText("Edited 1 file").className).toContain("zavi-shimmer");
    expect(within(card).getByTestId("change-working")).toBeTruthy();
  });

  it("rotates honest wait tips while the change runs, and says Publish is still needed when changes stop at the preview", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<BuildTranscript sessionId={SESSION} publishOnRequest />);
      await reply(STATUS, { status: 200, body: { run, target: { live_url: "https://shop.test" } } });
      await reply(REFINES, { status: 200, body: { refines: [refine({ panel: livePanel })] } });
      const card = within(reply_()).getByTestId("change-progress");
      const tips = changeWaitTips(true);
      expect(tips).toContain("Nothing changes at your site's address until you press Publish.");
      const seen = [within(card).getByTestId("change-tip").textContent];
      for (let i = 1; i < tips.length + 1; i += 1) {
        await act(async () => {
          vi.advanceTimersByTime(CHANGE_TIP_MS);
        });
        seen.push(within(card).getByTestId("change-tip").textContent);
      }
      expect(seen).toEqual([...tips, tips[0]]);
      expect(within(card).queryByText("Going live")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the tips once the change is done", async () => {
    await mount([refine({ status: "done", summary: "Added three plans." })]);
    expect(screen.queryByTestId("change-tip")).toBeNull();
    expect(screen.queryByTestId("change-working")).toBeNull();
  });

  it("shows no progress fold once the change is live, only the card with what changed folded away", async () => {
    await mount([
      refine({
        status: "done",
        summary: "Added three plans.",
        panel: livePanel,
      }),
    ]);
    expect(screen.queryByRole("list", { name: "Change progress" })).toBeNull();
    const card = screen
      .getByText("Live on your app")
      .closest('[data-testid="build-reply"]') as HTMLElement;
    const folds = Array.from(card.querySelectorAll("details"));
    expect(folds).toHaveLength(1);
    expect(folds[0]!.getAttribute("data-testid")).toBe("change-summary");
    expect((folds[0] as HTMLDetailsElement).open).toBe(false);
    expect(within(folds[0]!).getByText("Added three plans.")).toBeTruthy();
  });

  it("a change on a never-published site checks the preview and is never called live (QA R6-4, R6-5)", async () => {
    const mountUnpublished = async (refines: unknown[]) => {
      render(<BuildTranscript sessionId={SESSION} publishOnRequest />);
      await reply(STATUS, { status: 200, body: { run } });
      await reply(REFINES, { status: 200, body: { refines } });
    };
    await mountUnpublished([refine({ panel: livePanel })]);
    expect(within(reply_()).getByTestId("change-working")).toBeTruthy();
    expect(within(reply_()).queryByText("Going live")).toBeNull();
    cleanup();
    net.pending.clear();
    await mountUnpublished([refine({ status: "done", summary: "Added a badge." })]);
    expect(within(reply_()).getByText("Ready in your preview")).toBeTruthy();
    expect(within(reply_()).queryByText("Live on your app")).toBeNull();
    expect(within(reply_()).getByText("Added a badge.")).toBeTruthy();
  });

  it("labels a deleted draft as discarded instead of live", async () => {
    await mount([
      refine({ status: "done", summary: "Tried a darker hero.", discarded: true }),
    ]);
    const card = screen.getByText("Discarded").closest('[data-testid="build-reply"]') as HTMLElement;
    expect(within(card).getByText("This draft change was discarded and is not live.")).toBeTruthy();
    expect(within(card).queryByText("Live on your app")).toBeNull();
  });
});
