import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    throw new Error("no db in this test");
  },
}));

import { approvalOf, latestApproved, timelineOf, withCardTimelines, type CardEvent } from "../card-timeline";
import { toActionView } from "../channel-actions";

const VIEWER = "user-viewer";
const OWNER = "user-owner";
const MATE = "user-mate";

const ev = (id: number, event: string, at: string, actor_kind = "founder", action_id = "a1"): CardEvent => ({ id, action_id, event, actor_kind, at });
const noName = () => null;

describe("approvalOf", () => {
  const approved = ev(2, "approved", "2026-10-20T10:06:00Z");

  it("the founder who reads the card is 'you'", () => {
    expect(approvalOf({ approved_by: VIEWER, approved_by_source: null }, approved, VIEWER, noName)).toEqual({ by: "you", name: null, at: approved.at });
  });

  it("Autopilot approves with the owner's id and source 'cgo': it reads 'autopilot', never 'you'", () => {
    expect(approvalOf({ approved_by: VIEWER, approved_by_source: "cgo" }, approved, VIEWER, noName)).toMatchObject({ by: "autopilot", name: null });
    expect(approvalOf({ approved_by: OWNER, approved_by_source: "cgo" }, approved, VIEWER, noName)).toMatchObject({ by: "autopilot", name: null });
  });

  it("a staff approval is Zavi's team", () => {
    expect(approvalOf({ approved_by: OWNER, approved_by_source: "staff" }, approved, VIEWER, () => "Staffer")).toMatchObject({ by: "zavi_team", name: null });
  });

  it("another person is a teammate, named when we have the name and null when we do not", () => {
    expect(approvalOf({ approved_by: MATE, approved_by_source: null }, approved, VIEWER, (id) => (id === MATE ? "Priya" : null))).toEqual({ by: "teammate", name: "Priya", at: approved.at });
    expect(approvalOf({ approved_by: MATE, approved_by_source: null }, approved, VIEWER, noName)).toEqual({ by: "teammate", name: null, at: approved.at });
  });

  it("no approved event: no approval line", () => {
    expect(approvalOf({ approved_by: VIEWER, approved_by_source: null }, null, VIEWER, noName)).toBeNull();
  });
});

describe("latestApproved", () => {
  it("is the newest approval (a re-approve after a failure), tie broken by id", () => {
    const events = [ev(1, "approved", "2026-10-20T09:00:00Z"), ev(5, "approved", "2026-10-20T11:00:00Z"), ev(3, "exec_failed", "2026-10-20T09:01:00Z"), ev(6, "approved", "2026-10-20T11:00:00Z")];
    expect(latestApproved(events)?.id).toBe(6);
    expect(latestApproved([ev(1, "proposed", "2026-10-20T09:00:00Z")])).toBeNull();
  });
});

describe("timelineOf", () => {
  it("orders proposed, approved, sent (from exec_claimed_at), executed; the latest approval carries who", () => {
    const events = [ev(4, "executed", "2026-10-20T10:07:00Z"), ev(1, "proposed", "2026-10-20T08:00:00Z", "channel_run"), ev(2, "approved", "2026-10-20T10:06:00Z")];
    const approval = { by: "you" as const, name: null, at: "2026-10-20T10:06:00Z" };
    expect(timelineOf(events, { exec_claimed_at: "2026-10-20T10:06:30Z" }, approval)).toEqual([
      { kind: "proposed", at: "2026-10-20T08:00:00Z" },
      { kind: "approved", at: "2026-10-20T10:06:00Z", by: "you" },
      { kind: "sent", at: "2026-10-20T10:06:30Z" },
      { kind: "executed", at: "2026-10-20T10:07:00Z" },
    ]);
  });

  it("an Autopilot approval says autopilot from its event, even an older one", () => {
    const events = [ev(2, "approved", "2026-10-20T10:00:00Z", "system"), ev(3, "exec_failed", "2026-10-20T10:01:00Z", "system"), ev(4, "approved", "2026-10-20T11:00:00Z")];
    const out = timelineOf(events, {}, { by: "you", name: null, at: "2026-10-20T11:00:00Z" });
    expect(out).toEqual([
      { kind: "approved", at: "2026-10-20T10:00:00Z", by: "autopilot" },
      { kind: "failed", at: "2026-10-20T10:01:00Z" },
      { kind: "approved", at: "2026-10-20T11:00:00Z", by: "you" },
    ]);
  });

  it("a refused change: failed, then refused at the close", () => {
    const events = [ev(2, "approved", "2026-10-20T10:00:00Z"), ev(3, "exec_failed", "2026-10-20T10:01:00Z", "system"), ev(4, "stale_flagged", "2026-10-20T10:01:00Z", "system")];
    const kinds = timelineOf(events, { exec_claimed_at: "2026-10-20T10:00:30Z", exec_bucket: "blocked_on_us" }, null).map((e) => e.kind);
    expect(kinds).toEqual(["approved", "sent", "failed", "refused"]);
  });

  it("a stale flag that is not a refusal is left out", () => {
    const events = [ev(2, "exec_failed", "2026-10-20T10:01:00Z"), ev(3, "stale_flagged", "2026-10-20T10:05:00Z")];
    expect(timelineOf(events, { exec_bucket: "temporary" }, null).map((e) => e.kind)).toEqual(["failed"]);
    expect(timelineOf([ev(3, "stale_flagged", "2026-10-20T10:05:00Z")], { exec_bucket: "blocked_on_us" }, null)).toEqual([]);
  });

  it("no events and no claim: an empty history", () => {
    expect(timelineOf([], {}, null)).toEqual([]);
  });
});

describe("withCardTimelines", () => {
  const view = (id: string, exec_status: string | null, exec_bucket: string | null = null) => ({ id, exec_status, exec_bucket, title: id });
  const rows = new Map([
    ["a1", { approved_by: VIEWER, approved_by_source: null, exec_claimed_at: "2026-10-20T10:06:30Z" }],
    ["a2", { approved_by: MATE, approved_by_source: null, exec_claimed_at: null }],
    ["a3", { approved_by: null, approved_by_source: null, exec_claimed_at: null }],
  ]);

  it("decorates executable cards only; a teammate is named; the wire carries no ids, notes or actor ids", async () => {
    const readEvents = vi.fn(async () => [
      { ...ev(1, "approved", "2026-10-20T10:06:00Z", "founder", "a1"), note: "secret note", actor_user_id: VIEWER } as CardEvent,
      ev(2, "approved", "2026-10-20T09:00:00Z", "founder", "a2"),
    ]);
    const readNames = vi.fn(async (_t: string, ids: string[]) => new Map(ids.map((i) => [i, i === MATE ? "Priya" : null])));
    const out = await withCardTimelines("t1", [view("a1", "dispatching"), view("a2", "executed"), view("a3", null)], rows, VIEWER, { readEvents, readNames });
    expect(readEvents).toHaveBeenCalledWith("t1", ["a1", "a2"]);
    expect(readNames).toHaveBeenCalledWith("t1", [MATE]);
    expect(out[0]).toMatchObject({ approval: { by: "you", name: null, at: "2026-10-20T10:06:00Z" }, exec_started_at: "2026-10-20T10:06:30Z" });
    expect(out[1]).toMatchObject({ approval: { by: "teammate", name: "Priya" }, exec_started_at: null });
    expect(out[2]).toEqual(view("a3", null));
    const wire = JSON.stringify(out);
    for (const leak of ["secret note", "actor_user_id", VIEWER, MATE, "approved_by", "exec_claimed_at"]) expect(wire).not.toContain(leak);
  });

  it("no executable card: nothing is read", async () => {
    const readEvents = vi.fn(async () => []);
    const views = [view("a3", null)];
    expect(await withCardTimelines("t1", views, rows, VIEWER, { readEvents })).toBe(views);
    expect(readEvents).not.toHaveBeenCalled();
  });

  it("fail-soft: an events read error serves the cards without approval or timeline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await withCardTimelines("t1", [view("a1", "executed")], rows, VIEWER, {
      readEvents: async () => {
        throw new Error("boom");
      },
    });
    warn.mockRestore();
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty("approval");
    expect(out[0]).not.toHaveProperty("timeline");
  });

  it("a failed name read only drops the name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await withCardTimelines("t1", [view("a2", "executed")], rows, VIEWER, {
      readEvents: async () => [ev(2, "approved", "2026-10-20T09:00:00Z", "founder", "a2")],
      readNames: async () => {
        throw new Error("auth down");
      },
    });
    warn.mockRestore();
    expect(out[0]).toMatchObject({ approval: { by: "teammate", name: null } });
  });
});

describe("toActionView strips the approval columns", () => {
  it("never serves approved_by, approved_by_source, exec_claimed_at or exec_result", () => {
    const v = toActionView(
      {
        id: "ca-1", channel_slug: "meta_ads", run_id: "run-1", position: 1, run_of: 1, blocking: false,
        action_type: "update_ad", title: "Raise the budget", body: {}, status: "acted", note: null,
        snoozed_until: null, impact: null, impact_reason: null, proposed_at: "2026-10-20T00:00:00Z",
        repeat_of: null, redo_of: null, exec_class: "meta_ads.set_status", exec_status: "executed",
        exec_result: { notice: "Paused ad set 120208 ✅" }, approved_by: VIEWER, approved_by_source: "cgo",
        exec_claimed_at: "2026-10-20T10:06:30Z", executed_at: "2026-10-20T10:07:00Z",
      } as never,
      1,
      {},
    );
    for (const k of ["approved_by", "approved_by_source", "exec_claimed_at", "exec_result"]) expect(v).not.toHaveProperty(k);
    expect(JSON.stringify(v)).not.toContain(VIEWER);
    expect(JSON.stringify(v)).not.toContain("120208");
    expect(v.executed_at).toBe("2026-10-20T10:07:00Z");
  });

  it("serves executed_at only on an executed card", () => {
    const v = toActionView(
      {
        id: "ca-2", channel_slug: "meta_ads", run_id: "run-1", position: 1, run_of: 1, blocking: false,
        action_type: "update_ad", title: "t", body: {}, status: "pending", note: null, snoozed_until: null,
        impact: null, impact_reason: null, proposed_at: "2026-10-20T00:00:00Z", repeat_of: null, redo_of: null,
        exec_class: "meta_ads.set_status", exec_status: "dispatching", executed_at: "2026-10-20T10:07:00Z",
      } as never,
      1,
      {},
    );
    expect(v).not.toHaveProperty("executed_at");
  });
});
