// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useEffect, useReducer } from "react";
import { mascotLine } from "./setup/SetupMascot";
import { BUILDING_LINE, READY_LINE, strategyProgressLine } from "./setup/setupCopy";
import type { SetupState } from "./setup/setupState";

const PLAN_A = { source: "typed", id: "p1", version: 1, updated_at: "2026-09-29T10:00:00Z", pending_acceptance: false, basis_evidence: [] };
const PLAN_B = { ...PLAN_A, version: 2, updated_at: "2026-09-29T10:03:00Z" };

const h = vi.hoisted(() => ({
  setup: null as unknown,
  next: [] as unknown[],
  listeners: new Set<() => void>(),
  plan: null as unknown,
  planReads: 0,
  setupReads: 0,
  ccProps: null as null | Record<string, unknown>,
  locked: false,
}));

function setSetup(s: unknown) {
  h.setup = s;
  for (const l of Array.from(h.listeners)) l();
}

const refresh = vi.fn(async () => {
  h.setupReads += 1;
  if (h.next.length) setSetup(h.next.shift());
});

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === "/api/workspace/growth/plan") {
      h.planReads += 1;
      return { ok: true, status: 200, json: async () => ({ plan: h.plan, unreadable: [] }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  }),
}));
vi.mock("./setup/SetupProvider", () => ({
  useSetupOptional: () => {
    const [, force] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
      h.listeners.add(force);
      return () => {
        h.listeners.delete(force);
      };
    }, []);
    return { state: h.setup, refresh, locked: h.locked, canManageSetup: true, draftBlocked: null, draftStarting: false, startDraft: vi.fn(), finishNote: null };
  },
}));
vi.mock("./setup/ReadyPanel", () => ({ ReadyPanel: () => null, showReadyPanel: () => false }));
vi.mock("./setup/AddKnowledgeDialog", () => ({ AddKnowledgeButton: () => null, showAddKnowledge: () => false }));
vi.mock("./setup/AfterSetupReadNote", () => ({ AfterSetupReadNote: () => null }));
vi.mock("./growth/GrowthCommandCenter", () => ({
  GrowthCommandCenter: (props: Record<string, unknown>) => {
    h.ccProps = props;
    return null;
  },
}));
vi.mock("./growth/j6/GrowthJ6", () => ({
  GrowthJ6: (props: Record<string, unknown>) => {
    h.ccProps = props;
    return null;
  },
}));

import { GrowthCoachPage } from "./GrowthCoachPage";

const state = (draft: Partial<SetupState["draft"]>, oneState = true): SetupState => ({
  enabled: true,
  docs: { status: "skipped", files: 0, facts: 0 },
  connectors: { status: "skipped" },
  done: true,
  home_seen: false,
  draft: { status: "running", run_id: "r1", attempts: 1, can_retry: false, free_retry: false, ...draft },
  ...(oneState ? { one_state: true } : {}),
});

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const pageSaysBuilding = () => h.ccProps?.drafting === true;
const chatLine = () => mascotLine(h.setup as SetupState).line;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  refresh.mockClear();
  h.setup = null;
  h.next = [];
  h.listeners.clear();
  h.plan = null;
  h.planReads = 0;
  h.setupReads = 0;
  h.ccProps = null;
  h.locked = false;
});

describe("plan opened mark (it also skips the plan-ready email)", () => {
  const marks = async () => {
    const { apiFetch } = await import("@/lib/api");
    return (apiFetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => c[0] === "/api/workspace/next-tiles/mark").length;
  };
  const setVisibility = (v: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  let focused = true;
  beforeEach(() => {
    focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  });
  afterEach(() => {
    setVisibility("visible");
    vi.mocked(document.hasFocus).mockRestore();
  });

  it("is not sent while the window is in the background, and is sent once it gets focus", async () => {
    const before = await marks();
    focused = false;
    h.plan = PLAN_A;
    setSetup(state({ status: "done" }));
    render(<GrowthCoachPage live />);
    await flush();
    expect(await marks()).toBe(before);
    focused = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(await marks()).toBe(before + 1);
  });

  it("is not sent while the Growth tab is hidden behind another workspace tab", async () => {
    const before = await marks();
    h.plan = PLAN_A;
    setSetup(state({ status: "done" }));
    render(<GrowthCoachPage live={false} />);
    await flush();
    expect(await marks()).toBe(before);
  });

  it("is not sent while the full-screen setup covers the page", async () => {
    const before = await marks();
    h.locked = true;
    h.plan = PLAN_A;
    setSetup(state({ status: "done" }));
    render(<GrowthCoachPage live />);
    await flush();
    expect(await marks()).toBe(before);
  });

  it("waits for the browser tab to be visible, then is sent once", async () => {
    const before = await marks();
    setVisibility("hidden");
    h.plan = PLAN_A;
    setSetup(state({ status: "done" }));
    render(<GrowthCoachPage live />);
    await flush();
    expect(await marks()).toBe(before);
    await act(async () => setVisibility("visible"));
    await act(async () => setVisibility("hidden"));
    await act(async () => setVisibility("visible"));
    expect(await marks()).toBe(before + 1);
  });
});

describe("first plan cooking card", () => {
  it("shows Zavi cooking with about 15 minutes left while the first plan is written, and goes once it is on screen", async () => {
    h.plan = null;
    setSetup(state({ status: "running", run_id: "r1" }));
    const { container } = render(<GrowthCoachPage />);
    await flush();
    expect(container.querySelector('[data-testid="plan-cooking"]')).not.toBeNull();
    expect(container.textContent).toContain("About 15 minutes.");

    h.plan = PLAN_A;
    h.next = [state({ status: "done", run_id: "r1" })];
    await flush(10_000);
    expect(container.querySelector('[data-testid="plan-cooking"]')).toBeNull();
  });

  it("is not shown when the setup draft is not running (a later redraft gets no email)", async () => {
    h.plan = null;
    setSetup(state({ status: "done", run_id: "r1" }));
    const { container } = render(<GrowthCoachPage />);
    await flush();
    expect(container.querySelector('[data-testid="plan-cooking"]')).toBeNull();
  });
});

describe("B12: Skip setup > Take me in shows one strategy state", () => {
  it("the ticket repro: the strategy already landed when the draft run is first seen; once the setup says ready the page stops saying Building", async () => {
    h.plan = PLAN_A;
    setSetup(state({ status: "none", run_id: null }));
    render(<GrowthCoachPage />);
    await flush();
    setSetup(state({ status: "running", run_id: "r1" }));
    await flush();
    expect(pageSaysBuilding()).toBe(true);
    expect(chatLine()).toBe(strategyProgressLine());

    const readsBefore = h.planReads;
    setSetup(state({ status: "done", run_id: "r1" }));
    await flush();
    expect(chatLine()).toBe(READY_LINE);
    expect(pageSaysBuilding()).toBe(false);
    expect(h.planReads).toBeGreaterThan(readsBefore);
  });

  it("while the draft runs the page re-reads the setup, so the chat and the page flip to ready on the same answer", async () => {
    h.plan = PLAN_A;
    setSetup(state({ status: "none", run_id: null }));
    render(<GrowthCoachPage />);
    await flush();
    setSetup(state({ status: "running", run_id: "r1" }));
    await flush();
    h.next = [state({ status: "done", run_id: "r1" })];
    await flush(10_000);
    expect(h.setupReads).toBeGreaterThanOrEqual(1);
    expect(chatLine()).toBe(READY_LINE);
    expect(pageSaysBuilding()).toBe(false);
  });

  it("a plan that lands before the run finishes keeps the page on Building, like the chat, until the setup says ready", async () => {
    h.plan = null;
    setSetup(state({ status: "running", run_id: "r1" }));
    render(<GrowthCoachPage />);
    await flush();
    h.plan = PLAN_B;
    h.next = [state({ status: "running", run_id: "r1" })];
    await flush(10_000);
    expect(chatLine()).toBe(strategyProgressLine());
    expect(pageSaysBuilding()).toBe(true);

    h.next = [state({ status: "done", run_id: "r1" })];
    await flush(10_000);
    expect(chatLine()).toBe(READY_LINE);
    expect(pageSaysBuilding()).toBe(false);
  });

  it("a failed draft ends Building at once and shows the failed state, not ten more minutes of Building", async () => {
    h.plan = PLAN_A;
    setSetup(state({ status: "none", run_id: null }));
    render(<GrowthCoachPage />);
    await flush();
    setSetup(state({ status: "running", run_id: "r1" }));
    await flush();
    setSetup(state({ status: "failed", run_id: "r1", can_retry: true, free_retry: true }));
    await flush();
    expect(pageSaysBuilding()).toBe(false);
    expect(h.ccProps?.draftFailed).toBe(true);
  });

  it("a redraft the founder starts after setup is not cut short by the old setup answer", async () => {
    h.plan = PLAN_A;
    setSetup(state({ status: "none", run_id: null }));
    render(<GrowthCoachPage />);
    await flush();
    setSetup(state({ status: "running", run_id: "r1" }));
    await flush();
    setSetup(state({ status: "done", run_id: "r1" }));
    await flush();
    expect(pageSaysBuilding()).toBe(false);

    await act(async () => {
      (h.ccProps?.onDraftStarted as () => void)();
    });
    setSetup(state({ status: "done", run_id: "r1" }));
    await flush();
    expect(pageSaysBuilding()).toBe(true);
  });

  it("while the plan watch and the setup run overlap, one timer polls both: one setup read and one plan read per tick", async () => {
    h.plan = PLAN_A;
    setSetup(state({ status: "none", run_id: null }));
    render(<GrowthCoachPage />);
    await flush();
    setSetup(state({ status: "running", run_id: "r1" }));
    await flush();
    expect(pageSaysBuilding()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    const planBefore = h.planReads;
    const setupBefore = h.setupReads;
    for (let i = 0; i < 3; i += 1) {
      await flush(10_000);
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(h.planReads - planBefore).toBe(3);
    expect(h.setupReads - setupBefore).toBe(3);
  });

  it("when the plan lands mid-run the setup poll carries on alone and keeps watching slowly after ten minutes", async () => {
    h.plan = null;
    setSetup(state({ status: "running", run_id: "r1" }));
    render(<GrowthCoachPage />);
    await flush();
    h.plan = PLAN_B;
    await flush(10_000);
    expect(pageSaysBuilding()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    const afterLand = h.setupReads;
    await flush(10_000);
    expect(h.setupReads).toBe(afterLand + 1);
    await flush(20 * 60_000);
    const capped = h.setupReads;
    expect(capped).toBeGreaterThan(61);
    await flush(60_000);
    expect(h.setupReads).toBe(capped + 2);
  });

  it("also observes terminal setup state with the older screen enabled", async () => {
    h.plan = PLAN_A;
    setSetup(state({ status: "none", run_id: null }, false));
    render(<GrowthCoachPage />);
    await flush();
    setSetup(state({ status: "running", run_id: "r1" }, false));
    await flush();
    await flush(10_000);
    expect(h.setupReads).toBeGreaterThan(0);
    setSetup(state({ status: "done", run_id: "r1" }, false));
    await flush();
    expect(pageSaysBuilding()).toBe(false);
  });
});
