import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { blob: Record<string, unknown> | null; error: unknown } = {
  blob: {},
  error: null,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            state.error
              ? { data: null, error: state.error }
              : { data: state.blob === null ? null : { blob: state.blob }, error: null },
        }),
      }),
    }),
  }),
}));

import { isRepoScopingEnabled, getRepoScopingFlagState } from "../repo-scoping-flag";

beforeEach(() => {
  state.blob = {};
  state.error = null;
});

describe("isRepoScopingEnabled — default ON", () => {
  it("absent key + clean read → ON (scoping is the default)", async () => {
    state.blob = {};
    expect(await isRepoScopingEnabled()).toBe(true);
  });

  it("explicit true → ON", async () => {
    state.blob = { repo_scoping_enabled: true };
    expect(await isRepoScopingEnabled()).toBe(true);
  });

  it("explicit false → OFF (no-deploy kill-switch preserved)", async () => {
    state.blob = { repo_scoping_enabled: false };
    expect(await isRepoScopingEnabled()).toBe(false);
  });

  it("other flags present, scoping key absent → still ON (default)", async () => {
    state.blob = { social_publish_enabled: true, disabled_agent_slugs: ["x"] };
    expect(await isRepoScopingEnabled()).toBe(true);
  });

  it("system_config read error → FALSE here (unknown maps to false in the boolean wrapper)", async () => {
    state.error = { message: "pooler down" };
    expect(await isRepoScopingEnabled()).toBe(false);
  });

  it("no system_config row (clean read, absent key) → ON (default)", async () => {
    state.blob = null;
    expect(await isRepoScopingEnabled()).toBe(true);
  });
});

describe("getRepoScopingFlagState — tri-state (default ON)", () => {
  it("explicit true → 'on'", async () => {
    state.blob = { repo_scoping_enabled: true };
    expect(await getRepoScopingFlagState()).toBe("on");
  });
  it("explicit false → 'off' (kill-switch, no deploy)", async () => {
    state.blob = { repo_scoping_enabled: false };
    expect(await getRepoScopingFlagState()).toBe("off");
  });
  it("absent key + clean read → 'on' (DEFAULT FLIP off→on)", async () => {
    state.blob = {};
    expect(await getRepoScopingFlagState()).toBe("on");
  });
  it("no row (clean read, key absent) → 'on' (default)", async () => {
    state.blob = null;
    expect(await getRepoScopingFlagState()).toBe("on");
  });
  it("read ERROR → 'unknown' (UNCHANGED — caller decides by selection)", async () => {
    state.error = { message: "pooler down" };
    expect(await getRepoScopingFlagState()).toBe("unknown");
  });
});
