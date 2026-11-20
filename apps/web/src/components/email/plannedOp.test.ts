import { describe, expect, it } from "vitest";
import { DONT_SEND_LINE, planOpNotice, planOpResolved, sameIntent, withPlanOpAnswer, type PlanOp, type PlanOpAnswer, type PlanRead } from "./plannedOp";
import type { PlannedOnCard } from "./EmailCampaignCard";

const p = (over: Partial<PlannedOnCard> = {}): PlannedOnCard => ({
  id: "i",
  planned_at: "2099-10-21T16:00:00Z",
  planned_label: "Wed, Oct 21, 09:00",
  timezone: "UTC",
  status: "ready",
  status_reason: null,
  reason: null,
  schedule_gen: 1,
  content_version: 1,
  vetoed: false,
  scheduled: null,
  ...over,
});
const READS: Record<string, PlanRead> = {
  none: undefined,
  failed: "failed",
  missing: null,
  ready: p(),
  readyVetoed: p({ vetoed: true }),
  readyVetoedNewer: p({ vetoed: true, schedule_gen: 2 }),
  readyNewer: p({ schedule_gen: 2 }),
  scheduledOther: p({ status: "scheduled", scheduled: { variant: 1, count: 10, by: "u" } }),
  scheduledNewer: p({ status: "scheduled", schedule_gen: 2, scheduled: { variant: 2, count: 10, by: "u" } }),
  sendingNewer: p({ status: "sending", schedule_gen: 2 }),
  sendingOther: p({ status: "sending", scheduled: { variant: 1, count: 10, by: "u" } }),
  scheduled: p({ status: "scheduled", scheduled: { variant: 2, count: 10, by: "u" } }),
  sending: p({ status: "sending" }),
  sent: p({ status: "sent" }),
  reconciling: p({ status: "reconciling" }),
  skipped: p({ status: "skipped", reason: "Not approved by the planned time." }),
  drafting: p({ status: "drafting" }),
};
const ANSWERS: Record<string, PlanOpAnswer | undefined> = {
  lost: undefined,
  fresh: { ok: true, replayed: false },
  replayed: { ok: true, replayed: true, status: "scheduled" },
  noFlag: { ok: true },
  refused: { refused: "Send yourself a test first." },
};

const TABLE: Array<[PlanOp["kind"], string, string, string | null, boolean]> = [
  ["schedule", "lost", "none", null, false],
  ["schedule", "lost", "failed", "Approval status unknown", false],
  ["schedule", "lost", "missing", "Approval status unknown", false],
  ["schedule", "lost", "ready", "Approval status unknown", false],
  ["schedule", "lost", "readyVetoed", "Approval status unknown", false],
  ["schedule", "lost", "readyVetoedNewer", "Stopped with Don't send", true],
  ["schedule", "lost", "readyNewer", "The plan changed", true],
  ["schedule", "lost", "scheduledOther", "Approval status unknown", false],
  ["schedule", "lost", "scheduledNewer", "The plan changed", true],
  ["schedule", "lost", "sendingNewer", "The plan changed", true],
  ["schedule", "lost", "sendingOther", "The plan changed", true],
  ["schedule", "fresh", "sending", "It has already started sending", true],
  ["schedule", "fresh", "readyVetoed", "Stopped with Don't send", true],
  ["schedule", "lost", "scheduled", "Approved B for Wed, Oct 21, 09:00", true],
  ["schedule", "lost", "sending", "It has already started sending", true],
  ["schedule", "lost", "reconciling", "It has already started sending", true],
  ["schedule", "lost", "skipped", "Not approved for its time", true],
  ["schedule", "lost", "drafting", "The plan changed", true],
  ["schedule", "fresh", "none", null, false],
  ["schedule", "fresh", "failed", "Zavi accepted the approval. Checking…", false],
  ["schedule", "fresh", "missing", "Zavi accepted the approval. Checking…", false],
  ["schedule", "fresh", "ready", "Not approved", true],
  ["schedule", "fresh", "scheduled", "Approved B for Wed, Oct 21, 09:00", true],
  ["schedule", "replayed", "failed", "Approval status unknown", false],
  ["schedule", "replayed", "ready", "Not approved", true],
  ["schedule", "replayed", "scheduled", "Approved B for Wed, Oct 21, 09:00", true],
  ["schedule", "noFlag", "failed", "Approval status unknown", false],
  ["schedule", "noFlag", "ready", "Not approved", true],
  ["schedule", "refused", "none", "Not approved", true],
  ["schedule", "refused", "scheduled", "Not approved", true],
  ["withdraw", "lost", "none", null, false],
  ["withdraw", "lost", "failed", "Not sure it was stopped", false],
  ["withdraw", "lost", "missing", "Not sure it was stopped", false],
  ["withdraw", "lost", "ready", "Not sure it was stopped", false],
  ["withdraw", "lost", "readyVetoed", "Not sending", true],
  ["withdraw", "lost", "scheduled", "Not sure it was stopped", false],
  ["withdraw", "lost", "sent", "It had already started", true],
  ["withdraw", "lost", "skipped", "Not sending at its time", true],
  ["withdraw", "noFlag", "failed", "Zavi accepted the stop. Checking…", false],
  ["withdraw", "noFlag", "missing", "Zavi accepted the stop. Checking…", false],
  ["withdraw", "noFlag", "scheduled", "Still approved for its time", true],
  ["withdraw", "noFlag", "readyVetoed", "Not sending", true],
  ["withdraw", "refused", "none", "Could not stop it", true],
];

describe("planOpNotice / planOpResolved", () => {
  it.each(TABLE)("%s, answer %s, read %s -> %s (resolved %s)", (kind, answer, read, title, resolved) => {
    const op: PlanOp = { kind, requestId: kind === "schedule" ? "r1" : null, answer: ANSWERS[answer], ...(kind === "schedule" ? { intent: { variant: 2, schedule_gen: 1, content_version: 1 } } : {}) };
    expect(planOpNotice(op, READS[read])?.title ?? null).toBe(title);
    expect(planOpResolved(op, READS[read])).toBe(resolved);
  });

  it("only a read states an outcome: a fresh approval with no read yet says nothing, and a contradicting read wins", () => {
    const op: PlanOp = { kind: "schedule", requestId: "r1", answer: { ok: true, replayed: false } };
    expect(planOpNotice(op, undefined)).toBeNull();
    expect(planOpNotice(op, "failed")).toMatchObject({ refresh: true, title: "Zavi accepted the approval. Checking…" });
    expect(planOpNotice(op, READS.ready)).toMatchObject({ title: "Not approved", body: expect.stringContaining("no longer shows it") });
  });

  it("a stop confirmed by a read says what happens next; no pending action says nothing", () => {
    expect(planOpNotice({ kind: "withdraw", requestId: null }, READS.readyVetoed)).toEqual({ tone: "ok", title: "Not sending", body: DONT_SEND_LINE });
    expect(planOpNotice(null, READS.scheduled)).toBeNull();
    expect(planOpResolved(null, READS.ready)).toBe(true);
  });

  it("Q2: the server's answer merges into the pending action, keeping a resolved latched meanwhile; a replaced action ignores it", () => {
    const op = { kind: "schedule" as const, requestId: "r1", startSeq: 3, resolved: true };
    const answer = { ok: true as const, replayed: false };
    expect(withPlanOpAnswer(op, "schedule", 3, answer)).toEqual({ ...op, answer });
    const newer = { kind: "withdraw" as const, requestId: null, startSeq: 5 };
    expect(withPlanOpAnswer(newer, "schedule", 3, answer)).toBe(newer);
    expect(withPlanOpAnswer({ ...op, startSeq: 4 }, "schedule", 3, answer)).toEqual({ ...op, startSeq: 4 });
    expect(withPlanOpAnswer(null, "schedule", 3, answer)).toBeNull();
  });

  it("P2a: a resolved action stays resolved whatever a later read shows (its request id never becomes reusable)", () => {
    const op: PlanOp = { kind: "schedule", requestId: "r1", answer: { ok: true, replayed: false } };
    expect(planOpResolved(op, READS.scheduled)).toBe(true);
    expect(planOpResolved(op, "failed")).toBe(false);
    expect(planOpResolved({ ...op, resolved: true }, READS.ready)).toBe(true);
    expect(planOpResolved({ ...op, resolved: true }, "failed")).toBe(true);
  });

  it("fd9 #1: a request id belongs to one intent: another version or a newer plan is a different request", () => {
    const op: PlanOp = { kind: "schedule", requestId: "r1", intent: { variant: 1, schedule_gen: 2, content_version: 1 } };
    expect(sameIntent(op, "schedule", { variant: 1, schedule_gen: 2, content_version: 1 })).toBe(true);
    expect(sameIntent(op, "schedule", { variant: 2, schedule_gen: 2, content_version: 1 })).toBe(false);
    expect(sameIntent(op, "schedule", { variant: 1, schedule_gen: 3, content_version: 1 })).toBe(false);
    expect(sameIntent(op, "schedule", { variant: 1, schedule_gen: 2, content_version: 2 })).toBe(false);
    expect(sameIntent(op, "withdraw", undefined)).toBe(false);
  });

  it("fd9 #10: once an answered approval is over, its words say to approve again (a new request), not 'the same request'", () => {
    const n = planOpNotice({ kind: "schedule", requestId: "r1", answer: { ok: true, replayed: false } }, READS.ready);
    expect(n?.body).toContain("Approve it again");
    expect(n?.body).not.toContain("same request");
  });

  it("a started email says where it is: only sent says it went out", () => {
    const op: PlanOp = { kind: "schedule", requestId: "r1", answer: { ok: true, replayed: false }, intent: { variant: 2, schedule_gen: 1, content_version: 1 } };
    expect(planOpNotice(op, READS.sent)?.body).toBe("It went out at its planned time.");
    expect(planOpNotice(op, READS.sending)?.body).toBe("It is sending now.");
    expect(planOpNotice(op, READS.reconciling)?.body).toBe("Zavi is checking whether it went out.");
    expect(planOpNotice({ ...op, answer: undefined }, READS.sendingNewer)?.body).toBe("It is sending now. It is not what this approval asked for.");
  });
});
