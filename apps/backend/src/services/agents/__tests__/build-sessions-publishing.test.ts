import { describe, it, expect } from "vitest";
import { groupBuildSessions, sessionPublishStatusOf, sessionStateOf, SESSION_RUN_SELECT, type SessionRunRow } from "../build-sessions";

const base = {
  objective: "Build product: Acme — a CRM",
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
  refine_mode: null,
  parent_id: null,
  p0_stage: "provision",
  p0_status: "done",
};

function row(over: Partial<SessionRunRow>): SessionRunRow {
  return { id: "a", status: "active", ...base, ...over } as SessionRunRow;
}

const buildDoneAt3 = { g3_stage: "build", g3_status: "done", g4_stage: "deploy", g4_status: "pending" };
const buildDoneAt5 = {
  g3_stage: "scaffold",
  g3_status: "done",
  g4_stage: "preview",
  g4_status: "done",
  g5_stage: "build",
  g5_status: "done",
  g6_stage: "deploy",
  g6_status: "pending",
};

describe("sessionStateOf — publishing states", () => {
  it("active fresh build with build node done → publishing", () => {
    expect(sessionStateOf(row({ status: "active", ...buildDoneAt3 }))).toBe("publishing");
  });

  it("finds the build node at a later index (preview stage in the graph)", () => {
    expect(sessionStateOf(row({ status: "active", ...buildDoneAt5 }))).toBe("publishing");
  });

  it("active with build still running → building", () => {
    expect(sessionStateOf(row({ status: "active", g3_stage: "build", g3_status: "dispatched" }))).toBe("building");
  });

  it("paused with deploy_failed after build done → publish_failed", () => {
    expect(sessionStateOf(row({ status: "paused", failure_class: "deploy_failed", ...buildDoneAt3 }))).toBe(
      "publish_failed",
    );
  });

  it("failed with acceptance_failed after build done → publish_failed", () => {
    expect(sessionStateOf(row({ status: "failed", failure_class: "acceptance_failed", ...buildDoneAt3 }))).toBe(
      "publish_failed",
    );
  });

  it("paused with a non-publish class after build done → failed (unchanged)", () => {
    expect(sessionStateOf(row({ status: "paused", failure_class: "budget_halted", ...buildDoneAt3 }))).toBe("failed");
  });

  it("paused deploy_failed but build node NOT done → failed", () => {
    expect(
      sessionStateOf(row({ status: "paused", failure_class: "deploy_failed", g3_stage: "build", g3_status: "failed" })),
    ).toBe("failed");
  });

  it("done → ready, cancelled → failed, active w/o slot columns → building (unchanged)", () => {
    expect(sessionStateOf(row({ status: "done", ...buildDoneAt3 }))).toBe("ready");
    expect(sessionStateOf(row({ status: "cancelled", ...buildDoneAt3 }))).toBe("failed");
    expect(sessionStateOf(row({ status: "active" }))).toBe("building");
  });
});

describe("sessionStateOf — agrees with the build-status pane", () => {
  it("paused with the deploy node failed on another class (dispatch_failed) → publish_failed", () => {
    expect(
      sessionStateOf(row({ status: "paused", failure_class: "dispatch_failed", g3_stage: "build", g3_status: "done", g4_stage: "deploy", g4_status: "failed" })),
    ).toBe("publish_failed");
  });

  it("save-then-status gap: active with deploy node done → publishing, not building", () => {
    expect(sessionStateOf(row({ status: "active", g3_stage: "build", g3_status: "done", g4_stage: "deploy", g4_status: "done" }))).toBe("publishing");
  });

  it("save-then-status gap: active with deploy node failed → publishing", () => {
    expect(sessionStateOf(row({ status: "active", g3_stage: "build", g3_status: "done", g4_stage: "deploy", g4_status: "failed" }))).toBe("publishing");
  });

  it("finds the deploy node in slot 6 (repo_analysis + preview stages)", () => {
    expect(
      sessionStateOf(
        row({ status: "paused", failure_class: "budget_halted", ...buildDoneAt5, g6_stage: "deploy", g6_status: "failed" }),
      ),
    ).toBe("publish_failed");
  });

  it("active, build done, no deploy node → building (nothing to publish)", () => {
    expect(sessionStateOf(row({ status: "active", g3_stage: "build", g3_status: "done" }))).toBe("building");
  });
});

describe("groupBuildSessions — publishing sessions", () => {
  it("a superseded session never shows publishing / publish_failed", () => {
    const { sessions } = groupBuildSessions([
      row({ id: "a", status: "active", ...buildDoneAt3, created_at: "2026-09-01T10:00:00Z" }),
      row({ id: "b", status: "paused", failure_class: "deploy_failed", ...buildDoneAt3, created_at: "2026-09-02T10:00:00Z" }),
      row({ id: "c", status: "active", g3_stage: "build", g3_status: "dispatched", created_at: "2026-09-03T10:00:00Z" }),
    ]);
    const byId = new Map(sessions.map((s) => [s.id, s.state]));
    expect(byId.get("a")).toBe("building");
    expect(byId.get("b")).toBe("failed");
    expect(byId.get("c")).toBe("building");
  });

  it("surfaces publishing and publish_failed on the current session row", () => {
    const failed = groupBuildSessions([
      row({ id: "a", status: "active", ...buildDoneAt3, created_at: "2026-09-01T10:00:00Z" }),
      row({ id: "b", status: "paused", failure_class: "deploy_failed", ...buildDoneAt3, created_at: "2026-09-02T10:00:00Z" }),
    ]);
    expect(failed.sessions.find((s) => s.id === "b")?.state).toBe("publish_failed");
    const publishing = groupBuildSessions([
      row({ id: "a", status: "paused", failure_class: "deploy_failed", ...buildDoneAt3, created_at: "2026-09-01T10:00:00Z" }),
      row({ id: "b", status: "active", ...buildDoneAt3, created_at: "2026-09-02T10:00:00Z" }),
    ]);
    expect(publishing.sessions.find((s) => s.id === "b")?.state).toBe("publishing");
  });

  it("a busy refine still flips a ready session to building but never masks publishing", () => {
    const { sessions } = groupBuildSessions([
      row({ id: "a", status: "done", ...buildDoneAt3 }),
      row({ id: "r", status: "active", refine_mode: "true", parent_id: "a", created_at: "2026-09-01T11:00:00Z" }),
      row({ id: "b", status: "active", ...buildDoneAt3, created_at: "2026-09-02T10:00:00Z" }),
      row({ id: "r2", status: "active", refine_mode: "true", parent_id: "b", created_at: "2026-09-02T11:00:00Z" }),
    ]);
    const byId = new Map(sessions.map((s) => [s.id, s.state]));
    expect(byId.get("a")).toBe("building");
    expect(byId.get("b")).toBe("publishing");
  });

  it("the list select reads the columns the publishing state needs", () => {
    for (const col of ["failure_class", "g3_status:goal_graph->3->>status", "g5_stage:goal_graph->5->payload->>stage", "g6_status:goal_graph->6->>status"]) {
      expect(SESSION_RUN_SELECT).toContain(col);
    }
    expect(SESSION_RUN_SELECT).not.toMatch(/(^|,\s*)goal_graph(\s*,|$)/);
  });
});

const SITE = "aaaaaaaa-0000-4000-8000-000000000001";
const buildOnly = { g3_stage: "build", g3_status: "done" };
const markerPlacements: Array<[string, Partial<SessionRunRow>]> = [
  ["every node", { s0: SITE, s1: SITE, s2: SITE }],
  ["provision and build nodes", { s0: SITE, s1: SITE, s2: null }],
  ["the build node only", { s0: null, s1: SITE, s2: null }],
  ["slot 0 only", { s0: SITE, s1: null, s2: null }],
  ["slot 2 only", { s0: null, s1: null, s2: SITE }],
  ["an upper-case id", { s0: null, s1: SITE.toUpperCase(), s2: null }],
];
const noMarker: Array<[string, Partial<SessionRunRow>]> = [
  ["no marker columns", {}],
  ["null markers", { s0: null, s1: null, s2: null }],
  ["blank markers", { s0: "", s1: "   ", s2: "" }],
];

describe("sessionPublishStatusOf: a preview-only site build was never published", () => {
  it.each(markerPlacements)("done, provision and build slots only, site marker on %s: ready, publish none", (_label, markers) => {
    const preview = row({ status: "done", ...buildOnly, ...markers });
    expect(sessionStateOf(preview)).toBe("ready");
    expect(sessionPublishStatusOf(preview)).toBe("none");
  });

  it("the site marker changes the publish status of exactly one shape: done, build done, no deploy slot", () => {
    const statuses = ["provisioning", "active", "paused", "failed", "halted", "cancelled", "canceled", "done"];
    const classes = [null, "deploy_failed", "acceptance_failed", "budget_halted", "dispatch_failed", "provision_failed"];
    const shapes: Array<Partial<SessionRunRow>> = [
      {},
      { g3_stage: "build", g3_status: "dispatched" },
      { g3_stage: "build", g3_status: "failed" },
      buildOnly,
      { ...buildOnly, g4_stage: "deploy", g4_status: "pending" },
      { ...buildOnly, g4_stage: "deploy", g4_status: "done" },
      { ...buildOnly, g4_stage: "deploy", g4_status: "failed" },
      { g3_stage: "scaffold", g3_status: "done", g4_stage: "preview", g4_status: "done", g5_stage: "build", g5_status: "done" },
      buildDoneAt5,
    ];
    const changed: string[] = [];
    let compared = 0;
    for (const status of statuses) {
      for (const failure_class of classes) {
        for (const shape of shapes) {
          const plain = row({ status, failure_class, ...shape });
          const marked = row({ status, failure_class, ...shape, s0: SITE, s1: SITE });
          compared += 1;
          expect(sessionStateOf(marked)).toBe(sessionStateOf(plain));
          const before = sessionPublishStatusOf(plain);
          const after = sessionPublishStatusOf(marked);
          if (before === after) continue;
          changed.push(`${status}|${failure_class}|${Object.keys(shape).join(",")}|${before}>${after}`);
        }
      }
    }
    expect(compared).toBe(statuses.length * classes.length * shapes.length);
    expect(changed.sort()).toEqual(
      classes
        .flatMap((failure_class) => [
          `done|${failure_class}|g3_stage,g3_status|live>none`,
          `done|${failure_class}|g3_stage,g3_status,g4_stage,g4_status,g5_stage,g5_status|live>none`,
        ])
        .sort(),
    );
  });

  it("guard: a done site build whose graph has a deploy slot still derives live", () => {
    for (const [, markers] of markerPlacements) {
      for (const deployStatus of ["done", "pending", "failed"]) {
        const published = row({ status: "done", ...buildOnly, g4_stage: "deploy", g4_status: deployStatus, ...markers });
        expect(sessionStateOf(published)).toBe("ready");
        expect(sessionPublishStatusOf(published)).toBe("live");
      }
    }
    expect(sessionPublishStatusOf(row({ status: "done", ...buildDoneAt5, s0: SITE, s1: SITE, s2: SITE }))).toBe("live");
  });

  it.each(noMarker)("guard: an old-flow done build with %s still derives live, with or without a deploy slot", (_label, markers) => {
    const noDeploy = row({ status: "done", ...buildOnly, ...markers });
    expect(sessionStateOf(noDeploy)).toBe("ready");
    expect(sessionPublishStatusOf(noDeploy)).toBe("live");
    const deployed = row({ status: "done", ...buildDoneAt3, ...markers });
    expect(sessionStateOf(deployed)).toBe("ready");
    expect(sessionPublishStatusOf(deployed)).toBe("live");
  });

  it("guard: in-progress and failed runs map to the same session states and publish statuses, site or not", () => {
    const cases: Array<[Partial<SessionRunRow>, string, string]> = [
      [{ status: "active" }, "building", "none"],
      [{ status: "provisioning" }, "building", "none"],
      [{ status: "active", g3_stage: "build", g3_status: "dispatched" }, "building", "none"],
      [{ status: "active", ...buildOnly }, "building", "none"],
      [{ status: "active", ...buildDoneAt3 }, "publishing", "publishing"],
      [{ status: "active", ...buildDoneAt5 }, "publishing", "publishing"],
      [{ status: "active", ...buildOnly, g4_stage: "deploy", g4_status: "failed" }, "publishing", "publishing"],
      [{ status: "paused", failure_class: "deploy_failed", ...buildDoneAt3 }, "publish_failed", "failed"],
      [{ status: "failed", failure_class: "acceptance_failed", ...buildDoneAt3 }, "publish_failed", "failed"],
      [{ status: "paused", failure_class: "dispatch_failed", ...buildOnly, g4_stage: "deploy", g4_status: "failed" }, "publish_failed", "failed"],
      [{ status: "paused", failure_class: "deploy_failed", ...buildOnly }, "publish_failed", "failed"],
      [{ status: "paused", failure_class: "budget_halted", ...buildDoneAt3 }, "failed", "none"],
      [{ status: "paused", failure_class: "deploy_failed", g3_stage: "build", g3_status: "failed" }, "failed", "none"],
      [{ status: "failed", failure_class: "provision_failed" }, "failed", "none"],
      [{ status: "halted", ...buildDoneAt3 }, "failed", "none"],
      [{ status: "cancelled", ...buildDoneAt3 }, "failed", "none"],
      [{ status: "canceled", ...buildOnly }, "failed", "none"],
    ];
    for (const [over, state, publish] of cases) {
      for (const markers of [{}, { s0: SITE, s1: SITE }, { s0: SITE, s1: SITE, s2: SITE }]) {
        const r = row({ ...over, ...markers });
        expect([JSON.stringify(over), sessionStateOf(r), sessionPublishStatusOf(r)]).toEqual([JSON.stringify(over), state, publish]);
      }
    }
  });

  it("guard: the shape a site build has today (build at graph index 1, outside the slots) is ready and none", () => {
    const real = row({ status: "done", p0_stage: "provision", p0_status: "done", p1_stage: "build", p1_status: "done", s0: SITE, s1: SITE, s2: null });
    expect(sessionStateOf(real)).toBe("ready");
    expect(sessionPublishStatusOf(real)).toBe("none");
  });

  it("guard: a site refine is never an app-ready root, so it derives none", () => {
    const edit = row({ status: "done", refine_mode: "true", parent_id: "a", ...buildOnly, s0: SITE });
    expect(sessionPublishStatusOf(edit)).toBe("none");
  });

  it("guard: History keeps every site session state it had, across a workspace with old-flow and site builds", () => {
    const { sessions } = groupBuildSessions([
      row({ id: "old", status: "done", ...buildDoneAt3, created_at: "2026-09-01T10:00:00Z" }),
      row({ id: "preview", status: "done", ...buildOnly, s0: SITE, s1: SITE, created_at: "2026-09-02T10:00:00Z" }),
      row({ id: "edit", status: "active", refine_mode: "true", parent_id: "preview", s0: SITE, created_at: "2026-09-02T11:00:00Z" }),
      row({ id: "site-b", status: "paused", failure_class: "deploy_failed", ...buildDoneAt3, s0: "bbbbbbbb-0000-4000-8000-000000000002", s1: "bbbbbbbb-0000-4000-8000-000000000002", created_at: "2026-09-03T10:00:00Z" }),
    ]);
    const byId = new Map(sessions.map((s) => [s.id, s.state]));
    expect(byId.get("old")).toBe("ready");
    expect(byId.get("preview")).toBe("building");
    expect(byId.get("site-b")).toBe("publish_failed");
  });
});
