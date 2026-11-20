import { describe, it, expect, vi } from "vitest";
import { buildRefineGoalGraph as refineGraph } from "@/services/agents/refine-product";
import { siteRepublishGraph } from "@/services/agents/refine-product";
import { loadUnpublishedSiteChanges, unpublishedSiteChanges, type SiteRunRow } from "../site-pending";
import type { SiteRow } from "../contract";

const SITE_ID = "f20600a6-0000-4000-8000-000000000001";
const TARGET = { github_full_name: "praxis-built/bakery", repo_url: "https://github.com/praxis-built/bakery", default_branch: "main" };
const SITE = {
  id: SITE_ID,
  hostname: "bakery.zaviagent.com",
  github_full_name: "praxis-built/bakery",
  root_conductor_run_id: "root-1",
} as unknown as SiteRow;

function editRun(id: string, at: string, stopAtPreview: boolean, status = "done"): SiteRunRow {
  const goal_graph = refineGraph({
    message: "Add a gluten-free badge",
    target: TARGET,
    parent_conductor_run_id: "root-1",
    prior_refines: [],
    remediation_attempt: null,
    source_suggestion_id: null,
    pre_refine_sha: null,
    chat_thread_id: null,
    direct_merge_enabled: true,
    site_id: SITE_ID,
    stop_at_preview: stopAtPreview,
  } as unknown as Parameters<typeof refineGraph>[0]);
  return { id, kind: "build_app", status, goal_graph, created_at: at, updated_at: at };
}

function publishRun(id: string, at: string, status = "done"): SiteRunRow {
  return { id, kind: "build_app", status, goal_graph: siteRepublishGraph(SITE, "abcdef1", { publish_request: true }), created_at: at, updated_at: at };
}

function undoRun(id: string, at: string, previewOnly: boolean): SiteRunRow {
  return {
    id,
    kind: "undo",
    status: "done",
    goal_graph: [{ id: "u", status: "done", payload: { stage: "undo", undo_claim: true, site_id: SITE_ID, ...(previewOnly ? { preview_only: true } : {}) } }],
    created_at: at,
    updated_at: at,
  };
}

describe("unpublishedSiteChanges: edit -> preview only -> Publish -> live", () => {
  it("an edit to a live site that stopped at the preview is waiting for Publish", () => {
    const rows = [publishRun("pub-1", "2026-10-02T10:00:00Z"), editRun("edit-1", "2026-10-02T11:00:00Z", true)];
    expect(unpublishedSiteChanges(rows).map((c) => c.id)).toEqual(["edit-1"]);
  });

  it("Publish takes every change that finished before it", () => {
    const rows = [
      publishRun("pub-1", "2026-10-02T10:00:00Z"),
      editRun("edit-1", "2026-10-02T11:00:00Z", true),
      undoRun("undo-1", "2026-10-02T11:30:00Z", true),
      publishRun("pub-2", "2026-10-02T12:00:00Z"),
    ];
    expect(unpublishedSiteChanges(rows)).toEqual([]);
  });

  it("a change after the last publish waits again; order of input rows does not matter", () => {
    const rows = [
      editRun("edit-2", "2026-10-02T13:00:00Z", true),
      publishRun("pub-2", "2026-10-02T12:00:00Z"),
      editRun("edit-1", "2026-10-02T11:00:00Z", true),
    ];
    expect(unpublishedSiteChanges(rows).map((c) => c.id)).toEqual(["edit-2"]);
  });

  it("a failed or still-running publish does not count as published", () => {
    for (const status of ["failed", "active", "provisioning"]) {
      const rows = [editRun("edit-1", "2026-10-02T11:00:00Z", true), publishRun("pub-x", "2026-10-02T12:00:00Z", status)];
      expect(unpublishedSiteChanges(rows).map((c) => c.id), status).toEqual(["edit-1"]);
    }
  });

  it("an edit that published by itself (setting off) and an unfinished edit are not waiting", () => {
    const rows = [editRun("edit-auto", "2026-10-02T11:00:00Z", false), editRun("edit-running", "2026-10-02T12:00:00Z", true, "active")];
    expect(unpublishedSiteChanges(rows)).toEqual([]);
  });

  it("a preview-only undo waits; an undo that republished does not", () => {
    const rows = [undoRun("undo-preview", "2026-10-02T11:00:00Z", true), undoRun("undo-live", "2026-10-02T12:00:00Z", false)];
    expect(unpublishedSiteChanges(rows)).toEqual([{ id: "undo-preview", kind: "undo", at: "2026-10-02T11:00:00Z" }]);
  });
});

describe("loadUnpublishedSiteChanges: the last finished publish, then what came after it", () => {
  type Reply = { data: Array<Record<string, unknown>>; error: { message: string } | null };
  function db(replies: Reply[]) {
    const queries: Array<Array<[string, unknown[]]>> = [];
    const client = {
      from: vi.fn(() => {
        const calls: Array<[string, unknown[]]> = [];
        queries.push(calls);
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "order", "gt"]) {
          q[m] = (...args: unknown[]) => {
            calls.push([m, args]);
            return q;
          };
        }
        q.limit = async (...args: unknown[]) => {
          calls.push(["limit", args]);
          return replies[queries.length - 1] ?? { data: [], error: null };
        };
        return q;
      }),
    };
    return { client, queries };
  }
  const EDIT_ROW = { id: "edit-1", kind: "build_app", status: "done", objective: "[refine] Add a gluten-free badge", created_at: "2026-10-02T11:00:00Z", updated_at: "2026-10-02T11:05:00Z", p_stage: "build", p_refine: "true", p_stop: "true", p_request: null };

  it("reads only this tenant's site, after its last finished publish, without pulling whole graphs", async () => {
    const { client, queries } = db([
      { data: [{ id: "pub-1", created_at: "2026-10-02T10:00:00Z" }], error: null },
      { data: [EDIT_ROW], error: null },
    ]);
    const out = await loadUnpublishedSiteChanges(client, "t-1", SITE_ID);
    expect(out).toEqual({ changes: [{ id: "edit-1", kind: "edit", at: "2026-10-02T11:05:00Z", message: "Add a gluten-free badge" }], capped: false });
    const [boundary, after] = queries;
    expect(boundary).toContainEqual(["eq", ["status", "done"]]);
    expect(boundary).toContainEqual(["eq", ["goal_graph->0->payload->>republish", "true"]]);
    for (const q of queries) {
      expect(q).toContainEqual(["eq", ["tenant_id", "t-1"]]);
      expect(q).toContainEqual(["eq", ["goal_graph->0->payload->>site_id", SITE_ID]]);
      expect(String(q.find((c) => c[0] === "select")?.[1][0])).not.toMatch(/(^|[ ,])goal_graph(,|$)/);
    }
    expect(after).toContainEqual(["gt", ["created_at", "2026-10-02T10:00:00Z"]]);
  });

  it("a site never published by a Publish run reads all its finished runs", async () => {
    const { client, queries } = db([{ data: [], error: null }, { data: [EDIT_ROW], error: null }]);
    expect((await loadUnpublishedSiteChanges(client, "t-1", SITE_ID)).changes.map((c) => c.id)).toEqual(["edit-1"]);
    expect(queries[1].some((c) => c[0] === "gt")).toBe(false);
  });

  it("an undo waiting for Publish names the change it took back", async () => {
    const UNDO_ROW = { id: "undo-1", kind: "undo", status: "done", objective: "[undo] revert abcdef1", created_at: "2026-10-02T12:00:00Z", updated_at: "2026-10-02T12:00:00Z", p_stage: "undo", p_undo: "true", p_preview_only: "true", p_parent: "edit-1" };
    const LONE_UNDO = { ...UNDO_ROW, id: "undo-2", p_parent: "published-earlier", created_at: "2026-10-02T13:00:00Z", updated_at: "2026-10-02T13:00:00Z" };
    const { client } = db([{ data: [], error: null }, { data: [EDIT_ROW, UNDO_ROW, LONE_UNDO], error: null }]);
    const out = await loadUnpublishedSiteChanges(client, "t-1", SITE_ID);
    expect(out.changes.map((c) => [c.id, c.kind, c.message])).toEqual([
      ["edit-1", "edit", "Add a gluten-free badge"],
      ["undo-1", "undo", "Undo: Add a gluten-free badge"],
      ["undo-2", "undo", null],
    ]);
  });

  it("a read error throws (the caller degrades), never reads as nothing pending", async () => {
    const boundaryDown = db([{ data: [], error: { message: "boom" } }]);
    await expect(loadUnpublishedSiteChanges(boundaryDown.client, "t-1", SITE_ID)).rejects.toThrow("boom");
    const afterDown = db([{ data: [], error: null }, { data: [], error: { message: "bang" } }]);
    await expect(loadUnpublishedSiteChanges(afterDown.client, "t-1", SITE_ID)).rejects.toThrow("bang");
  });
});
