import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ inserted: [] as unknown[], updated: [] as Array<{ values: unknown; eq: Array<[string, unknown]> }> }));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({
      insert: async (row: unknown) => {
        const dup = calls.inserted.some((r) => (r as { id: string }).id === (row as { id: string }).id);
        calls.inserted.push(row);
        return { error: dup ? { code: "23505", message: "duplicate key" } : null };
      },
      update: (values: unknown) => {
        const u = { values, eq: [] as Array<[string, unknown]> };
        calls.updated.push(u);
        const q = { eq: (c: string, v: unknown) => (u.eq.push([c, v]), Object.assign(Promise.resolve({ error: null }), q)) };
        return q;
      },
    }),
  }),
}));

import type { SiteRow } from "../contract";
import { realDirectTextDeps } from "../site-text-direct";
import { unpublishedSiteChanges } from "../site-pending";
import { directEditEnvelope } from "@/services/agents/refine-undo";

const SITE = { id: "s1", tenant_id: "t1", github_full_name: "o/r", root_conductor_run_id: "root" } as unknown as SiteRow;
const SHA = "b".repeat(40);

describe("direct edit change record (QA #3909: direct edits never reached the Publish list)", () => {
  it("is a pending edit as soon as it is reserved, and Undo-able once stamped", async () => {
    const deps = realDirectTextDeps();
    const id = "11111111-2222-4333-8444-555555555555";
    await deps.reserveChange({ tenant_id: "t1", id, site: SITE, label: "Applied 1 edit" });
    await expect(deps.reserveChange({ tenant_id: "t1", id, site: SITE, label: "Applied 1 edit" })).resolves.toBeUndefined();
    const row = calls.inserted[0] as { id: string; objective: string; status: string; kind: string; goal_graph: Array<{ payload: Record<string, unknown> }> };
    expect(row).toMatchObject({ objective: "[refine] Applied 1 edit", status: "done", kind: "build_app" });
    expect(unpublishedSiteChanges([{ ...row, created_at: "2026-10-07T20:18:57Z" }])).toEqual([{ id, kind: "edit", at: "2026-10-07T20:18:57Z" }]);

    await deps.finishChange({ tenant_id: "t1", id, site: SITE, label: "Applied 1 edit", commit_sha: SHA });
    const stamped = calls.updated[0]!;
    expect(stamped.eq).toEqual([["id", id]]);
    expect((stamped.values as { created_at?: string }).created_at).toEqual(expect.any(String));
    const graph = (stamped.values as { goal_graph: Array<{ payload: Record<string, unknown> }> }).goal_graph;
    expect(directEditEnvelope(graph as never).parsed).toEqual({ commit_sha: SHA, merged: true });
    expect(unpublishedSiteChanges([{ id, kind: "build_app", status: "done", goal_graph: graph, created_at: "2026-10-07T20:18:57Z" }])).toHaveLength(1);
  });
});
