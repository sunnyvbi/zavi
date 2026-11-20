import { describe, expect, it } from "vitest";
import {
  buildRequestFromObjective,
  buildSessionTitle,
  groupBuildSessions,
  refineIdsForSession,
  type SessionRunRow,
} from "../build-sessions";

function fresh(
  id: string,
  created_at: string,
  status = "done",
  objective = `Build product: Acme — a customer CRM with deals and contacts`,
): SessionRunRow {
  return { id, objective, status, created_at, updated_at: created_at };
}

function refine(
  id: string,
  created_at: string,
  status = "done",
  parent_id: string | null = null,
): SessionRunRow {
  return {
    id,
    objective: "[refine] make the header sticky",
    status,
    created_at,
    updated_at: created_at,
    refine_mode: "true",
    parent_id,
  };
}

describe("buildSessionTitle", () => {
  it("drops the build-product prefix and the company name", () => {
    expect(
      buildSessionTitle("Build product: Acme — a customer CRM with deals"),
    ).toBe("Customer CRM with deals");
  });

  it("strips a conversational lead-in", () => {
    expect(buildSessionTitle("Build product: X — please build me an analytics dashboard for sales")).toBe(
      "Analytics dashboard for sales",
    );
    expect(buildSessionTitle("Build product: X — I want to create a landing page. It should be fast.")).toBe(
      "Landing page",
    );
  });

  it("decodes escaped entities and keeps a long clause whole", () => {
    expect(buildSessionTitle("Build product: X — Q&amp;A portal")).toBe("Q&A portal");
    const long = `Build product: X — ${"customer onboarding ".repeat(6)}flow`;
    const title = buildSessionTitle(long);
    expect(title).toBe(`Customer onboarding ${"customer onboarding ".repeat(5)}flow`);
    expect(title.endsWith("…")).toBe(false);
  });

  it("never returns an empty title", () => {
    expect(buildSessionTitle(null)).toBe("Untitled build");
    expect(buildSessionTitle("Build product: X — ")).toBe("Untitled build");
  });

  it("keeps the request readable when the idea contains a dash", () => {
    expect(buildRequestFromObjective("Build product: Acme — a to-do app — fast")).toBe(
      "a to-do app — fast",
    );
  });
});

describe("groupBuildSessions", () => {
  it("returns one session per fresh build, newest activity first", () => {
    const rows = [
      fresh("b1", "2026-09-01T10:00:00Z"),
      fresh("b2", "2026-09-02T10:00:00Z"),
    ];
    const { sessions, current_session_id } = groupBuildSessions(rows);
    expect(sessions.map((s) => s.id)).toEqual(["b2", "b1"]);
    expect(current_session_id).toBe("b2");
    expect(sessions[0].is_current).toBe(true);
    expect(sessions[1].is_current).toBe(false);
  });

  it("attributes explicit-parent refines to their session and bumps activity", () => {
    const rows = [
      fresh("b1", "2026-09-01T10:00:00Z"),
      fresh("b2", "2026-09-02T10:00:00Z"),
      refine("r1", "2026-09-03T10:00:00Z", "done", "b1"),
    ];
    const { sessions } = groupBuildSessions(rows);
    expect(sessions.map((s) => s.id)).toEqual(["b1", "b2"]);
    expect(sessions[0].refine_count).toBe(1);
    expect(sessions[0].last_activity_at).toBe("2026-09-03T10:00:00Z");
    expect(sessions[1].refine_count).toBe(0);
  });

  it("attributes legacy parent-less refines to the preceding fresh build", () => {
    const rows = [
      fresh("b1", "2026-09-01T10:00:00Z"),
      refine("r1", "2026-09-01T11:00:00Z"),
      fresh("b2", "2026-09-02T10:00:00Z"),
      refine("r2", "2026-09-02T11:00:00Z"),
    ];
    expect(refineIdsForSession(rows, "b1")).toEqual(["r1"]);
    expect(refineIdsForSession(rows, "b2")).toEqual(["r2"]);
  });

  it("derives building / ready / failed state, with an in-flight refine as building", () => {
    const rows = [
      fresh("b1", "2026-09-01T10:00:00Z", "failed"),
      fresh("b2", "2026-09-02T10:00:00Z", "active"),
      fresh("b3", "2026-09-03T10:00:00Z", "done"),
      refine("r1", "2026-09-03T11:00:00Z", "active", "b3"),
    ];
    const byId = new Map(groupBuildSessions(rows).sessions.map((s) => [s.id, s]));
    expect(byId.get("b1")?.state).toBe("failed");
    expect(byId.get("b2")?.state).toBe("building");
    expect(byId.get("b3")?.state).toBe("building");
  });

  it("ignores a refine whose parent is unknown and never creates a session for it", () => {
    const rows = [refine("r0", "2026-08-31T10:00:00Z"), fresh("b1", "2026-09-01T10:00:00Z")];
    const { sessions } = groupBuildSessions(rows);
    expect(sessions.map((s) => s.id)).toEqual(["b1"]);
  });
});

describe("a paused build is stopped, never building (checkpoint model)", () => {
  it("maps paused to the stopped state", () => {
    const rows = [{ ...fresh("b1", "2026-09-01T10:00:00Z"), status: "paused" }];
    const { sessions } = groupBuildSessions(rows);
    expect(sessions[0].state).toBe("failed");
  });
});

describe("a build that failed at provisioning never replaced the live app", () => {
  const bakery = fresh("bakery", "2026-10-01T08:41:00Z");
  const provFailed = (id: string, at: string): SessionRunRow => ({
    ...fresh(id, at, "failed", "Build product: Bakery — a biscuit shop landing page"),
    failure_class: "provision_failed",
  });

  it("keeps the live app current, editable and not replaced, and its later chat edits stay on it", () => {
    const rows = [
      bakery,
      provFailed("biscuit1", "2026-10-01T11:45:00Z"),
      provFailed("biscuit2", "2026-10-01T11:49:00Z"),
      refine("edit1", "2026-10-01T12:40:00Z"),
    ];
    const { sessions, refineSession } = groupBuildSessions(rows, { markReplaced: true });
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    expect(byId.bakery.is_current).toBe(true);
    expect(byId.bakery.state).toBe("ready");
    expect(byId.bakery.refine_count).toBe(1);
    expect(refineSession.get("edit1")).toBe("bakery");
    expect(byId.biscuit1.is_current).toBe(false);
    expect(byId.biscuit2.is_current).toBe(true);
    expect(byId.biscuit2.state).toBe("failed");
  });

  it("a later build that got past provisioning still replaces it, even when cancelled", () => {
    const rows = [
      bakery,
      provFailed("biscuit1", "2026-10-01T11:45:00Z"),
      { ...fresh("biscuit3", "2026-10-01T12:03:00Z", "failed"), failure_class: "user_cancelled", p0_stage: "provision", p0_status: "done" },
    ];
    const { sessions } = groupBuildSessions(rows, { markReplaced: true });
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    expect(byId.bakery.is_current).toBe(false);
    expect(byId.bakery.state).toBe("replaced");
    expect(byId.biscuit3.is_current).toBe(true);
    expect(byId.biscuit1.is_current).toBe(false);
  });

  it.each(["user_cancelled", "stale_reaped", "unknown"])(
    "a later build stopped as %s with no sign it got past provisioning leaves the live app current and not replaced",
    (failure_class) => {
      const rows = [
        bakery,
        { ...fresh("biscuit3", "2026-10-01T12:03:00Z", "failed"), failure_class },
        refine("edit1", "2026-10-01T12:40:00Z"),
      ];
      const { sessions, refineSession } = groupBuildSessions(rows, { markReplaced: true });
      const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
      expect(byId.bakery.is_current).toBe(true);
      expect(byId.bakery.state).toBe("ready");
      expect(refineSession.get("edit1")).toBe("bakery");
      expect(byId.biscuit3.state).toBe("failed");
    },
  );

  it("a provision node that is pending or failed is not evidence; done at slot 1 behind repo analysis is", () => {
    const stopped = (p: Partial<SessionRunRow>): SessionRunRow[] => [
      bakery,
      { ...fresh("biscuit3", "2026-10-01T12:03:00Z", "failed"), failure_class: "stale_reaped", ...p },
    ];
    const state = (p: Partial<SessionRunRow>) =>
      groupBuildSessions(stopped(p), { markReplaced: true }).sessions.find((s) => s.id === "bakery")?.state;
    expect(state({ p0_stage: "provision", p0_status: "pending" })).toBe("ready");
    expect(state({ p0_stage: "provision", p0_status: "failed" })).toBe("ready");
    expect(state({ p0_stage: "spec", p0_status: "done" })).toBe("ready");
    expect(state({ p0_stage: "repo_analysis", p0_status: "done", p1_stage: "provision", p1_status: "done" })).toBe("replaced");
  });
});

describe("History titles and order (QA B36)", () => {
  it("titles a build by its first clause, not the whole prompt", () => {
    expect(
      buildSessionTitle(
        "Build product: Apna Tutor — Build a website for Mile High Coffee, a coffee shop in Denver: menu, prices and opening hours.",
      ),
    ).toBe("Website for Mile High Coffee");
    expect(
      buildSessionTitle("Build product: Apna Tutor — A simple booking website for a bike repair shop: list services"),
    ).toBe("Simple booking website for a bike repair shop");
  });

  it("uses a name the request gives, but not a word after 'named'", () => {
    expect(
      buildSessionTitle(
        "Build product: Apna Tutor — Build me a website for a dog grooming business in Austin called Lucky Paws Grooming. Show services.",
      ),
    ).toBe("Lucky Paws Grooming");
    expect(buildSessionTitle("Build product: X — a blog named after my grandmother")).toBe(
      "Blog named after my grandmother",
    );
  });

  it("last_request_at moves on a requested change, never on a status write", () => {
    const rows: SessionRunRow[] = [
      { ...fresh("b1", "2026-10-01T11:55:00Z"), updated_at: "2026-10-01T12:11:00Z" },
      { ...refine("r1", "2026-10-01T12:05:00Z", "done", "b1"), updated_at: "2026-10-01T12:20:00Z" },
      { ...fresh("b2", "2026-10-01T12:00:00Z"), updated_at: "2026-10-01T12:30:00Z" },
    ];
    const byId = new Map(groupBuildSessions(rows).sessions.map((s) => [s.id, s]));
    expect(byId.get("b1")?.last_request_at).toBe("2026-10-01T12:05:00Z");
    expect(byId.get("b1")?.last_activity_at).toBe("2026-10-01T12:20:00Z");
    expect(byId.get("b2")?.last_request_at).toBe("2026-10-01T12:00:00Z");
  });

  it("an unstamped refine guessed onto the old app does not move it once sites exist", () => {
    const rows: SessionRunRow[] = [
      fresh("old", "2026-09-30T22:37:00Z"),
      { ...fresh("site", "2026-10-01T11:55:00Z"), s0: "e0000000-0000-4000-8000-000000000001" },
      refine("orphan", "2026-10-01T12:15:00Z"),
    ];
    const byId = new Map(groupBuildSessions(rows).sessions.map((s) => [s.id, s]));
    expect(byId.get("old")?.refine_count).toBe(1);
    expect(byId.get("old")?.last_request_at).toBe("2026-09-30T22:37:00Z");
  });

  it("an old-flow-only workspace still counts an unstamped refine as a request", () => {
    const rows: SessionRunRow[] = [fresh("old", "2026-09-30T22:37:00Z"), refine("r", "2026-10-01T12:15:00Z")];
    expect(groupBuildSessions(rows).sessions[0].last_request_at).toBe("2026-10-01T12:15:00Z");
  });
});
