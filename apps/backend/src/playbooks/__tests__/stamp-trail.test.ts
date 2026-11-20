import { describe, it, expect } from "vitest";
import { extractPlaybookRunId, stampPlaybookRunId } from "../stamp";
import { summarizeTrail } from "../trail";

describe("extractPlaybookRunId", () => {
  it("pulls a non-empty string id from payload", () => {
    expect(extractPlaybookRunId({ playbook_run_id: "abc" })).toBe("abc");
  });
  it("returns undefined for missing / empty / non-string / non-object", () => {
    expect(extractPlaybookRunId({})).toBeUndefined();
    expect(extractPlaybookRunId({ playbook_run_id: "" })).toBeUndefined();
    expect(extractPlaybookRunId({ playbook_run_id: 42 })).toBeUndefined();
    expect(extractPlaybookRunId(null)).toBeUndefined();
    expect(extractPlaybookRunId("x")).toBeUndefined();
  });
});

describe("stampPlaybookRunId", () => {
  it("folds the id into an object body without mutating the input", () => {
    const body = { observation: "x" };
    const out = stampPlaybookRunId(body, "run-1") as Record<string, unknown>;
    expect(out.playbook_run_id).toBe("run-1");
    expect(out.observation).toBe("x");
    expect((body as Record<string, unknown>).playbook_run_id).toBeUndefined();
  });
  it("is a no-op without an id", () => {
    const body = { a: 1 };
    expect(stampPlaybookRunId(body, undefined)).toBe(body);
  });
  it("server stamp ALWAYS wins over an agent-supplied id (anti-spoof)", () => {
    const body = { playbook_run_id: "agent-spoofed" };
    const out = stampPlaybookRunId(body, "server-authoritative") as Record<string, unknown>;
    expect(out.playbook_run_id).toBe("server-authoritative");
    expect((body as Record<string, unknown>).playbook_run_id).toBe("agent-spoofed");
  });
  it("is a no-op on non-object bodies (string / array / null)", () => {
    expect(stampPlaybookRunId("hi", "r")).toBe("hi");
    const arr = [1, 2];
    expect(stampPlaybookRunId(arr, "r")).toBe(arr);
    expect(stampPlaybookRunId(null, "r")).toBeNull();
  });
});

describe("summarizeTrail — honest outcome counts", () => {
  it("counts acted as the only 'done', separates blocked from declined", () => {
    const s = summarizeTrail([
      { decision_class: "outbound.send", status: "acted", dispatch_error: null },
      { decision_class: "outbound.send", status: "acted", dispatch_error: null },
      { decision_class: "outbound.send", status: "proposed", dispatch_error: null },
      { decision_class: "outbound.send", status: "rejected", dispatch_error: "not_connected" },
      { decision_class: "outbound.send", status: "rejected", dispatch_error: null },
      { decision_class: "meta_ads.set_status_review", status: "approved", dispatch_error: null },
    ]);
    expect(s).toEqual({ total: 6, acted: 2, proposed: 1, approved: 1, rejected: 2, blocked: 1 });
  });
  it("empty trail = all zeros", () => {
    expect(summarizeTrail([])).toEqual({ total: 0, acted: 0, proposed: 0, approved: 0, rejected: 0, blocked: 0 });
  });
});
