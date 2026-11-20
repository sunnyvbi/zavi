// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { announceChannelRunStarted } from "./topActions/api";
import { makeAction } from "./__tests__/fixtures";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("../WorkspaceShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../WorkspaceShell")>()),
  useWorkspaceOptional: () => ({ role: "owner", tabs: [], activeTabId: null }),
}));

const RUN = "5b0c1e2a-0000-4000-8000-000000000002";
const SLUG = "email_marketing";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const notOk = (status: number) => ({ ok: false, status, json: async () => ({ error: { message: "nope" } }) });
let actionsBody: Record<string, unknown> = {};
let runAnswers: Array<number | { status: string; actions: unknown[] }> = [];
const urls = () => apiFetch.mock.calls.map((c) => String(c[0]));
const listReads = () => urls().filter((u) => u.includes(`/api/channels/${SLUG}/actions`)).length;
const writing = () => screen.queryByTestId("top-action-writing") !== null;

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const staged = (ids: string[]) => ({
  ids,
  render: (shown: readonly string[]) => shown.map((id) => <li key={id} data-testid={`action-${id}`}>staged</li>),
});

function lane(chatIds: string[] = []) {
  return (
    <ChannelActionsLane slug={SLUG} legacy={<p>LEGACY RAIL</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors chatStaged={staged(chatIds)}>
      <li>an approvals row</li>
    </ChannelActionsLane>
  );
}

let hour = 0;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 28, 10) + hour++ * 3_600_000));
  apiFetch.mockReset();
  window.sessionStorage.clear();
  actionsBody = { actions: [], more: 0, store: "channel_actions", completed: [] };
  runAnswers = [];
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/top-actions/runs/")) {
      const next = runAnswers.length > 1 ? runAnswers.shift()! : runAnswers[0] ?? { status: "running", actions: [] };
      return typeof next === "number" ? notOk(next) : ok(next);
    }
    if (u.includes("/actions")) return ok(actionsBody);
    return ok({ metrics: [] });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a run read that is refused for a passing reason", () => {
  it("keeps the writing banner through a 429 and a 401, then says the run failed", async () => {
    render(lane());
    await flush();
    runAnswers = [429, 401, { status: "running", actions: [] }];
    announceChannelRunStarted(SLUG, RUN);
    await flush();
    expect(writing()).toBe(true);
    await flush(5_000);
    expect(writing()).toBe(true);
    await flush(5_000);
    expect(writing()).toBe(true);
    runAnswers = [{ status: "failed", actions: [] }];
    await flush(10_000);
    expect(writing()).toBe(false);
    expect(screen.getByTestId("top-action-run-end").textContent).toContain("Zavi could not finish this run");
  });

  it.each([403, 404, 410])("ends the wait quietly when the run read answers %i", async (status) => {
    render(lane());
    await flush();
    runAnswers = [status];
    announceChannelRunStarted(SLUG, RUN);
    await flush(10_000);
    expect(writing()).toBe(false);
    expect(screen.queryByTestId("top-action-run-end")).toBeNull();
  });
});

describe("a run started with no run id yet", () => {
  it("keeps watching through cards that are not this run's, and stops on a new card waiting on this channel", async () => {
    const old = makeAction("email" as never, { id: "old-pending", channel_slug: SLUG, status: "pending", proposed_at: "2026-10-20T00:00:00Z" });
    actionsBody = { ...actionsBody, actions: [old] };
    render(lane());
    await flush();
    announceChannelRunStarted(SLUG);
    await flush();
    await flush(20_000);

    actionsBody = {
      ...actionsBody,
      actions: [old, makeAction("email" as never, { id: "snoozed-new", channel_slug: SLUG, status: "snoozed" })],
      completed: [makeAction("email" as never, { id: "auto-done", channel_slug: SLUG, status: "acted", exec_status: "executed" })],
    };
    await flush(20_000);
    await flush(20_000);
    const stillWatching = listReads();
    await flush(40_000);
    expect(listReads()).toBeGreaterThan(stillWatching);

    actionsBody = {
      ...actionsBody,
      actions: [old, makeAction("email" as never, { id: "from-this-run", channel_slug: SLUG, status: "pending" })],
    };
    await flush(40_000);
    const settled = listReads();
    await flush(120_000);
    expect(listReads()).toBe(settled);
  });

  it("stops on a new email card the run filed into this channel's approvals rows", async () => {
    const view = render(lane());
    await flush();
    announceChannelRunStarted(SLUG);
    await flush();
    await flush(20_000);
    const watching = listReads();
    await flush(40_000);
    expect(listReads()).toBeGreaterThan(watching);
    view.rerender(lane(["email-from-run"]));
    await flush(20_000);
    const settled = listReads();
    await flush(120_000);
    expect(listReads()).toBe(settled);
  });

  it("goes quiet when the twenty minute watch ends with no run to watch, without saying it is slow", async () => {
    render(lane());
    await flush();
    announceChannelRunStarted(SLUG);
    await flush();
    const before = listReads();
    await flush(40_000);
    expect(listReads()).toBeGreaterThan(before);
    await flush(20 * 60_000 + 25_000);
    const settled = listReads();
    await flush(120_000);
    expect(listReads()).toBe(settled);
    expect(screen.queryByTestId("top-action-run-end")).toBeNull();
  });
});
