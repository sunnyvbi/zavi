import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { tenant_id: string; resource_kind: string; status: string; external_ref: Record<string, unknown> };

const db = vi.hoisted(() => ({ rows: [] as Row[], updates: [] as Array<{ filters: Record<string, string>; patch: Record<string, unknown> }> }));

vi.mock("@/services/supabase", () => {
  const client = {
    from(table: string) {
      if (table !== "tenant_resources") throw new Error(`unexpected table ${table}`);
      const filters: Record<string, string> = {};
      let patch: Record<string, unknown> | null = null;
      const match = () => db.rows.filter((r) => Object.entries(filters).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v));
      const q = {
        select: () => q,
        update: (p: Record<string, unknown>) => {
          patch = p;
          return q;
        },
        eq: (k: string, v: string) => {
          filters[k] = v;
          return q;
        },
        maybeSingle: async () => {
          const rows = match();
          if (rows.length > 1) return { data: null, error: { message: "multiple rows" } };
          return { data: rows[0] ? JSON.parse(JSON.stringify(rows[0])) : null, error: null };
        },
        then: (resolve: (v: { error: null }) => void) => {
          if (patch) {
            db.updates.push({ filters: { ...filters }, patch });
            for (const r of match()) Object.assign(r, JSON.parse(JSON.stringify(patch)));
          }
          resolve({ error: null });
        },
      };
      return q;
    },
  };
  return { serviceClient: () => client };
});

import { readStaticState, writeStaticState, type StaticState } from "../static-publish";

const live: StaticState = { status: "live", sha: "abc1234", deploy_id: "d1", at: "2026-09-29T00:00:00.000Z" };

describe("static state on the hosting resource row", () => {
  beforeEach(() => {
    db.updates = [];
    db.rows = [
      { tenant_id: "A", resource_kind: "hosting", status: "ready", external_ref: { render_service_id: "srv-a", url: "https://a.onrender.com" } },
      { tenant_id: "A", resource_kind: "repo", status: "ready", external_ref: { github_full_name: "o/a" } },
      { tenant_id: "B", resource_kind: "hosting", status: "ready", external_ref: { render_service_id: "srv-b", static: { status: "failed", sha: "fff0000", deploy_id: null, error: "x", at: "t" } } },
    ];
  });

  it("writes only tenant A's hosting row and keeps its other refs", async () => {
    await writeStaticState("A", live);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].filters).toEqual({ tenant_id: "A", resource_kind: "hosting" });
    expect(db.rows[0].external_ref).toEqual({ render_service_id: "srv-a", url: "https://a.onrender.com", static: live });
    expect(db.rows[1].external_ref).toEqual({ github_full_name: "o/a" });
    expect(db.rows[2].external_ref.render_service_id).toBe("srv-b");
    expect((db.rows[2].external_ref.static as StaticState).status).toBe("failed");
  });

  it("reads each tenant's own state", async () => {
    await writeStaticState("A", live);
    expect(await readStaticState("A")).toEqual(live);
    expect(await readStaticState("B")).toEqual({ status: "failed", sha: "fff0000", deploy_id: null, error: "x", at: "t" });
    expect(await readStaticState("C")).toBeNull();
  });

  it("overwrites a previous static state rather than merging stale fields", async () => {
    await writeStaticState("B", live);
    expect(await readStaticState("B")).toEqual(live);
  });

  it("refuses to write when the tenant has no hosting row, and never touches another tenant", async () => {
    await expect(writeStaticState("C", live)).rejects.toThrow(/no hosting resource/);
    expect(db.updates).toHaveLength(0);
  });

  it("treats a torn-down hosting row as no state", async () => {
    db.rows[2].status = "torn_down";
    expect(await readStaticState("B")).toBeNull();
    await expect(writeStaticState("B", live)).rejects.toThrow();
  });

  it("ignores malformed static state", async () => {
    db.rows[0].external_ref.static = { status: "weird", sha: 1 };
    expect(await readStaticState("A")).toBeNull();
  });
});
