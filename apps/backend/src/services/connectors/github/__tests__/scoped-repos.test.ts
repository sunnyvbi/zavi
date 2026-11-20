import { describe, it, expect, vi, beforeEach } from "vitest";

const flag = {
  _state: "off" as "on" | "off" | "unknown",
  get on() {
    return this._state === "on";
  },
  set on(v: boolean) {
    this._state = v ? "on" : "off";
  },
  get state() {
    return this._state;
  },
  set state(s: "on" | "off" | "unknown") {
    this._state = s;
  },
};
vi.mock("../repo-scoping-flag", () => ({
  REPO_SCOPING_FLAG_KEY: "repo_scoping_enabled",
  getRepoScopingFlagState: async () => flag.state,
  isRepoScopingEnabled: async () => flag.state === "on",
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }),
}));

import {
  getScopedRepos,
  getScopedRepoFullNames,
  resolveScopedRepos,
  resolveScopedOrgs,
} from "../scoped-repos";

type Row = {
  repo_ids?: number[] | null;
  repo_full_names?: string[] | null;
  selected_repo_ids?: number[] | null;
};

function svcWith(row: Row | null, error: { message: string } | null = null) {
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

const FULL: Row = {
  repo_ids: [101, 102, 103],
  repo_full_names: ["o/alpha", "o/beta", "o/gamma"],
  selected_repo_ids: null,
};

beforeEach(() => {
  flag.state = "off";
});

describe("getScopedRepos — grandfather (unscoped) paths", () => {
  it("flag OFF + selection NULL → all connected, scoped=false", async () => {
    const r = await getScopedRepos("t1", svcWith(FULL));
    expect(r.repos).toEqual(["o/alpha", "o/beta", "o/gamma"]);
    expect(r.scoped).toBe(false);
    expect(r.selectionRequired).toBe(false);
    expect(r.allConnected).toEqual(["o/alpha", "o/beta", "o/gamma"]);
  });

  it("flag OFF but a selection EXISTS → STILL all connected (flag is the master gate)", async () => {
    flag.on = false;
    const r = await getScopedRepos("t1", svcWith({ ...FULL, selected_repo_ids: [101] }));
    expect(r.repos).toEqual(["o/alpha", "o/beta", "o/gamma"]);
    expect(r.scoped).toBe(false);
  });

  it("flag ON + selection NULL → all connected (existing tenants grandfathered)", async () => {
    flag.on = true;
    const r = await getScopedRepos("t1", svcWith(FULL));
    expect(r.repos).toEqual(["o/alpha", "o/beta", "o/gamma"]);
    expect(r.scoped).toBe(false);
    expect(r.selectionRequired).toBe(false);
  });

  it("DB read error → fail-safe unscoped (empty, not a lock-out)", async () => {
    flag.on = true;
    const r = await getScopedRepos("t1", svcWith(null, { message: "boom" }));
    expect(r.repos).toEqual([]);
    expect(r.scoped).toBe(false);
    expect(r.selectionRequired).toBe(false);
  });
});

describe("getScopedRepos — scoped (enforcement) paths", () => {
  it("subset intersection: scoped → only selected ids, mapped to full_names", async () => {
    flag.on = true;
    const r = await getScopedRepos("t1", svcWith({ ...FULL, selected_repo_ids: [101, 103] }));
    expect(r.repos).toEqual(["o/alpha", "o/gamma"]);
    expect(r.scoped).toBe(true);
    expect(r.selectionRequired).toBe(false);
    expect(r.allConnected).toEqual(["o/alpha", "o/beta", "o/gamma"]);
  });

  it("fail-closed: scoped + EMPTY selection while installation has repos → [] + selectionRequired", async () => {
    flag.on = true;
    const r = await getScopedRepos("t1", svcWith({ ...FULL, selected_repo_ids: [] }));
    expect(r.repos).toEqual([]);
    expect(r.scoped).toBe(true);
    expect(r.selectionRequired).toBe(true);
  });

  it("intersection drops a stale selected id no longer in repo_ids (defense in depth)", async () => {
    flag.on = true;
    const r = await getScopedRepos("t1", svcWith({ ...FULL, selected_repo_ids: [102, 999] }));
    expect(r.repos).toEqual(["o/beta"]);
    expect(r.scoped).toBe(true);
    expect(r.selectionRequired).toBe(false);
  });

  it("scoped + empty selection but ZERO installation repos → not selectionRequired (nothing to pick)", async () => {
    flag.on = true;
    const r = await getScopedRepos(
      "t1",
      svcWith({ repo_ids: [], repo_full_names: [], selected_repo_ids: [] }),
    );
    expect(r.repos).toEqual([]);
    expect(r.selectionRequired).toBe(false);
  });
});

describe("getScopedRepoFullNames convenience", () => {
  it("returns just the scoped repos array", async () => {
    flag.on = true;
    const repos = await getScopedRepoFullNames("t1", svcWith({ ...FULL, selected_repo_ids: [102] }));
    expect(repos).toEqual(["o/beta"]);
  });
});

describe("getScopedRepos — flag-state UNKNOWN (P1-5 fail-closed)", () => {
  it("UNKNOWN flag + NON-NULL selection → STILL scoped (does NOT widen to read-all)", async () => {
    flag.state = "unknown";
    const repos = await getScopedRepoFullNames(
      "t1",
      svcWith({ ...FULL, selected_repo_ids: [101] }),
    );
    expect(repos).toEqual(["o/alpha"]);
    expect(repos).not.toContain("o/beta");
  });

  it("UNKNOWN flag + EMPTY selection → fail-closed empty (selectionRequired)", async () => {
    flag.state = "unknown";
    const r = await getScopedRepos("t1", svcWith({ ...FULL, selected_repo_ids: [] }));
    expect(r.repos).toEqual([]);
    expect(r.scoped).toBe(true);
    expect(r.selectionRequired).toBe(true);
  });

  it("UNKNOWN flag + NULL selection → grandfathered (read-all, availability-safe)", async () => {
    flag.state = "unknown";
    const r = await getScopedRepos("t1", svcWith(FULL));
    expect(r.repos).toEqual(["o/alpha", "o/beta", "o/gamma"]);
    expect(r.scoped).toBe(false);
  });

  it("OFF flag (readable) + NON-NULL selection → grandfathered (design intent, inert)", async () => {
    flag.state = "off";
    const r = await getScopedRepos("t1", svcWith({ ...FULL, selected_repo_ids: [101] }));
    expect(r.repos).toEqual(["o/alpha", "o/beta", "o/gamma"]);
    expect(r.scoped).toBe(false);
  });
});

describe("resolveScopedRepos — tri-state mode", () => {
  it("grandfather: flag OFF + NULL selection → mode 'all' (byte-identical repos)", async () => {
    flag.state = "off";
    const r = await resolveScopedRepos("t1", svcWith(FULL));
    expect(r.mode).toBe("all");
    expect(r.repos).toEqual(["o/alpha", "o/beta", "o/gamma"]);
  });

  it("grandfather: flag ON + NULL selection → mode 'all' (existing tenants)", async () => {
    flag.state = "on";
    const r = await resolveScopedRepos("t1", svcWith(FULL));
    expect(r.mode).toBe("all");
    expect(r.repos).toEqual(["o/alpha", "o/beta", "o/gamma"]);
  });

  it("active: flag ON + selection → mode 'scoped' (selected ∩ install)", async () => {
    flag.state = "on";
    const r = await resolveScopedRepos("t1", svcWith({ ...FULL, selected_repo_ids: [101, 103] }));
    expect(r.mode).toBe("scoped");
    expect(r.repos).toEqual(["o/alpha", "o/gamma"]);
  });

  it("FAIL-CLOSED: flag ON + metadata READ ERROR → mode 'deny', repos [] (NOT 'all')", async () => {
    flag.state = "on";
    const r = await resolveScopedRepos("t1", svcWith(null, { message: "db boom" }));
    expect(r.mode).toBe("deny");
    expect(r.repos).toEqual([]);
  });

  it("FAIL-CLOSED: flag UNKNOWN + metadata READ ERROR → mode 'deny' (cannot prove grandfather)", async () => {
    flag.state = "unknown";
    const r = await resolveScopedRepos("t1", svcWith(null, { message: "db boom" }));
    expect(r.mode).toBe("deny");
    expect(r.repos).toEqual([]);
  });

  it("flag OFF + metadata READ ERROR → mode 'all' empty (cleanly grandfathered, inert)", async () => {
    flag.state = "off";
    const r = await resolveScopedRepos("t1", svcWith(null, { message: "db boom" }));
    expect(r.mode).toBe("all");
    expect(r.repos).toEqual([]);
  });
});

describe("resolveScopedOrgs — org gate for list_teams", () => {
  it("grandfather (mode 'all') → allowedOrgs null (all orgs allowed)", async () => {
    flag.state = "off";
    const r = await resolveScopedOrgs("t1", svcWith(FULL));
    expect(r.mode).toBe("all");
    expect(r.allowedOrgs).toBeNull();
  });

  it("scoped → allowedOrgs = owners of selected repos only", async () => {
    flag.state = "on";
    const r = await resolveScopedOrgs(
      "t1",
      svcWith({
        repo_ids: [1, 2, 3],
        repo_full_names: ["orgA/x", "orgA/y", "orgB/z"],
        selected_repo_ids: [1, 2],
      }),
    );
    expect(r.mode).toBe("scoped");
    expect([...(r.allowedOrgs ?? [])].sort()).toEqual(["orgA"]);
    expect(r.allowedOrgs?.has("orgB")).toBe(false);
  });

  it("FAIL-CLOSED: flag ON + metadata READ ERROR → mode 'deny', allowedOrgs empty", async () => {
    flag.state = "on";
    const r = await resolveScopedOrgs("t1", svcWith(null, { message: "db boom" }));
    expect(r.mode).toBe("deny");
    expect(r.allowedOrgs?.size).toBe(0);
  });
});
