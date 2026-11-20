// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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
  dashError: null as string | null,
  dashReads: 0,
}));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

function route() {
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u === `/api/channels/${SLUG}/run` && init?.method === "POST") return ok({ run_id: RUN });
    if (u.startsWith(`/api/agents/${SLUG}/dashboard`)) {
      h.dashReads += 1;
      return ok({
        platform: "linkedin_ads",
        connected: true,
        error_code: h.dashError,
        window_days: 30,
        account: { name: "Acme", account_count: 1, campaign_count: 0, active_count: 0, currency: "USD" },
        totals: null,
        campaigns: [],
      });
    }
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

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const row = () => document.querySelector(`[data-channel-slug="${SLUG}"]`) as HTMLElement | null;
const working = () => screen.queryAllByText(/Cooking up new suggestions for LinkedIn Ads/).length > 0;
const runButton = () => screen.queryByTestId("run-channel") as HTMLButtonElement | null;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const stallNote = () => screen.queryByTestId("top-action-run-end");
const reconnect = () => screen.queryByRole("button", { name: "Reconnect LinkedIn Ads" });

async function pressRun() {
  await act(async () => {
    runButton()!.click();
    await vi.advanceTimersByTimeAsync(0);
  });
  await tick(0);
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
  h.dashError = null;
  h.dashReads = 0;
  route();
});
afterEach(async () => {
  h.held.splice(0).forEach((r) => r());
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("LinkedIn Ads run that never finishes", () => {
  it("says the run stalled and shows Reconnect without a reload when the token is revoked mid-run", async () => {
    await openLinkedIn();
    expect(reconnect()).toBeNull();
    expect(runButton()?.textContent).toBe("Get suggestions");

    await pressRun();
    expect(working()).toBe(true);
    expect(stallNote()).toBeNull();

    setVisibility("hidden");
    await tick(2 * 60_000);
    h.row = { work_state: "running", last_run_at: "2026-10-28T09:00:01Z" };
    setVisibility("visible");
    await tick(0);
    await tick(0);
    expect(working()).toBe(true);
    expect(screen.queryByTestId("empty-running")).not.toBeNull();

    h.dashError = "linkedin_ads_token_revoked";
    const dashBefore = h.dashReads;

    await tick(7 * 60_000);
    expect(working()).toBe(true);
    expect(stallNote()).toBeNull();
    expect(reconnect()).toBeNull();
    expect(h.dashReads).toBe(dashBefore);

    await tick(60_000 + 10_000);
    expect(stallNote()?.textContent).toMatch(/may have stopped, or it is taking longer than usual/);
    expect(h.dashReads).toBeGreaterThan(dashBefore);
    expect(reconnect()).toBeTruthy();
    expect(screen.getByTestId("channel-read-problem").textContent).toMatch(/stopped accepting Zavi's access/);
    expect(screen.queryByTestId("empty-running")).not.toBeNull();

    const readsAfterStall = h.dashReads;
    await tick(5 * 60_000);
    expect(h.dashReads).toBe(readsAfterStall);
    expect(stallNote()).toBeTruthy();
  });

  it("re-reads the dashboard when the pinned run ends failed, so Reconnect shows without a reload", async () => {
    await openLinkedIn();
    await pressRun();
    expect(working()).toBe(true);

    await tick(60_000);
    expect(reconnect()).toBeNull();
    h.dashError = "linkedin_ads_token_revoked";
    h.runStatus = "failed";
    h.row = { work_state: "needs_review", last_run_at: "2026-10-28T09:00:01Z" };
    await tick(6_000);
    await tick(0);
    expect(reconnect()).toBeTruthy();
    expect(stallNote()).toBeNull();
  });

  it("a plain Run press still unanswered when the twenty minute watch ends says so instead of going quiet", async () => {
    await openLinkedIn();
    await pressRun();
    window.localStorage.removeItem(`zavi.channel-run-id.${SLUG}`);
    await tick(20 * 60_000 + 25_000);
    expect(stallNote()?.textContent).toMatch(/may have stopped, or it is taking longer than usual/);
  });
});
