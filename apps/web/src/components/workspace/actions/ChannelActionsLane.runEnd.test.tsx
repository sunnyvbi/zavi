// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { APPROVALS_CHANGED_EVENT, announceChannelRunStarted } from "./topActions/api";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const SLUG = "linkedin_ads";
const RUN_A = "run-aaaaaaaa-1111";
const RUN_B = "run-bbbbbbbb-2222";
const OLD_RUN = "run-oldoldold-0000";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

type StatusAnswer = { status: string } | Promise<{ status: string }>;
let statusFor: Record<string, () => StatusAnswer>;
let postRunId: string | undefined;

function route() {
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u.includes(`/api/channels/${SLUG}/run`) && init?.method === "POST") {
      return ok(postRunId ? { run_id: postRunId } : {});
    }
    const m = u.match(/\/top-actions\/runs\/([^/?]+)/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const answer = await (statusFor[id]?.() ?? { status: "running" });
      return ok({ ...answer, actions: [], summary: null });
    }
    if (u.includes(`/api/channels/${SLUG}/actions`)) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    return ok({});
  });
}

const statusReads = (id: string) =>
  apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(`/top-actions/runs/${id}`));

function mount() {
  return render(
    <ChannelActionsLane
      slug={SLUG}
      legacy={<p>LEGACY RAIL</p>}
      workState="delivered"
      lastRunAt="2026-10-28T08:00:00Z"
      actionCount={0}
      connected
      hasConnectors
    >
      <li>an approvals row</li>
    </ChannelActionsLane>,
  );
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function pressRun() {
  const button = screen.getByTestId("run-channel");
  await act(async () => {
    button.click();
    await vi.advanceTimersByTimeAsync(0);
  });
}

const working = () => screen.queryAllByText(/Cooking up new suggestions for/).length > 0;
const runButtonText = () => (screen.queryByTestId("empty-running") ? "Running…" : screen.getByTestId("run-channel").textContent);

let approvalsChanged = 0;
const onApprovalsChanged = () => {
  approvalsChanged += 1;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T09:00:00Z"));
  window.localStorage.clear();
  apiFetch.mockReset();
  statusFor = {};
  postRunId = RUN_A;
  approvalsChanged = 0;
  window.addEventListener(APPROVALS_CHANGED_EVENT, onApprovalsChanged);
  route();
});
afterEach(() => {
  window.removeEventListener(APPROVALS_CHANGED_EVENT, onApprovalsChanged);
  cleanup();
  vi.useRealTimers();
});

describe("Run it again, on a drawer that is already open", () => {
  it("leaves the running state within seconds of the run finishing, with no remount", async () => {
    let done = false;
    statusFor[RUN_A] = () => ({ status: done ? "success" : "running" });
    const view = mount();
    await tick(0);
    await pressRun();

    expect(working()).toBe(true);
    expect(runButtonText()).toBe("Running…");

    await tick(3 * 60_000);
    expect(working()).toBe(true);
    expect(runButtonText()).toBe("Running…");
    expect(statusReads(RUN_A).length).toBeGreaterThan(10);
    expect(approvalsChanged).toBe(0);

    done = true;
    await tick(6_000);

    expect(working()).toBe(false);
    expect(runButtonText()).not.toBe("Running…");
    expect((screen.getByTestId("run-channel") as HTMLButtonElement).disabled).toBe(false);
    expect(approvalsChanged).toBe(1);
    expect(view.container.isConnected).toBe(true);

    const readsAtEnd = statusReads(RUN_A).length;
    await tick(5 * 60_000);
    expect(statusReads(RUN_A).length).toBe(readsAtEnd);
    expect(approvalsChanged).toBe(1);
  });

  it("lets the founder press Run again after a fast run ends, as a new press with a new request id", async () => {
    statusFor[RUN_A] = () => ({ status: "success" });
    mount();
    await tick(0);
    await pressRun();
    await tick(6_000);
    expect(working()).toBe(false);

    postRunId = RUN_B;
    statusFor[RUN_B] = () => ({ status: "running" });
    await pressRun();
    expect(working()).toBe(true);

    const posts = apiFetch.mock.calls.filter(
      (c) => String(c[0]).includes(`/api/channels/${SLUG}/run`) && (c[1] as { method?: string })?.method === "POST",
    );
    expect(posts).toHaveLength(2);
    const ids = posts.map((c) => JSON.parse(String((c[1] as { body: string }).body)).request_id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  const runPosts = () =>
    apiFetch.mock.calls.filter(
      (c) => String(c[0]).includes(`/api/channels/${SLUG}/run`) && (c[1] as { method?: string })?.method === "POST",
    );
  const requestIds = () => runPosts().map((c) => JSON.parse(String((c[1] as { body: string }).body)).request_id);

  it("does not let a second paid run start when the watch only expired while the run is still going", async () => {
    statusFor[RUN_A] = () => ({ status: "running" });
    mount();
    await tick(0);
    await pressRun();
    expect(runPosts()).toHaveLength(1);

    await tick(21 * 60_000);
    expect(working()).toBe(false);

    await pressRun();
    const ids = requestIds();
    expect(ids.length === 1 || ids.every((id) => id === ids[0])).toBe(true);
  });

  it("does not let a second paid run start when a top-action miss ends the watch while the run is still going", async () => {
    statusFor[RUN_A] = () => ({ status: "running" });
    let missed: { run_id: string; at: string } | null = null;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      if (u.includes(`/api/channels/${SLUG}/run`) && init?.method === "POST") return ok({ run_id: RUN_A });
      if (u.includes("/top-actions/runs/")) return ok({ status: "running", actions: [], summary: null });
      if (u.includes(`/api/channels/${SLUG}/actions`)) {
        return ok({ actions: [], more: 0, store: "channel_actions", ...(missed ? { top_action_miss: missed } : {}) });
      }
      if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
      return ok({});
    });
    mount();
    await tick(0);
    await pressRun();
    missed = { run_id: "run-miss-0001", at: new Date(Date.now() + 1_000).toISOString() };
    await tick(20_000);
    expect(working()).toBe(false);

    await pressRun();
    const ids = requestIds();
    expect(ids.length === 1 || ids.every((id) => id === ids[0])).toBe(true);
  });

  it.each(["failed", "cancelled"])("also leaves the running state when the run ends %s", async (status) => {
    statusFor[RUN_A] = () => ({ status });
    mount();
    await tick(0);
    await pressRun();
    expect(working()).toBe(true);
    await tick(6_000);
    expect(working()).toBe(false);
  });

  it("keeps waiting through a status read that fails, then leaves on the next good one", async () => {
    let calls = 0;
    statusFor[RUN_A] = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("network"));
      return { status: "success" };
    };
    mount();
    await tick(0);
    await pressRun();
    await tick(5_000);
    expect(working()).toBe(true);
    await tick(5_000);
    expect(working()).toBe(false);
  });

  it("does not end the watch on a stale pin from an earlier press when the POST named no run", async () => {
    window.localStorage.setItem(
      `zavi.channel-run-id.${SLUG}`,
      JSON.stringify({ id: OLD_RUN, at: Date.now() - 10 * 60_000 }),
    );
    statusFor[OLD_RUN] = () => ({ status: "success" });
    postRunId = undefined;
    mount();
    await tick(0);
    await pressRun();
    await tick(60_000);
    expect(working()).toBe(true);
    expect(runButtonText()).toBe("Running…");
    expect(approvalsChanged).toBe(0);
  });

  it("ignores a late 'finished' for the previous run when a new run started while that read was on the wire", async () => {
    let releaseA: (v: { status: string }) => void = () => {};
    statusFor[RUN_A] = () =>
      new Promise((resolve) => {
        releaseA = resolve;
      });
    let bDone = false;
    statusFor[RUN_B] = () => ({ status: bDone ? "success" : "running" });
    mount();
    await tick(0);
    await pressRun();

    await tick(5_000);
    expect(statusReads(RUN_A)).toHaveLength(1);

    await act(async () => {
      window.localStorage.setItem(`zavi.channel-run-id.${SLUG}`, JSON.stringify({ id: RUN_B, at: Date.now() }));
      announceChannelRunStarted(SLUG);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      releaseA({ status: "success" });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(working()).toBe(true);
    expect(approvalsChanged).toBe(0);

    await tick(30_000);
    expect(working()).toBe(true);
    expect(statusReads(RUN_B).length).toBeGreaterThan(0);

    bDone = true;
    await tick(6_000);
    expect(working()).toBe(false);
    expect(approvalsChanged).toBe(1);
  });
});

describe("a board read that still says running after this drawer saw the run end", () => {
  function lane(workState: "running" | "delivered", lastRunAt: string) {
    return (
      <ChannelActionsLane
        slug={SLUG}
        legacy={<p>LEGACY RAIL</p>}
        workState={workState}
        lastRunAt={lastRunAt}
        actionCount={0}
        connected
        hasConnectors
      >
        <li>an approvals row</li>
      </ChannelActionsLane>
    );
  }

  it("ignores the stale running read, and still trusts a later run", async () => {
    let done = false;
    statusFor[RUN_A] = () => ({ status: done ? "success" : "running" });
    const view = render(lane("delivered", "2026-10-28T08:00:00Z"));
    await tick(0);
    await pressRun();
    view.rerender(lane("running", "2026-10-28T09:00:01Z"));
    await tick(2 * 60_000);
    expect(working()).toBe(true);

    done = true;
    await tick(6_000);
    view.rerender(lane("running", "2026-10-28T09:00:01Z"));
    await tick(0);

    expect(working()).toBe(false);
    expect(runButtonText()).toBe("Get suggestions");
    expect((screen.getByTestId("run-channel") as HTMLButtonElement).disabled).toBe(false);

    await tick(60_000);
    expect(working()).toBe(false);

    view.rerender(lane("running", "2026-10-28T09:04:00Z"));
    await tick(0);
    expect(working()).toBe(true);
    expect(runButtonText()).toBe("Running…");
  });

  it("still shows a later run started elsewhere when the browser clock runs ahead of the server", async () => {
    vi.setSystemTime(new Date("2026-10-28T09:10:00Z"));
    let done = false;
    statusFor[RUN_A] = () => ({ status: done ? "success" : "running" });
    const view = render(lane("delivered", "2026-10-28T08:00:00Z"));
    await tick(0);
    await pressRun();
    view.rerender(lane("running", "2026-10-28T09:00:01Z"));
    await tick(60_000);
    expect(working()).toBe(true);

    done = true;
    await tick(6_000);
    view.rerender(lane("delivered", "2026-10-28T09:01:30Z"));
    await tick(0);
    expect(working()).toBe(false);

    view.rerender(lane("running", "2026-10-28T09:00:01Z"));
    await tick(0);
    expect(working()).toBe(false);
    expect(runButtonText()).toBe("Get suggestions");

    view.rerender(lane("running", "2026-10-28T09:03:00Z"));
    await tick(0);
    expect(working()).toBe(true);
    expect(runButtonText()).toBe("Running…");

    await tick(25 * 60_000);
    expect(working()).toBe(true);
    expect(runButtonText()).toBe("Running…");
  });

  it("still shows a later run started elsewhere after the run watch has lapsed", async () => {
    statusFor[RUN_A] = () => ({ status: "success" });
    const view = render(lane("delivered", "2026-10-28T08:00:00Z"));
    await tick(0);
    await pressRun();
    view.rerender(lane("running", "2026-10-28T09:00:01Z"));
    await tick(6_000);
    view.rerender(lane("running", "2026-10-28T09:00:01Z"));
    await tick(0);
    expect(working()).toBe(false);

    await tick(25 * 60_000);
    view.rerender(lane("running", "2026-10-28T09:20:00Z"));
    await tick(0);
    expect(working()).toBe(true);
    expect(runButtonText()).toBe("Running…");
  });
});
