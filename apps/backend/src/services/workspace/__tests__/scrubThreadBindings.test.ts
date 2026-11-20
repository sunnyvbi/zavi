import { describe, it, expect } from "vitest";
import { scrubThreadBindingsPure } from "../scrubThreadBindings";

const ZAVI = "zavi-thread-1111";
const FOREIGN = "upcar-thread-2222";

function agentTab(slug: string, threadId: string | null | undefined) {
  return { id: `tab-${slug}-${threadId}`, payload: { kind: "agent", slug, threadId } };
}

describe("scrubThreadBindingsPure", () => {
  it("nulls a FOREIGN-tenant binding (the incident) but keeps the tab", () => {
    const valid = new Set([`${ZAVI}|fundraising`]);
    const tabs = [agentTab("fundraising", FOREIGN)];
    const [out] = scrubThreadBindingsPure(tabs, valid);
    expect(out.payload.threadId).toBeNull();
    expect(out.payload.slug).toBe("fundraising");
  });

  it("keeps a binding valid for the active tenant", () => {
    const valid = new Set([`${ZAVI}|fundraising`]);
    const tabs = [agentTab("fundraising", ZAVI)];
    const out = scrubThreadBindingsPure(tabs, valid);
    expect(out[0].payload.threadId).toBe(ZAVI);
    expect(out[0]).toBe(tabs[0]);
  });

  it("nulls a binding whose thread is valid but for a DIFFERENT agent slug", () => {
    const valid = new Set([`${ZAVI}|engineer`]);
    const tabs = [agentTab("fundraising", ZAVI)];
    const [out] = scrubThreadBindingsPure(tabs, valid);
    expect(out.payload.threadId).toBeNull();
  });

  it("leaves tabs with no threadId untouched (fresh tab)", () => {
    const tabs = [agentTab("pm", null), agentTab("pm", undefined)];
    const out = scrubThreadBindingsPure(tabs, new Set());
    expect(out[0].payload.threadId).toBeNull();
    expect(out[1].payload.threadId).toBeUndefined();
    expect(out[0]).toBe(tabs[0]);
    expect(out[1]).toBe(tabs[1]);
  });

  it("never touches non-agent tabs (home/settings/brain)", () => {
    const home = { id: "home", payload: { kind: "home" } } as never;
    const settings = { id: "settings", payload: { kind: "settings" } } as never;
    const out = scrubThreadBindingsPure([home, settings], new Set());
    expect(out[0]).toBe(home);
    expect(out[1]).toBe(settings);
  });

  it("scrubs a deleted/dead deep-link id (empty valid set) across many tabs", () => {
    const tabs = [
      agentTab("engineer", FOREIGN),
      agentTab("pm", FOREIGN),
      agentTab("advisor", ZAVI),
    ];
    const out = scrubThreadBindingsPure(tabs, new Set());
    expect(out.every((t) => t.payload.threadId === null)).toBe(true);
  });

  it("handles a null payload defensively", () => {
    const weird = { id: "x", payload: null } as never;
    const out = scrubThreadBindingsPure([weird], new Set());
    expect(out[0]).toBe(weird);
  });

  function disputeTab(threadId: string | null | undefined) {
    return {
      id: `dtab-${threadId}`,
      payload: { kind: "dispute-detail", disputeId: "du_123", threadId },
    };
  }

  it("nulls a FOREIGN dispute-detail binding (scrubbed under dispute-response slug)", () => {
    const valid = new Set([`${ZAVI}|dispute-response`]);
    const [out] = scrubThreadBindingsPure([disputeTab(FOREIGN)], valid);
    expect(out.payload.threadId).toBeNull();
    expect(out.payload.disputeId).toBe("du_123");
  });

  it("keeps a VALID dispute-detail binding for the active tenant", () => {
    const valid = new Set([`${ZAVI}|dispute-response`]);
    const tabs = [disputeTab(ZAVI)];
    const out = scrubThreadBindingsPure(tabs, valid);
    expect(out[0].payload.threadId).toBe(ZAVI);
    expect(out[0]).toBe(tabs[0]);
  });

  it("leaves a dispute-detail tab with no threadId untouched (fresh tab)", () => {
    const tabs = [disputeTab(null), disputeTab(undefined)];
    const out = scrubThreadBindingsPure(tabs, new Set());
    expect(out[0].payload.threadId).toBeNull();
    expect(out[1].payload.threadId).toBeUndefined();
    expect(out[0]).toBe(tabs[0]);
    expect(out[1]).toBe(tabs[1]);
  });

  function homeTab(threadId: string | null | undefined) {
    return { id: "home-default", payload: { kind: "home", threadId } };
  }

  it("keeps a Home binding to a valid operator thread", () => {
    const tabs = [homeTab(ZAVI)];
    const out = scrubThreadBindingsPure(tabs, new Set([`${ZAVI}|operator`]));
    expect(out[0]).toBe(tabs[0]);
  });

  it("nulls a FOREIGN Home binding but keeps the Home tab", () => {
    const [out] = scrubThreadBindingsPure(
      [homeTab(FOREIGN)],
      new Set([`${ZAVI}|operator`]),
    );
    expect(out.payload.threadId).toBeNull();
    expect(out.payload.kind).toBe("home");
  });

  it("nulls a Home binding to another agent's thread", () => {
    const [out] = scrubThreadBindingsPure(
      [homeTab(ZAVI)],
      new Set([`${ZAVI}|engineer`]),
    );
    expect(out.payload.threadId).toBeNull();
  });

  it("nulls a Home binding to a deleted / closed thread (not in the valid set)", () => {
    const [out] = scrubThreadBindingsPure([homeTab(ZAVI)], new Set());
    expect(out.payload.threadId).toBeNull();
  });

  it("nulls a FOREIGN Build binding and keeps the build session", () => {
    const build = (threadId: string) => ({
      id: "build",
      payload: { kind: "build", sessionId: "s1", threadId },
    });
    const [kept] = scrubThreadBindingsPure([build(ZAVI)], new Set([`${ZAVI}|operator`]));
    expect(kept.payload.threadId).toBe(ZAVI);
    const [out] = scrubThreadBindingsPure([build(FOREIGN)], new Set([`${ZAVI}|operator`]));
    expect(out.payload.threadId).toBeNull();
    expect(out.payload.sessionId).toBe("s1");
  });

  it("scrubs a Growth (autopilot) binding under the cgo slug", () => {
    const growth = (threadId: string) => ({ id: "growth", payload: { kind: "autopilot", threadId } });
    const [kept] = scrubThreadBindingsPure([growth(ZAVI)], new Set([`${ZAVI}|cgo`]));
    expect(kept.payload.threadId).toBe(ZAVI);
    const [out] = scrubThreadBindingsPure([growth(FOREIGN)], new Set([`${ZAVI}|cgo`]));
    expect(out.payload.threadId).toBeNull();
    expect(out.payload.kind).toBe("autopilot");
  });

  it("leaves an unbound Home tab untouched", () => {
    const tabs = [homeTab(null), homeTab(undefined)];
    const out = scrubThreadBindingsPure(tabs, new Set());
    expect(out[0]).toBe(tabs[0]);
    expect(out[1]).toBe(tabs[1]);
  });
});
