import { describe, it, expect, vi, beforeEach } from "vitest";

const sysConfig: { blob: Record<string, unknown> | null; error: unknown } = {
  blob: {},
  error: null,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            sysConfig.error
              ? { data: null, error: sysConfig.error }
              : {
                  data: sysConfig.blob === null ? null : { blob: sysConfig.blob },
                  error: null,
                },
        }),
      }),
    }),
  }),
}));

import { getScopedRepos, resolveScopedRepos } from "../scoped-repos";

type Row = {
  repo_ids?: number[] | null;
  repo_full_names?: string[] | null;
  selected_repo_ids?: number[] | null;
};

function metaSvc(row: Row | null, error: { message: string } | null = null) {
  return {
    from() {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: row, error }),
      };
      return b;
    },
  } as never;
}

const CONNECTED: Row = {
  repo_ids: [101, 102, 103],
  repo_full_names: ["o/alpha", "o/beta", "o/gamma"],
  selected_repo_ids: null,
};

beforeEach(() => {
  sysConfig.blob = {};
  sysConfig.error = null;
});

describe("repo-scoping default-on — NO-REGRESSION for existing NULL-selection tenants", () => {
  it("absent flag key (default-on) + NULL selection + clean read → resolveScopedRepos mode 'all' (read ALL)", async () => {
    sysConfig.blob = {};
    const r = await resolveScopedRepos("t1", metaSvc(CONNECTED));
    expect(r.mode).toBe("all");
    expect(r.repos).toEqual(["o/alpha", "o/beta", "o/gamma"]);
    expect(r.selectionRequired).toBe(false);
  });

  it("absent flag key (default-on) + NULL selection → getScopedRepos scoped=false, all connected", async () => {
    sysConfig.blob = {};
    const r = await getScopedRepos("t1", metaSvc(CONNECTED));
    expect(r.scoped).toBe(false);
    expect(r.repos).toEqual(["o/alpha", "o/beta", "o/gamma"]);
  });

  it("default-on + NON-NULL selection + clean read → mode 'scoped' (the behavior the flip DOES change)", async () => {
    sysConfig.blob = {};
    const r = await resolveScopedRepos(
      "t1",
      metaSvc({ ...CONNECTED, selected_repo_ids: [101, 103] }),
    );
    expect(r.mode).toBe("scoped");
    expect(r.repos).toEqual(["o/alpha", "o/gamma"]);
  });

  it("EXPLICIT false kill-switch + NON-NULL selection → mode 'all' (grandfather, no deploy needed)", async () => {
    sysConfig.blob = { repo_scoping_enabled: false };
    const r = await resolveScopedRepos(
      "t1",
      metaSvc({ ...CONNECTED, selected_repo_ids: [101] }),
    );
    expect(r.mode).toBe("all");
    expect(r.repos).toEqual(["o/alpha", "o/beta", "o/gamma"]);
  });

  it("connector_metadata READ ERROR + default-on → mode 'deny' (fail-closed, unchanged)", async () => {
    sysConfig.blob = {};
    const r = await resolveScopedRepos("t1", metaSvc(null, { message: "db boom" }));
    expect(r.mode).toBe("deny");
    expect(r.repos).toEqual([]);
  });
});
