// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { announceChannelRunStarted } from "./topActions/api";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("../WorkspaceShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../WorkspaceShell")>()),
  useWorkspaceOptional: () => ({ role: "owner", tabs: [], activeTabId: null }),
}));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
let body: Record<string, unknown> = {};
const reads = (slug: string) => apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(`/api/channels/${slug}/actions`)).length;

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(slug: string) {
  return render(
    <ChannelActionsLane slug={slug} legacy={<p>LEGACY RAIL</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>
      <li>an approvals row</li>
    </ChannelActionsLane>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
  window.sessionStorage.clear();
  body = { actions: [], more: 0, store: "channel_actions" };
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/actions")) return ok(body);
    return ok({ metrics: [] });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a run started from the Settings tab, before Overview's lane mounts", () => {
  it("Overview opened afterwards keeps reading until the run's outcome shows, without a reload", async () => {
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
    announceChannelRunStarted("email_marketing");
    await flush(3 * 60_000);
    mount("email_marketing");
    await flush();
    expect(screen.queryByTestId("top-action-miss")).toBeNull();
    const first = reads("email_marketing");
    body = {
      ...body,
      top_action_miss: { run_id: "1caaac04-0000-4000-8000-000000000000", key: "new_email", noun: "this email", reason: "The list you picked is gone. Pick another list and try again.", at: "2026-10-28T10:03:30Z" },
    };
    await flush(20_000);
    expect(reads("email_marketing")).toBeGreaterThan(first);
    expect(screen.getByTestId("top-action-miss").textContent).toContain("The list you picked is gone.");
    const settled = reads("email_marketing");
    await flush(120_000);
    expect(reads("email_marketing")).toBe(settled);
  });

  it("a start older than the watch window, or on another channel, does not set the lane polling", async () => {
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    announceChannelRunStarted("meta_ads");
    announceChannelRunStarted("email_marketing");
    await flush(21 * 60_000);
    mount("email_marketing");
    await flush();
    const before = reads("email_marketing");
    await flush(120_000);
    expect(reads("email_marketing")).toBe(before);
    cleanup();
    announceChannelRunStarted("meta_ads");
    mount("email_marketing");
    await flush();
    const quiet = reads("email_marketing");
    await flush(120_000);
    expect(reads("email_marketing")).toBe(quiet);
  });
});
