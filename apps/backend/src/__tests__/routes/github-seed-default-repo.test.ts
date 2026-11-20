
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  current: null as string | null,
  updates: [] as Array<{ value: unknown; filter: [string, string, unknown] }>,
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(),
  serviceClient: () => ({
    from: (_table: string) => ({
      select: () => {
        const b = {
          eq: () => b,
          maybeSingle: async () => ({
            data: { default_repo_full_name: db.current },
            error: null,
          }),
        };
        return b;
      },
      update: (row: { default_repo_full_name: unknown }) => {
        const b = {
          eq: (k: string, v: unknown) => {
            if (k === "default_repo_full_name") {
              db.updates.push({ value: row.default_repo_full_name, filter: ["eq", k, v] });
              return Promise.resolve({ error: null });
            }
            return b;
          },
          is: (k: string, v: unknown) => {
            db.updates.push({ value: row.default_repo_full_name, filter: ["is", k, v] });
            return Promise.resolve({ error: null });
          },
        };
        return b;
      },
    }),
  }),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));

import { seedDefaultRepoAfterConnect } from "@/routes/connectors/github";

beforeEach(() => {
  db.current = null;
  db.updates.length = 0;
});

describe("seedDefaultRepoAfterConnect", () => {
  it("no default yet + one repo → seeds it (unchanged behavior)", async () => {
    await seedDefaultRepoAfterConnect("t1", ["acme/web"]);
    expect(db.updates).toEqual([
      { value: "acme/web", filter: ["is", "default_repo_full_name", null] },
    ]);
  });

  it("a Praxis-build/* default is replaced by the real connect's seed", async () => {
    db.current = "Praxis-build/old-app-1f02d7f0";
    await seedDefaultRepoAfterConnect("t1", ["acme/web"]);
    expect(db.updates).toEqual([
      {
        value: "acme/web",
        filter: ["eq", "default_repo_full_name", "Praxis-build/old-app-1f02d7f0"],
      },
    ]);
  });

  it("a Praxis-build/* default on a multi-repo connect is cleared (they pick their own)", async () => {
    db.current = "Praxis-build/old-app-1f02d7f0";
    await seedDefaultRepoAfterConnect("t1", ["acme/web", "acme/api"]);
    expect(db.updates).toEqual([
      {
        value: null,
        filter: ["eq", "default_repo_full_name", "Praxis-build/old-app-1f02d7f0"],
      },
    ]);
  });

  it("a real user-chosen default is never clobbered", async () => {
    db.current = "acme/api";
    await seedDefaultRepoAfterConnect("t1", ["acme/web"]);
    expect(db.updates).toEqual([]);
  });

  it("no default + multi-repo → nothing written", async () => {
    await seedDefaultRepoAfterConnect("t1", ["acme/web", "acme/api"]);
    expect(db.updates).toEqual([]);
  });
});
