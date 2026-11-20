
import { describe, it, expect } from "vitest";
import { groupBuildSessions, SESSION_RUN_SELECT, type SessionRunRow } from "@/services/agents/build-sessions";
import { SITE_MARKER_SELECT } from "@/services/sites/site-run";

const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "bbbbbbbb-0000-4000-8000-000000000002";
let minute = 0;
const at = () => new Date(Date.UTC(2026, 8, 1, 10, (minute += 1))).toISOString();

function row(id: string, o: { refine?: boolean; parent?: string; site?: string; status?: string } = {}): SessionRunRow {
  const t = at();
  return {
    id,
    objective: o.refine ? `[refine] ${id}` : `Build product: Co — ${id}`,
    status: o.status ?? "done",
    created_at: t,
    updated_at: t,
    refine_mode: o.refine ? "true" : null,
    parent_id: o.parent ?? null,
    s0: o.site ?? null,
    s1: o.site ?? null,
    s2: o.site ?? null,
  };
}

describe("groupBuildSessions with new-flow sites", () => {
  it("projects the site marker columns", () => {
    expect(SESSION_RUN_SELECT).toContain(SITE_MARKER_SELECT);
  });

  it("an old-flow parent-less refine after 30 site builds is attributed to the old build", () => {
    const rows = [row("old-1")];
    for (let i = 0; i < 30; i++) rows.push(row(`site-${i}`, { site: i % 2 ? SA : SB }));
    rows.push(row("legacy-edit", { refine: true }));
    const { sessions, refineSession } = groupBuildSessions(rows);
    expect(refineSession.get("legacy-edit")).toBe("old-1");
    expect(sessions.find((s) => s.id === "old-1")?.refine_count).toBe(1);
  });

  it("publishing a never-edited site is not a change: the card counts 0, then 1 after a real edit", () => {
    expect(SESSION_RUN_SELECT).toContain("republish:goal_graph->0->payload->>republish");
    const publish = { ...row("publish-1", { refine: true, parent: "site-a", site: SA }), republish: "true" };
    const first = groupBuildSessions([row("site-a", { site: SA }), publish]);
    expect(first.refineSession.get("publish-1")).toBe("site-a");
    expect(first.sessions.find((x) => x.id === "site-a")?.refine_count).toBe(0);
    const edited = groupBuildSessions([row("site-a", { site: SA }), publish, row("edit-a", { refine: true, parent: "site-a", site: SA })]);
    expect(edited.sessions.find((x) => x.id === "site-a")?.refine_count).toBe(1);
  });

  it("a parent-less site refine lands on its own site's root, not the latest build", () => {
    const rows = [row("site-a", { site: SA }), row("site-b", { site: SB }), row("edit-a", { refine: true, site: SA })];
    expect(groupBuildSessions(rows).refineSession.get("edit-a")).toBe("site-a");
  });

  it("the latest old build stays current for the singleton app, and each site root is current for its own site", () => {
    const rows = [row("old-1"), row("old-2"), row("site-a", { site: SA }), row("site-b", { site: SB })];
    const { sessions, current_session_id } = groupBuildSessions(rows);
    const current = sessions.filter((s) => s.is_current).map((s) => s.id).sort();
    expect(current).toEqual(["old-2", "site-a", "site-b"]);
    expect(current_session_id).toBe("site-b");
  });

  it("old-flow-only history is unchanged: the newest root is the one current session", () => {
    const rows = [row("old-1"), row("e1", { refine: true }), row("old-2"), row("e2", { refine: true })];
    const { sessions, refineSession, current_session_id } = groupBuildSessions(rows);
    expect(sessions.filter((s) => s.is_current).map((s) => s.id)).toEqual(["old-2"]);
    expect(current_session_id).toBe("old-2");
    expect(refineSession.get("e1")).toBe("old-1");
    expect(refineSession.get("e2")).toBe("old-2");
  });
});
