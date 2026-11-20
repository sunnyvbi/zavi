import { describe, it, expect } from "vitest";
import { cookingView, isSetupLocked, isStaleSetup, strategyCardState, finishedSteps, type SetupResponse, type SetupState } from "./setupState";
import { fileFromServer, summarizeReads } from "./importReadState";

const NOW = Date.now();
const file = (extraction: unknown) => fileFromServer({ id: "d", filename: "zavi-context.md", created_at: new Date(NOW - 1000).toISOString(), extraction }, NOW);
const none = summarizeReads([]);
const reading = summarizeReads([file(null)]);
const read = summarizeReads([file({ state: "read", facts: 42 })]);
const failed = summarizeReads([file({ state: "unreadable", reason: "no text in it" })]);

const on = (over: Partial<Extract<SetupResponse, { enabled: true }>> = {}): SetupState => ({
  enabled: true,
  docs: { status: "pending", files: 0, facts: 0 },
  connectors: { status: "pending" },
  done: false,
  home_seen: false,
  draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: false },
  ...over,
});

describe("setup helpers", () => {
  it("locks only owners/admins, only when ON and not done; loading (null) and OFF never lock", () => {
    expect(isSetupLocked(null, "owner")).toBe(false);
    expect(isSetupLocked({ enabled: false }, "owner")).toBe(false);
    expect(isSetupLocked(on(), "owner")).toBe(true);
    expect(isSetupLocked(on(), "admin")).toBe(true);
    expect(isSetupLocked(on(), "member")).toBe(false);
    expect(isSetupLocked(on({ done: true }), "owner")).toBe(false);
  });
  it("cooking bar: 20 before step 1, 50 after it, 90 while the draft has not started, 100 once it has", () => {
    expect(cookingView(on(), none).pct).toBe(20);
    expect(cookingView(on({ docs: { status: "skipped", files: 0, facts: 0 } }), none).pct).toBe(50);
    const after2 = on({ docs: { status: "done", files: 1, facts: 3 }, connectors: { status: "skipped" } });
    expect(cookingView(after2, none)).toEqual({ pct: 90, ready: false, waiting: false, sub: null });
    expect(cookingView({ ...after2, draft: { ...after2.draft, status: "running" } }, none).pct).toBe(100);
    expect(cookingView({ ...after2, draft: { ...after2.draft, status: "done" } }, none).ready).toBe(true);
  });
  it("step 2 done and a read open: 'Waiting for your file' held at 90%, never full", () => {
    const after2 = on({ docs: { status: "done", files: 1, facts: 0 }, connectors: { status: "done" } });
    expect(cookingView(after2, reading)).toEqual({
      pct: 90, ready: false, waiting: true, sub: "Reading zavi-context.md. The draft starts the moment it's done.",
    });
  });
  it("the sub line says what the background read is doing (no read percentage)", () => {
    const at2 = on({ docs: { status: "done", files: 1, facts: 0 } });
    expect(cookingView(at2, reading).sub).toBe("Reading zavi-context.md in the background.");
    expect(cookingView(at2, read).sub).toBe("Read zavi-context.md: 42 facts.");
    expect(cookingView(at2, failed).sub).toBe("Couldn't read zavi-context.md. Using your website.");
    const cooking = on({ docs: { status: "done", files: 1, facts: 42 }, connectors: { status: "done" }, draft: { status: "running", run_id: "r", attempts: 1, can_retry: false, free_retry: true } });
    expect(cookingView(cooking, read).sub).toBe("Writing the draft from 42 facts from zavi-context.md, your website and your details.");
    for (const v of [reading, read, failed]) expect(JSON.stringify(cookingView(at2, v))).not.toMatch(/\d+%/);
  });
  it("counts finished steps, including the finish", () => {
    expect(finishedSteps(on())).toBe(0);
    expect(finishedSteps(on({ docs: { status: "skipped", files: 0, facts: 0 }, connectors: { status: "done" }, done: true }))).toBe(3);
  });
});

describe("isStaleSetup", () => {
  const done = on({ docs: { status: "done", files: 1, facts: 2 }, connectors: { status: "skipped" }, done: true });
  it("drops an answer that would take a finished setup back to running", () => {
    expect(isStaleSetup(done, on())).toBe(true);
    expect(isStaleSetup(done, { ...done, done: false })).toBe(true);
  });
  it("drops an answer that reopens an answered step", () => {
    const step1 = on({ docs: { status: "skipped", files: 0, facts: 0 } });
    expect(isStaleSetup(step1, on())).toBe(true);
  });
  it("drops an answer that brings a dismissed ready card back", () => {
    expect(isStaleSetup({ ...done, home_seen: true }, done)).toBe(true);
  });
  it("accepts forward moves, same-step updates and the first answer", () => {
    expect(isStaleSetup(on(), done)).toBe(false);
    expect(isStaleSetup(done, { ...done, draft: { ...done.draft, status: "running" } })).toBe(false);
    expect(isStaleSetup(null, on())).toBe(false);
    expect(isStaleSetup(done, { enabled: false })).toBe(false);
  });
});

describe("strategyCardState", () => {
  const after = (over: Partial<SetupState> = {}) => on({ done: true, ...over });
  it("shows nothing while setup runs, after the ready card is dismissed, or to a member", () => {
    expect(strategyCardState(on(), true)).toBeNull();
    expect(strategyCardState(after({ home_seen: true }), true)).toBeNull();
    expect(strategyCardState(after(), false)).toBeNull();
    expect(strategyCardState({ enabled: false }, true)).toBeNull();
    expect(strategyCardState(null, true)).toBeNull();
  });
  it("is writing until the draft lands", () => {
    expect(strategyCardState(after(), true)).toBe("writing");
    expect(strategyCardState(after(), true, true)).toBe("failed");
    expect(strategyCardState(after({ draft: { status: "running", run_id: "r", attempts: 1, can_retry: false, free_retry: false } }), true, true)).toBe("writing");
    expect(strategyCardState(after({ draft: { status: "running", run_id: "r", attempts: 1, can_retry: false, free_retry: false } }), true)).toBe("writing");
  });
  it("is ready once a plan exists, however it was drafted", () => {
    expect(strategyCardState(after({ draft: { status: "done", run_id: "r", attempts: 1, can_retry: false, free_retry: false } }), true)).toBe("ready");
    expect(strategyCardState(after({ has_plan: true }), true)).toBe("ready");
  });
  it("says nothing once the draft was set aside and no plan is live (Start over)", () => {
    const setAside = { status: "done" as const, run_id: "r", attempts: 1, can_retry: false, free_retry: false };
    expect(strategyCardState(after({ has_plan: false, draft: setAside }), true)).toBeNull();
    expect(strategyCardState(after({ has_plan: true, draft: setAside }), true)).toBe("ready");
  });
  it("a failed draft is not called ready because an older plan is live", () => {
    expect(strategyCardState(after({ has_plan: true, draft: { status: "failed", run_id: "r", attempts: 1, can_retry: true, free_retry: true } }), true)).toBe("failed");
  });
  it("says the draft failed when it did and no plan exists", () => {
    expect(strategyCardState(after({ draft: { status: "failed", run_id: "r", attempts: 1, can_retry: true, free_retry: true } }), true)).toBe("failed");
  });
});
