// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const h = vi.hoisted(() => ({
  status: null as unknown,
  design: null as unknown,
  designStatus: 200,
  pickReplies: [] as Array<{ status: number; body: unknown } | "throw">,
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    h.calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : null });
    const reply = (r: Reply) => ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body });
    if (path === "/api/workspace/autopilot/site-design/direction") {
      const next = h.pickReplies.shift() ?? { status: 500, body: {} };
      if (next === "throw") throw new Error("offline");
      return reply(next);
    }
    if (path.startsWith("/api/workspace/autopilot/site-design?")) {
      return reply({ status: h.designStatus, body: { design: h.design } });
    }
    return reply({ status: 200, body: h.status });
  },
}));

import { BuildStatusPanel } from "./BuildStatusPanel";
import { resetSharedSiteDesigns, START_FAILED } from "@/lib/workspace/useSiteDesign";
import { BUILD_WITH_LOOK } from "../build/LookPicker";

const MIN = 60_000;
const T0 = Date.parse("2026-10-07T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DIRECTION = "/api/workspace/autopilot/site-design/direction";

function statusBody(scaffold: "pending" | "running") {
  return {
    run: {
      id: "run-1",
      status: "active",
      spend_usd: 0,
      max_usd: null,
      created_at: iso(T0 - 6 * MIN),
      updated_at: iso(T0),
      stages: [
        { stage: "provision", status: "done", started_at: iso(T0 - 6 * MIN), expected_ms: 2 * MIN, error: null },
        { stage: "spec", status: "done", started_at: iso(T0 - 4 * MIN), expected_ms: 4 * MIN, error: null },
        scaffold === "running"
          ? { stage: "scaffold", status: "running", started_at: iso(T0), expected_ms: 25 * MIN, error: null }
          : { stage: "scaffold", status: "pending", expected_ms: 25 * MIN, error: null },
        { stage: "build", status: "pending", expected_ms: 10 * MIN, error: null },
      ],
    },
    target: { repo_url: null, live_url: null },
  };
}

const look = (id: string) => ({
  id,
  label: `Look ${id}`,
  mood: `${id} mood`,
  recommended: id === "brand",
  fonts: { display: "Fraunces", body: "Inter" },
  swatches: { background: "#ffffff", foreground: "#111111", primary: "#2255aa", accent: "#ddeeff", muted: "#f3f3f3" },
  radius: "0.5rem",
});
const designRow = (awaiting: boolean, picked: boolean, chosen = "brand") => ({
  run_id: "run-1",
  awaiting_pick: awaiting,
  picked,
  source: "model",
  looks: [look("brand"), look("luxe"), look("studio")],
  chosen,
  applied: null,
  locked: null,
  plan: { audience: null, positioning: null, tone: null, main_action: null, sections: [], pages: [], facts: [] },
  checklist: null,
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
async function settle() {
  await flush();
  await flush();
}
const posts = () => h.calls.filter((c) => c.method === "POST");
const tiles = () => screen.queryAllByTestId(/^look-tile-/);
const buildButton = () => screen.getByRole("button", { name: BUILD_WITH_LOOK });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  window.sessionStorage.clear();
  resetSharedSiteDesigns();
  h.calls.length = 0;
  h.pickReplies.length = 0;
  h.designStatus = 200;
  h.status = statusBody("pending");
  h.design = designRow(true, false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Home build rail lets the founder pick a look while the build waits", () => {
  it("shows the three looks in the rail, not wide, with no progress bar", async () => {
    render(<BuildStatusPanel active />);
    await settle();
    const pick = screen.getByTestId("build-status-pick");
    expect(within(pick).getAllByTestId(/^look-tile-/).map((t) => t.dataset.testid)).toEqual([
      "look-tile-brand",
      "look-tile-luxe",
      "look-tile-studio",
    ]);
    expect(within(pick).getByRole("radiogroup").className).not.toMatch(/(^|\s)grid-cols-3(\s|$)/);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(/Waiting for you to pick a website/)).toBeTruthy();
    expect(buildButton().hasAttribute("disabled")).toBe(true);
  });

  it("a tile click only selects; Build with this look sends exactly one POST and the progress comes back", async () => {
    render(<BuildStatusPanel active />);
    await settle();
    fireEvent.click(screen.getByTestId("look-tile-luxe"));
    fireEvent.click(screen.getByTestId("look-tile-studio"));
    fireEvent.click(screen.getByTestId("look-tile-luxe"));
    await settle();
    expect(posts()).toHaveLength(0);
    expect(screen.getByTestId("look-tile-luxe").getAttribute("aria-checked")).toBe("true");

    h.pickReplies.push({ status: 200, body: { started: true, design: designRow(false, true, "luxe") } });
    h.design = designRow(false, true, "luxe");
    h.status = statusBody("running");
    await act(async () => {
      fireEvent.click(buildButton());
      fireEvent.click(buildButton());
    });
    await settle();
    expect(posts()).toEqual([{ path: DIRECTION, method: "POST", body: { run_id: "run-1", direction: "luxe" } }]);
    await act(async () => void vi.advanceTimersByTime(2_000));
    await settle();
    expect(screen.queryByTestId("build-status-pick")).toBeNull();
    expect(tiles()).toHaveLength(0);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(document.body.textContent).toMatch(/About 35 minutes left/);
    expect(document.body.textContent).not.toContain("Waiting for you to pick a website");
    expect(posts()).toHaveLength(1);
  });

  it("a refused start keeps the tiles, shows the reason and lets the founder try again", async () => {
    h.pickReplies.push({ status: 409, body: { error: { message: "That look is no longer available." } } });
    render(<BuildStatusPanel active />);
    await settle();
    fireEvent.click(screen.getByTestId("look-tile-studio"));
    fireEvent.click(buildButton());
    await settle();
    expect(posts()).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe("That look is no longer available.");
    expect(tiles()).toHaveLength(3);
    expect(screen.queryByRole("progressbar")).toBeNull();

    h.pickReplies.push("throw");
    fireEvent.click(buildButton());
    await settle();
    expect(posts()).toHaveLength(2);
    expect(tiles()).toHaveLength(3);
    expect(screen.getByRole("alert").textContent).toMatch(/connection/);

    h.pickReplies.push({ status: 500, body: null });
    fireEvent.click(buildButton());
    await settle();
    expect(posts()).toHaveLength(3);
    expect(screen.getByRole("alert").textContent).toBe(START_FAILED);
    expect(tiles()).toHaveLength(3);
  });

  it("offers the Build view for this run when the shell gives a way there", async () => {
    const onOpenBuild = vi.fn();
    render(<BuildStatusPanel active onOpenBuild={onOpenBuild} />);
    await settle();
    fireEvent.click(screen.getByTestId("build-status-open-build"));
    expect(onOpenBuild).toHaveBeenCalledTimes(1);
    expect(onOpenBuild).toHaveBeenCalledWith("run-1");
    expect(posts()).toHaveLength(0);
  });

  it("flag off: no picker, the progress shows as before and nothing is posted", async () => {
    h.design = designRow(false, false);
    h.status = statusBody("running");
    render(<BuildStatusPanel active onOpenBuild={() => undefined} />);
    await settle();
    expect(screen.queryByTestId("build-status-pick")).toBeNull();
    expect(screen.queryByTestId("build-status-open-build")).toBeNull();
    expect(tiles()).toHaveLength(0);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.getByText("Your AI team is building")).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it("a build with no brief (404) shows no picker", async () => {
    h.designStatus = 404;
    h.status = statusBody("running");
    render(<BuildStatusPanel active onOpenBuild={() => undefined} />);
    await settle();
    expect(screen.queryByTestId("build-status-pick")).toBeNull();
    expect(tiles()).toHaveLength(0);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it("a stopped build never offers the picker even if the brief still says awaiting", async () => {
    h.status = { ...statusBody("pending"), run: { ...statusBody("pending").run, status: "halted" } };
    render(<BuildStatusPanel active={false} />);
    await settle();
    expect(screen.queryByTestId("build-status-pick")).toBeNull();
  });
});
