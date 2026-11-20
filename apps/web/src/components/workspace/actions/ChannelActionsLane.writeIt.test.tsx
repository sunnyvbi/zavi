// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { APPROVALS_CHANGED_EVENT, announceChannelRunStarted } from "./topActions/api";
import { ATTENTION_CHANGED_EVENT } from "@/lib/workspace/needsYou";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("../WorkspaceShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../WorkspaceShell")>()),
  useWorkspaceOptional: () => ({ role: "owner", tabs: [], activeTabId: null }),
}));

const RUN = "5b0c1e2a-0000-4000-8000-000000000001";
const SLUG = "email_marketing";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const notOk = (status: number) => ({ ok: false, status, json: async () => ({ error: { message: "nope" } }) });
let actionsBody: Record<string, unknown> = {};
let run: { status: string; actions: unknown[] } | "down" | "gone" = { status: "queued", actions: [] };
const urls = () => apiFetch.mock.calls.map((c) => String(c[0]));
const runReads = () => urls().filter((u) => u.includes(`/top-actions/runs/${RUN}`)).length;
const listReads = () => urls().filter((u) => u.includes(`/api/channels/${SLUG}/actions`)).length;
const working = () => document.body.textContent?.includes("Cooking up new suggestions for") ?? false;

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(workState: "idle" | "running" = "idle") {
  return render(
    <ChannelActionsLane slug={SLUG} legacy={<p>LEGACY RAIL</p>} workState={workState} lastRunAt={null} actionCount={0} connected hasConnectors>
      <li>an approvals row</li>
    </ChannelActionsLane>,
  );
}

let approvalsChanged = 0;
let hour = 0;
const onApprovals = () => {
  approvalsChanged += 1;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 28, 10) + hour++ * 3_600_000));
  apiFetch.mockReset();
  window.sessionStorage.clear();
  approvalsChanged = 0;
  window.addEventListener(APPROVALS_CHANGED_EVENT, onApprovals);
  actionsBody = { actions: [], more: 0, store: "channel_actions" };
  run = { status: "queued", actions: [] };
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/top-actions/runs/")) return run === "down" ? notOk(503) : run === "gone" ? notOk(404) : ok(run);
    if (u.includes("/actions")) return ok(actionsBody);
    return ok({ metrics: [] });
  });
});
afterEach(() => {
  window.removeEventListener(APPROVALS_CHANGED_EVENT, onApprovals);
  cleanup();
  vi.useRealTimers();
});

describe("Write it on Overview: the lane follows the run it started to its end", () => {
  it("shows Zavi writing at once, and the moment the run succeeds the working banner goes, the list is re-read and the panel is told, with no reload", async () => {
    mount();
    await flush();
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    announceChannelRunStarted(SLUG, RUN);
    await flush();
    expect(screen.getByTestId("top-action-writing").textContent).toContain("Cooking up new suggestions for");
    run = { status: "running", actions: [] };
    await flush(15_000);
    expect(screen.getByTestId("top-action-writing")).toBeTruthy();
    expect(approvalsChanged).toBe(0);
    const listBefore = listReads();
    run = { status: "success", actions: [{ id: "a1" }] };
    await flush(5_000);
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(working()).toBe(false);
    expect(screen.queryByTestId("top-action-run-end")).toBeNull();
    expect(listReads()).toBeGreaterThan(listBefore);
    expect(approvalsChanged).toBe(1);
    const settledRuns = runReads();
    const settledList = listReads();
    await flush(120_000);
    expect(runReads()).toBe(settledRuns);
    expect(listReads()).toBe(settledList);
    expect(working()).toBe(false);
  });

  it("a run that ends without filing anything while the panel still says running does not leave the working banner up", async () => {
    mount("idle");
    await flush();
    announceChannelRunStarted(SLUG, RUN);
    await flush();
    expect(working()).toBe(true);
    run = { status: "success", actions: [] };
    await flush(5_000);
    expect(working()).toBe(false);
    expect(approvalsChanged).toBe(1);
  });

  it("the banner's own signal ends the wait at once, without waiting for the next poll", async () => {
    mount();
    await flush();
    announceChannelRunStarted(SLUG, RUN);
    await flush();
    run = { status: "success", actions: [{ id: "a1" }] };
    const before = runReads();
    act(() => {
      window.dispatchEvent(new CustomEvent(ATTENTION_CHANGED_EVENT));
    });
    await flush();
    expect(runReads()).toBe(before + 1);
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(approvalsChanged).toBe(1);
  });

  it("a run that fails and files a miss shows the existing miss banner, not a spinner and not a second sentence", async () => {
    mount();
    await flush();
    announceChannelRunStarted(SLUG, RUN);
    await flush();
    actionsBody = {
      ...actionsBody,
      top_action_miss: { run_id: RUN, key: "new_email", noun: "this email", reason: "The list you picked is gone", at: new Date(Date.now() + 1_000).toISOString() },
    };
    run = { status: "failure", actions: [] };
    await flush(5_000);
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(working()).toBe(false);
    expect(screen.getByTestId("top-action-miss").textContent).toContain("The list you picked is gone.");
    expect(screen.queryByTestId("top-action-run-end")).toBeNull();
  });

  it("a run that fails with no miss on the list says so in a plain sentence instead of spinning", async () => {
    mount();
    await flush();
    announceChannelRunStarted(SLUG, RUN);
    await flush();
    run = { status: "failure", actions: [] };
    await flush(5_000);
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(working()).toBe(false);
    expect(screen.queryByTestId("top-action-miss")).toBeNull();
    expect(screen.getByTestId("top-action-run-end").textContent).toBe("Zavi could not finish this run, so nothing new was added. Try again.");
  });

  it("a run whose status cannot be read keeps the wait, and after the watch window the spinner stops, polling stops and the page says so", async () => {
    mount();
    await flush();
    announceChannelRunStarted(SLUG, RUN);
    await flush();
    run = "down";
    await flush(10 * 60_000);
    expect(screen.getByTestId("top-action-writing")).toBeTruthy();
    run = { status: "running", actions: [] };
    await flush(10 * 60_000 + 20_000);
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(working()).toBe(false);
    expect(screen.getByTestId("top-action-run-end").textContent).toContain("taking longer than usual");
    const runs = runReads();
    const list = listReads();
    await flush(5 * 60_000);
    expect(runReads()).toBe(runs);
    expect(listReads()).toBe(list);
  });

  it("Write it pressed on the Settings tab before Overview mounts: Overview opens on the writing state and clears it when the run ends", async () => {
    announceChannelRunStarted(SLUG, RUN);
    await flush(60_000);
    mount();
    await flush();
    expect(screen.getByTestId("top-action-writing")).toBeTruthy();
    run = { status: "success", actions: [{ id: "a1" }] };
    await flush(5_000);
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(working()).toBe(false);
    expect(approvalsChanged).toBe(1);
  });

  it("a lane unmounted mid-run stops reading the run", async () => {
    const view = mount();
    await flush();
    announceChannelRunStarted(SLUG, RUN);
    await flush();
    view.unmount();
    const runs = runReads();
    await flush(60_000);
    expect(runReads()).toBe(runs);
  });
  it("a run paused for approval is a quiet end: the spinner goes, no failure sentence, and the run is not read again", async () => {
    mount();
    await flush();
    announceChannelRunStarted(SLUG, RUN);
    await flush();
    run = { status: "blocked", actions: [] };
    await flush(5_000);
    expect(screen.getByTestId("top-action-writing")).toBeTruthy();
    expect(screen.queryByTestId("top-action-run-end")).toBeNull();
    run = { status: "paused_awaiting_approval", actions: [] };
    await flush(5_000);
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(working()).toBe(false);
    expect(screen.queryByTestId("top-action-run-end")).toBeNull();
    expect(document.body.textContent).not.toContain("could not finish");
    expect(approvalsChanged).toBe(1);
    const runs = runReads();
    await flush(60_000);
    expect(runReads()).toBe(runs);
  });

  it("a run the server says is gone (404) ends the watch quietly after one read: no spinner, no sentence, no more polling", async () => {
    run = "gone";
    mount();
    await flush();
    announceChannelRunStarted(SLUG, RUN);
    await flush();
    expect(runReads()).toBe(1);
    expect(screen.queryByTestId("top-action-writing")).toBeNull();
    expect(working()).toBe(false);
    expect(screen.queryByTestId("top-action-run-end")).toBeNull();
    const list = listReads();
    await flush(30 * 60_000);
    expect(runReads()).toBe(1);
    expect(listReads()).toBe(list);
    expect(screen.queryByTestId("top-action-run-end")).toBeNull();
  });
});

describe("Cancel on a failed run", () => {
  it("the could-not-finish notice goes on Cancel and stays gone across reads", async () => {
    run = { status: "failed", actions: [] };
    announceChannelRunStarted(SLUG, RUN);
    mount();
    await flush(10);
    await flush(5_000);
    const cancel = screen.getByTestId("top-action-run-end-cancel");
    expect(cancel.textContent).toBe("Cancel");
    act(() => cancel.click());
    expect(screen.queryByTestId("top-action-run-end")).toBeNull();
    await flush(60_000);
    expect(screen.queryByTestId("top-action-run-end")).toBeNull();
  });

  it("the slow-run notice has no Cancel: nothing failed", async () => {
    run = { status: "running", actions: [] };
    mount();
    await flush();
    announceChannelRunStarted(SLUG, RUN);
    await flush();
    run = "down";
    await flush(10 * 60_000);
    run = { status: "running", actions: [] };
    await flush(10 * 60_000 + 20_000);
    expect(screen.getByTestId("top-action-run-end").textContent).toContain("taking longer than usual");
    expect(screen.queryByTestId("top-action-run-end-cancel")).toBeNull();
  });
});
