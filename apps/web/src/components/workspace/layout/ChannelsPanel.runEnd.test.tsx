// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { APPROVALS_CHANGED_EVENT } from "../actions/topActions/api";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn() }),
  useWorkspaceOptional: () => null,
}));
vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: vi.fn(async () => ({ ok: true })),
}));

const SLUG = "linkedin_ads";
const RUN = "587c6f74-0000-4000-8000-000000000001";

type Row = { work_state: "idle" | "running" | "needs_review" | "delivered"; last_run_at: string | null };

const h = vi.hoisted(() => ({
  row: { work_state: "delivered", last_run_at: null } as Row,
  runStatus: "running",
  slow: false,
  held: [] as Array<() => void>,
  panelReads: 0,
  next: [] as Array<"slow" | "fail" | "hang">,
}));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

function route() {
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u === `/api/channels/${SLUG}/run` && init?.method === "POST") return ok({ run_id: RUN });
    if (u.includes(`/top-actions/runs/`)) return ok({ status: h.runStatus, actions: [], summary: null });
    if (u === "/api/channels") {
      h.panelReads += 1;
      const snapshot = { ...h.row };
      const mode = h.next.shift();
      if (mode === "hang") await new Promise<void>(() => undefined);
      if (mode === "fail") return { ok: false, status: 500, json: async () => ({}) };
      if (h.slow || mode === "slow") await new Promise<void>((resolve) => h.held.push(resolve));
      return ok({
        channels: [
          {
            channel_slug: SLUG,
            delivery_mode: "advise",
            work_state: snapshot.work_state,
            priority: 1,
            last_run_at: snapshot.last_run_at,
            connected: true,
            connectors: ["linkedin_ads"],
            linked_connectors: ["linkedin_ads"],
            runnable: true,
            run_reserve_credits: 160,
          },
        ],
        tenant_tier: "pro",
        has_strategy: true,
      });
    }
    if (u.startsWith("/api/approvals")) return ok({ decisions: [], channel_pending_counts: {}, run_not_done_counts: {} });
    if (u.includes(`/api/channels/${SLUG}/actions`)) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.startsWith("/api/ads/campaigns?")) return ok({ campaigns: [] });
    if (u === "/api/ads/wallet")
      return ok({
        balance_cents: 0,
        reserved_cents: 0,
        available_cents: 0,
        auto_refill_enabled: false,
        refill_cents: 0,
        threshold_cents: 0,
        pending: false,
        funding_enabled: true,
        last_error: null,
      });
    if (u === "/api/ads/wallet/reservations") return ok({ reservations: [] });
    if (u === "/api/ads/wallet/consent") return ok({ version: "v1", text: "Consent", accepted: false });
    if (u.startsWith("/api/ads/accounts/")) return ok({ accounts: [], managed: [], selected_id: null });
    return ok({});
  });
}

import { BOARD_EVENT_COALESCE_MS, ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const row = () => document.querySelector(`[data-channel-slug="${SLUG}"]`) as HTMLElement | null;
const rowStatus = () => row()?.querySelector("[data-row-status]")?.textContent ?? null;
const working = () => screen.queryAllByText(/Cooking up new suggestions for LinkedIn Ads/).length > 0;
const runButton = () => screen.queryByTestId("run-channel") as HTMLButtonElement | null;

function refocus() {
  document.dispatchEvent(new Event("visibilitychange"));
}

async function releaseHeld() {
  await act(async () => {
    const all = h.held.splice(0);
    all.forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function openLinkedIn() {
  const view = render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
  await tick(0);
  await tick(0);
  expect(row()).toBeTruthy();
  await act(async () => {
    fireEvent.click(row()!);
    await vi.advanceTimersByTimeAsync(0);
  });
  await tick(0);
  const details = screen.getAllByRole("button", { name: "Details" });
  expect(details).toHaveLength(1);
  await act(async () => {
    fireEvent.click(details[0]);
    await vi.advanceTimersByTimeAsync(0);
  });
  await tick(0);
  await tick(0);
  expect(screen.getByRole("dialog", { name: "LinkedIn Ads" })).toBeTruthy();
  return view;
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date("2026-10-28T09:00:00Z"));
  clearChannelBoardCache();
  window.localStorage.clear();
  window.sessionStorage.clear();
  apiFetch.mockReset();
  h.row = { work_state: "delivered", last_run_at: "2026-10-27T08:00:00Z" };
  h.runStatus = "running";
  h.slow = false;
  h.held = [];
  h.panelReads = 0;
  h.next = [];
  route();
});
afterEach(async () => {
  h.held.splice(0).forEach((r) => r());
  cleanup();
  vi.useRealTimers();
});

describe("LinkedIn Ads drawer after Run it again", () => {
  it("leaves the working state without a reload when an older board read lands after the run ended", async () => {
    const view = await openLinkedIn();
    expect(working()).toBe(false);
    expect(runButton()?.textContent).toBe("Get suggestions");

    await act(async () => {
      runButton()!.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    h.row = { work_state: "running", last_run_at: "2026-10-28T09:00:01Z" };
    await act(async () => {
      refocus();
      await vi.advanceTimersByTimeAsync(0);
    });
    await tick(0);
    expect(working()).toBe(true);
    expect(screen.queryByTestId("empty-running")).not.toBeNull();
    expect(rowStatus()).toBe("Working on it");

    await tick(2 * 60_000);
    expect(working()).toBe(true);

    h.slow = true;
    await act(async () => {
      refocus();
      await vi.advanceTimersByTimeAsync(0);
    });
    h.slow = false;
    expect(h.held.length).toBeGreaterThan(0);

    h.runStatus = "success";
    h.row = { work_state: "delivered", last_run_at: "2026-10-28T09:02:30Z" };
    const readsBefore = h.panelReads;
    await tick(6_000);
    expect(h.panelReads).toBeGreaterThan(readsBefore);
    expect(rowStatus()).toBe("Done");

    await releaseHeld();
    await tick(0);

    expect(working()).toBe(false);
    expect(runButton()?.textContent).toBe("Get suggestions");
    expect(runButton()?.disabled).toBe(false);
    expect(rowStatus()).toBe("Done");
    expect(view.container.isConnected).toBe(true);

    await tick(3 * 60_000);
    expect(working()).toBe(false);
    expect(runButton()?.textContent).toBe("Get suggestions");
  });

  it("a drawer opened mid-run leaves the working state when the run's own board refresh beats an older read", async () => {
    h.row = { work_state: "running", last_run_at: "2026-10-28T08:59:00Z" };
    await openLinkedIn();
    expect(working()).toBe(true);
    expect(screen.queryByTestId("empty-running")).not.toBeNull();

    h.slow = true;
    await act(async () => {
      refocus();
      await vi.advanceTimersByTimeAsync(0);
    });
    h.slow = false;

    h.row = { work_state: "delivered", last_run_at: "2026-10-28T09:01:00Z" };
    await act(async () => {
      window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
      await vi.advanceTimersByTimeAsync(BOARD_EVENT_COALESCE_MS);
    });
    await tick(0);
    expect(working()).toBe(false);

    await releaseHeld();
    await tick(0);
    expect(working()).toBe(false);
    expect(runButton()?.textContent).toBe("Get suggestions");
    expect(rowStatus()).toBe("Done");
  });

  it("an older read that saw the run end still applies when the newest read fails", async () => {
    h.row = { work_state: "running", last_run_at: "2026-10-28T08:59:00Z" };
    await openLinkedIn();
    expect(working()).toBe(true);

    h.row = { work_state: "delivered", last_run_at: "2026-10-28T09:01:00Z" };
    h.next = ["slow", "fail"];
    await act(async () => {
      refocus();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.held.length).toBe(1);
    await act(async () => {
      window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
      await vi.advanceTimersByTimeAsync(BOARD_EVENT_COALESCE_MS);
    });
    await tick(0);
    expect(working()).toBe(true);

    await releaseHeld();
    await tick(0);
    expect(working()).toBe(false);
    expect(runButton()?.textContent).toBe("Get suggestions");
    expect(rowStatus()).toBe("Done");
  });

  it("the board still loads on first open when a newer read hangs", async () => {
    h.next = ["slow", "hang"];
    render(<ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />);
    await tick(0);
    expect(h.held.length).toBe(1);
    await act(async () => {
      refocus();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.panelReads).toBe(2);
    expect(rowStatus()).toBeNull();

    await releaseHeld();
    await tick(0);
    expect(row()).toBeTruthy();
    expect(rowStatus()).toBe("Done");
  });
});
