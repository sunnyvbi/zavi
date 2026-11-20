// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  setupActive: true,
  ctx: null as null | Record<string, unknown>,
  ccProps: null as null | Record<string, unknown>,
  plan: { id: "p1" } as null | { id: string },
  refresh: vi.fn(),
  learned: null as unknown,
  interview: null as unknown,
}));

vi.mock("@/lib/workspace/useGrowthPlan", () => ({
  POLL_MS: 10_000, POLL_CAP_MS: 600_000,
  useGrowthPlan: () => ({
    data: { plan: h.plan, unreadable: [] },
    loading: false,
    error: null,
    reload: vi.fn(),
    refresh: h.refresh,
    drafting: false,
    draftSlow: false,
    watchForPlan: vi.fn(),
  }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === "/api/workspace/growth-intake/learned" && h.learned) return { ok: true, status: 200, json: async () => h.learned };
    if (path === "/api/workspace/growth-interview" && h.interview) return { ok: true, status: 200, json: async () => h.interview };
    return { ok: false, status: 500, json: async () => ({}) };
  }),
}));
vi.mock("./setup/SetupProvider", () => ({
  useSetupActive: () =>
    h.setupActive
      ? { enabled: true, done: false, docs: { status: "skipped", files: 0, facts: 0 }, connectors: { status: "pending" } }
      : null,
  useSetupOptional: () => h.ctx,
}));
vi.mock("./growth/GrowthCommandCenter", () => ({
  GrowthCommandCenter: (props: Record<string, unknown>) => {
    h.ccProps = props;
    return <div data-testid="command-center">plan</div>;
  },
}));
vi.mock("./growth/j6/GrowthJ6", () => ({
  GrowthJ6: (props: Record<string, unknown>) => {
    h.ccProps = props;
    return <div data-testid="command-center">plan</div>;
  },
}));

import { GrowthCoachPage } from "./GrowthCoachPage";
import { apiFetch } from "@/lib/api";

afterEach(() => {
  cleanup();
  h.setupActive = true;
  h.ctx = null;
  h.ccProps = null;
  h.plan = { id: "p1" };
  h.refresh.mockClear();
  h.learned = null;
  h.interview = null;
  (apiFetch as unknown as ReturnType<typeof vi.fn>).mockClear();
});

const doneState = (draft: Record<string, unknown>) => ({
  enabled: true,
  docs: { status: "done", files: 1, facts: 3 },
  connectors: { status: "skipped" },
  done: true,
  home_seen: false,
  draft: { status: "failed", run_id: null, attempts: 1, can_retry: true, free_retry: true, ...draft },
});

describe("GrowthCoachPage during the welcome setup", () => {
  it("renders the plain page underneath: the setup card and dimming moved to the full-screen setup", () => {
    h.setupActive = true;
    render(<GrowthCoachPage />);
    expect(screen.queryByText("Welcome to Zavi.")).toBeNull();
    expect(screen.getByTestId("command-center")).toBeTruthy();
  });
});

describe("GrowthCoachPage after the welcome setup", () => {
  it("re-reads the plan when a Try again saved the stored draft without a watch", () => {
    h.setupActive = false;
    h.plan = null;
    h.ctx = { state: doneState({ status: "done" }), finishNote: null, draftBlocked: null, startDraft: vi.fn() };
    render(<GrowthCoachPage />);
    expect(h.refresh).toHaveBeenCalled();
  });
  it("does not re-read a plan that is already there", () => {
    h.setupActive = false;
    h.ctx = { state: doneState({ status: "done" }), finishNote: null, draftBlocked: null, startDraft: vi.fn() };
    render(<GrowthCoachPage />);
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it("a finished draft is not a failed one, and the step-3 finish note still shows", () => {
    h.setupActive = false;
    h.ctx = { state: doneState({ status: "done" }), finishNote: "Some details didn't save (website). You can change them in Company Details.", draftBlocked: null, startDraft: vi.fn() };
    render(<GrowthCoachPage />);
    expect(screen.getByText(/Some details didn't save \(website\)/)).toBeTruthy();
    expect(h.ccProps?.draftFailed).toBe(false);
  });

  it("a failed draft offers a refunded retry while free tries remain", () => {
    h.setupActive = false;
    const startDraft = vi.fn(async () => {});
    h.ctx = { state: doneState({}), draftBlocked: null, startDraft };
    render(<GrowthCoachPage />);
    expect(h.ccProps?.draftFailed).toBe(true);
    expect(h.ccProps?.retryCharged).toBe(false);
    (h.ccProps?.onRetryDraft as () => void)();
    expect(startDraft).toHaveBeenCalledWith(true, false);
  });

  it("after the free tries, the retry is a paid try; a refused paid try shows the credit notice", () => {
    h.setupActive = false;
    const startDraft = vi.fn(async () => {});
    h.ctx = { state: doneState({ free_retry: false, attempts: 3 }), draftBlocked: "insufficient_credits", startDraft };
    render(<GrowthCoachPage />);
    expect(h.ccProps?.retryCharged).toBe(true);
    (h.ccProps?.onRetryDraft as () => void)();
    expect(startDraft).toHaveBeenCalledWith(true, true);
    expect(screen.getByText(/Out of credits/)).toBeTruthy();
  });
});

describe("GrowthCoachPage after setup (no Setup complete card)", () => {
  it("shows no card, and records once that an owner reached the page with a plan", async () => {
    h.setupActive = false;
    const mark = vi.fn(async () => null);
    h.ctx = { state: doneState({ status: "done" }), canManageSetup: true, draftBlocked: null, startDraft: vi.fn(), mark };
    const { rerender } = render(<GrowthCoachPage live />);
    expect(h.ccProps?.footer).toBeUndefined();
    await waitFor(() => expect(mark).toHaveBeenCalledWith({ step: "home" }));
    rerender(<GrowthCoachPage live />);
    expect(mark).toHaveBeenCalledTimes(1);
  });
  it("never records it for a member, or while the page is not on screen", () => {
    h.setupActive = false;
    const mark = vi.fn(async () => null);
    h.ctx = { state: doneState({ status: "done" }), canManageSetup: false, draftBlocked: null, startDraft: vi.fn(), mark };
    render(<GrowthCoachPage live />);
    h.ctx = { state: doneState({ status: "done" }), canManageSetup: true, draftBlocked: null, startDraft: vi.fn(), mark };
    render(<GrowthCoachPage />);
    expect(mark).not.toHaveBeenCalled();
  });
});

describe("GrowthCoachPage while the strategy builds", () => {
  it("is building while the setup draft starts or runs and no plan is there yet", () => {
    h.setupActive = false;
    h.plan = null;
    h.ctx = { state: doneState({ status: "none" }), draftBlocked: null, draftStarting: true, startDraft: vi.fn() };
    const { rerender } = render(<GrowthCoachPage />);
    expect(h.ccProps?.building).toBe(true);
    h.ctx = { state: doneState({ status: "running", run_id: "r1" }), draftBlocked: null, draftStarting: false, startDraft: vi.fn() };
    rerender(<GrowthCoachPage />);
    expect(h.ccProps?.building).toBe(true);
  });

  it("is not building once the plan exists or the draft failed", () => {
    h.setupActive = false;
    h.ctx = { state: doneState({ status: "running", run_id: "r1" }), draftBlocked: null, draftStarting: false, startDraft: vi.fn() };
    const { rerender } = render(<GrowthCoachPage />);
    expect(h.ccProps?.building).toBe(false);
    h.plan = null;
    h.ctx = { state: doneState({ status: "failed" }), draftBlocked: null, draftStarting: false, startDraft: vi.fn() };
    rerender(<GrowthCoachPage />);
    expect(h.ccProps?.building).toBe(false);
  });
});

describe("GrowthCoachPage while the first plan cooks", () => {
  const LEARNED = {
    status: "ready",
    card: { lines: ["You come up next to Molly Maid and Merry Maids."], quotes: [] },
  };
  const learnedReads = () =>
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "/api/workspace/growth-intake/learned").length;

  it("shows what Zavi learned from the research before the plan exists", async () => {
    h.setupActive = false;
    h.plan = null;
    h.learned = LEARNED;
    h.ctx = { state: doneState({ status: "running" }), finishNote: null, draftBlocked: null, startDraft: vi.fn(), canManageSetup: true };
    render(<GrowthCoachPage />);
    await waitFor(() => expect(screen.getByTestId("what-zavi-learned").textContent).toContain("Molly Maid and Merry Maids"));
    expect(screen.getByTestId("command-center")).toBeTruthy();
  });

  it("once the plan is there the card is gone and the research is not read", async () => {
    h.setupActive = false;
    h.learned = LEARNED;
    h.ctx = { state: doneState({ status: "done" }), finishNote: null, draftBlocked: null, startDraft: vi.fn() };
    render(<GrowthCoachPage />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("what-zavi-learned")).toBeNull();
    expect(learnedReads()).toBe(0);
  });
});

describe("GrowthCoachPage later questions", () => {
  const OPEN = { slots: [{ key: "metric", answer: null }], skipped: false, customers_answered: false };
  const reads = () =>
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "/api/workspace/growth-interview").length;

  it("asks an owner once the plan exists", async () => {
    h.setupActive = false;
    h.plan = { id: "p1" };
    h.interview = OPEN;
    h.ctx = { state: doneState({ status: "done" }), canManageSetup: true, draftBlocked: null, startDraft: vi.fn() };
    render(<GrowthCoachPage />);
    await waitFor(() => expect(screen.getByTestId("later-questions").textContent).toContain("If one thing got better"));
  });

  it("never asks a member, and never reads the interview for one", async () => {
    h.setupActive = false;
    h.plan = { id: "p1" };
    h.interview = OPEN;
    h.ctx = { state: doneState({ status: "done" }), canManageSetup: false, draftBlocked: null, startDraft: vi.fn() };
    render(<GrowthCoachPage />);
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(0);
    expect(screen.queryByTestId("later-questions")).toBeNull();
  });

  it("does not interrupt while the first plan is still being written", async () => {
    h.setupActive = false;
    h.plan = null;
    h.interview = OPEN;
    h.ctx = { state: doneState({ status: "running" }), finishNote: null, draftBlocked: null, startDraft: vi.fn(), canManageSetup: true };
    render(<GrowthCoachPage />);
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(0);
  });
});
