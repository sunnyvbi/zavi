// @vitest-environment jsdom

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

const openTab = vi.fn();
const seedComposer = vi.fn();
const refresh = vi.fn();

vi.mock("@/components/workspace/WorkspaceShell", () => ({
  useWorkspace: () => ({ openTab, seedComposer }),
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const PAYLOAD = {
  generic: false,
  kpis: { in_flight: 13, shipped_measured: 3, won: 1, recurred: 1 },
  standup: {
    judgment: {
      candidates_found: 3,
      dispatched_count: 0,
      skipped: [
        {
          theme: "Development/main branch drift blocks all engineer PRs",
          why: "Not in this run's top-3 dispatch batch · urgency: this-week",
        },
      ],
    },
    summary_bullets: ["a", "b"],
    loop_closed: [{ theme: "Pricing CTA", outcome: "won" }],
    needs_you_count: 3,
    moving_clean_count: 3,
  },
  rows: [
    {
      id: "row-stuck",
      theme: "Slack multi-turn reply drops the second message",
      status: "in_flight",
      outcome: null,
      child_run_id: "run-stuck-0001",
      child_status: "running",
      updated_at: "2026-06-25T10:00:00.000Z",
      dispatch_stage: "pr_open",
      pr_url: "https://github.com/rravi149/apna-tutor/pull/482",
      pr_state: "open",
      days_stuck: 9,
      decision_id: "dec-stuck-01",
    },
    {
      id: "row-failed",
      theme: "Onboarding /start parses OAuth token list as one bearer",
      status: "in_flight",
      outcome: null,
      child_run_id: "run-failed-0002",
      child_status: "completed",
      updated_at: "2026-06-28T12:00:00.000Z",
      dispatch_stage: "failed_to_open",
      pr_url: null,
      pr_state: null,
      days_stuck: null,
      decision_id: null,
    },
    {
      id: "row-recurred",
      theme: "Grounding banner shows false provenance",
      status: "shipped",
      outcome: "recurred",
      child_run_id: "run-recur-0003",
      child_status: "completed",
      updated_at: "2026-06-20T09:00:00.000Z",
      dispatch_stage: "merged",
      pr_url: "https://github.com/rravi149/praxis/pull/1258",
      pr_state: "merged",
      days_stuck: null,
      decision_id: null,
    },
    {
      id: "row-engdone",
      theme: "Credit wallet low-balance banner refetch",
      status: "in_flight",
      outcome: null,
      child_run_id: "run-eng-0004",
      child_status: "completed",
      updated_at: "2026-06-29T08:00:00.000Z",
      dispatch_stage: "engineer_done",
      pr_url: null,
      pr_state: null,
      days_stuck: null,
      decision_id: null,
    },
    {
      id: "row-healthy-1",
      theme: "Model router shadow eval canary",
      status: "in_flight",
      outcome: null,
      child_run_id: "run-hlth-0005",
      child_status: "running",
      updated_at: "2026-06-30T08:00:00.000Z",
      dispatch_stage: "dispatched",
      pr_url: null,
      pr_state: null,
      days_stuck: null,
      decision_id: null,
    },
    {
      id: "row-healthy-2",
      theme: "Memory recall reranker tuning",
      status: "in_flight",
      outcome: null,
      child_run_id: "run-hlth-0006",
      child_status: "running",
      updated_at: "2026-06-30T09:30:00.000Z",
      dispatch_stage: "pr_open",
      pr_url: "https://github.com/rravi149/praxis/pull/1390",
      pr_state: "open",
      days_stuck: null,
      decision_id: null,
    },
  ],
};

let activePayload: any = PAYLOAD;

vi.mock("./dashboard-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-ui")>();
  return {
    ...actual,
    useAgentDashboard: () => ({
      data: activePayload,
      loading: false,
      refreshing: false,
      error: null,
      refresh,
      newRowIds: new Set<string>(),
    }),
  };
});

import { PmHybridDashboard } from "./PmHybridDashboard";

describe("PmHybridDashboard — Hybrid surface renders on a realistic payload", () => {
  let container: HTMLElement;

  beforeAll(() => {
    const view = render(<PmHybridDashboard />);
    container = view.container;
  });

  it("renders the morning-standup judgment (candidates found + dispatched)", () => {
    expect(container.textContent).toContain("candidate fix");
    expect(container.textContent).toContain("dispatched");
    expect(container.textContent).toContain("3");
    expect(screen.getByText(/Pricing CTA/)).toBeTruthy();
  });

  it("surfaces at least one 'Needs you' exception item", () => {
    expect(screen.getByText(/Needs you \(3\)/)).toBeTruthy();
    expect(
      screen.getAllByText(/Slack multi-turn reply drops the second message/)
        .length,
    ).toBeGreaterThan(0);
    expect(container.textContent).toContain("came back");
  });

  it("shows a stuck signal (days-stuck) for the aged PR", () => {
    expect(container.textContent).toContain("9d");
    expect((container.textContent ?? "").toLowerCase()).toContain("stuck");
  });

  it("renders only honest action buttons (Open PR / Open engineer run / Ask engineer)", () => {
    expect(screen.getAllByText("Open PR").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Open engineer run/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Ask engineer for status/).length).toBeGreaterThan(
      0,
    );
  });

  it("shows NO fabricated action buttons (Re-dispatch / Mark won / Nudge / Park)", () => {
    expect(screen.queryByText(/Re-dispatch/i)).toBeNull();
    expect(screen.queryByText(/Mark won/i)).toBeNull();
    expect(screen.queryByText(/Nudge/i)).toBeNull();
    expect(screen.queryByText(/\bPark\b/i)).toBeNull();
  });

  it("expands 'Receipts & roadmap' to reveal dispatch-stage badges + a stuck chip", () => {
    const toggle = screen.getByRole("button", { name: /Receipts & roadmap/i });
    fireEvent.click(toggle);
    expect(screen.getAllByText(/PR open/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/stuck 9d/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Recurred/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Re-dispatch/i)).toBeNull();
  });
  afterAll(() => cleanup());
});

describe("PmHybridDashboard — 'Needs you' Approve / Not-now decision buttons", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    refresh.mockReset();
    apiFetch.mockResolvedValue({ ok: true });
  });
  afterEach(() => cleanup());

  it("renders Approve + Not-now ONLY for the row that has an open decision_id", () => {
    render(<PmHybridDashboard />);
    expect(screen.getAllByRole("button", { name: /^Approve$/ }).length).toBe(1);
    expect(screen.getAllByRole("button", { name: /^Not now$/ }).length).toBe(1);
    expect(
      screen.getAllByText(/No approval to make yet/).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("Approve is TWO-STEP: first click shows an inline confirm naming the PR and does NOT call apiFetch", () => {
    render(<PmHybridDashboard />);
    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(screen.getByRole("button", { name: /Confirm approve/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cancel$/ })).toBeTruthy();
    expect(screen.getByText(/re-dispatches the engineer/)).toBeTruthy();
    expect(screen.getByText(/closes PR #482/)).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("Confirm approve POSTs to /api/approvals/:id/approve, collapses to resolved, and refetches", async () => {
    render(<PmHybridDashboard />);
    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm approve/ }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith("/api/approvals/dec-stuck-01/approve", {
      method: "POST",
    });
    await screen.findByText(/Approved. Re-dispatching the engineer and closing the PR/);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("Cancel backs out of the confirm without calling apiFetch", () => {
    render(<PmHybridDashboard />);
    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("Not now POSTs reject in a single click (no confirm) and refetches", async () => {
    render(<PmHybridDashboard />);
    fireEvent.click(screen.getByRole("button", { name: /^Not now$/ }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith("/api/approvals/dec-stuck-01/reject", {
      method: "POST",
    });
    await screen.findByText(/Declined/);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("on a failed approve it surfaces an inline error and does NOT refetch", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500 });
    render(<PmHybridDashboard />);
    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm approve/ }));
    await screen.findByText(/Couldn’t update\. Try again\.|Couldn't update\. Try again\./);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("PmHybridDashboard — 'Needs you' caps the wall + honest footer", () => {
  const stuck = (theme: string, days: number, i: number) => ({
    id: `stuck-${i}`,
    theme,
    status: "in_flight",
    outcome: null,
    child_run_id: `rn-${i}`,
    child_status: "running",
    updated_at: "2026-06-20T00:00:00.000Z",
    dispatch_stage: "pr_open",
    pr_url: `https://github.com/x/y/pull/${100 + i}`,
    pr_state: "open",
    days_stuck: days,
    decision_id: null,
  });
  const STALE_PAYLOAD = {
    generic: false,
    kpis: { in_flight: 9, shipped_measured: 0, won: 0, recurred: 1 },
    standup: {
      judgment: { candidates_found: 0, dispatched_count: 0, skipped: [] },
      summary_bullets: [],
      loop_closed: [],
      needs_you_count: 9,
      moving_clean_count: 0,
    },
    rows: [
      {
        id: "recurred-1",
        theme: "Recurred exception item",
        status: "shipped",
        outcome: "recurred",
        child_run_id: "rn-rec",
        child_status: "completed",
        updated_at: "2026-06-20T00:00:00.000Z",
        dispatch_stage: "merged",
        pr_url: "https://github.com/x/y/pull/1",
        pr_state: "merged",
        days_stuck: null,
        decision_id: null,
      },
      {
        id: "failed-1",
        theme: "Failed to open item",
        status: "in_flight",
        outcome: null,
        child_run_id: "rn-fail",
        child_status: "completed",
        updated_at: "2026-06-20T00:00:00.000Z",
        dispatch_stage: "failed_to_open",
        pr_url: null,
        pr_state: null,
        days_stuck: null,
        decision_id: null,
      },
      stuck("Stuck twenty", 20, 20),
      stuck("Stuck nineteen", 19, 19),
      stuck("Stuck eighteen", 18, 18),
      stuck("Stuck seventeen", 17, 17),
      stuck("Stuck sixteen", 16, 16),
      stuck("Stuck fifteen", 15, 15),
      stuck("Stuck fourteen", 14, 14),
    ],
  };

  beforeEach(() => {
    activePayload = STALE_PAYLOAD;
  });
  afterEach(() => {
    activePayload = PAYLOAD;
    cleanup();
  });

  it("header shows the REAL total (9), not the capped list length", () => {
    render(<PmHybridDashboard />);
    expect(screen.getByText(/Needs you \(9\)/)).toBeTruthy();
  });

  it("renders at most 6 items ranked by severity + a '+3 more' overflow affordance", () => {
    render(<PmHybridDashboard />);
    expect(screen.getByText("Recurred exception item")).toBeTruthy();
    expect(screen.getByText("Failed to open item")).toBeTruthy();
    expect(screen.getByText("Stuck twenty")).toBeTruthy();
    expect(screen.queryByText("Stuck sixteen")).toBeNull();
    expect(screen.queryByText("Stuck fifteen")).toBeNull();
    expect(screen.queryByText("Stuck fourteen")).toBeNull();
    expect(screen.getByText(/\+3 more in governance/)).toBeTruthy();
  });

  it("footer is HONEST when moving_clean_count is 0 (no fake 'moving fine')", () => {
    const { container } = render(<PmHybridDashboard />);
    expect(
      screen.getByText(/Nothing is moving cleanly right now. The backlog is stalled/),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("is moving fine");
  });
});

describe("PmHybridDashboard — restraint footer sources moving_clean_count from the payload", () => {
  const cleanRow = (i: number) => ({
    id: `clean-${i}`,
    theme: `Clean ${i}`,
    status: "in_flight",
    outcome: null,
    child_run_id: `c-${i}`,
    child_status: "running",
    updated_at: "2026-06-30T00:00:00.000Z",
    dispatch_stage: "dispatched",
    pr_url: null,
    pr_state: null,
    days_stuck: null,
    decision_id: null,
  });
  const SOURCED_PAYLOAD = {
    generic: false,
    kpis: { in_flight: 2, shipped_measured: 0, won: 0, recurred: 0 },
    standup: {
      judgment: { candidates_found: 0, dispatched_count: 0, skipped: [] },
      summary_bullets: [],
      loop_closed: [],
      needs_you_count: 0,
      moving_clean_count: 42,
    },
    rows: [cleanRow(1), cleanRow(2)],
  };

  beforeEach(() => {
    activePayload = SOURCED_PAYLOAD;
  });
  afterEach(() => {
    activePayload = PAYLOAD;
    cleanup();
  });

  it("footer renders the payload's moving_clean_count (42), not the row-derived fallback (2)", () => {
    render(<PmHybridDashboard />);
    expect(screen.getByText(/Everything else \(42\) is moving fine/)).toBeTruthy();
    expect(screen.queryByText(/Everything else \(2\) is moving fine/)).toBeNull();
  });
});
