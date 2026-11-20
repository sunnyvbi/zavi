
import { describe, it, expect, vi, beforeEach } from "vitest";

const flag = { on: false };
vi.mock("@/services/connectors/github/repo-scoping-flag", () => ({
  REPO_SCOPING_FLAG_KEY: "repo_scoping_enabled",
  isRepoScopingEnabled: async () => flag.on,
  getRepoScopingFlagState: async () => (flag.on ? "on" : "off"),
}));

import {
  checkSandboxRepoAccess,
  repoAccessBlockedMessage,
  SandboxRepoAccessRequiredError,
} from "@/services/sandbox/repo-access-gate";

function makeSvc(row: Record<string, unknown> | null) {
  return {
    from() {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
      };
      return b;
    },
  } as never;
}

beforeEach(() => {
  flag.on = false;
});

const ROW_3 = {
  installation_id: 123,
  repo_ids: [1, 2, 3],
  repo_full_names: ["o/a", "o/b", "o/c"],
};

describe("checkSandboxRepoAccess — scoping", () => {
  it("flag OFF + selection NULL → ok (grandfather, no behavior change)", async () => {
    expect(
      await checkSandboxRepoAccess("t1", undefined, makeSvc({ ...ROW_3, selected_repo_ids: null })),
    ).toBe("ok");
  });

  it("flag ON + selection NULL → ok (existing tenants grandfathered)", async () => {
    flag.on = true;
    expect(
      await checkSandboxRepoAccess("t1", undefined, makeSvc({ ...ROW_3, selected_repo_ids: null })),
    ).toBe("ok");
  });

  it("flag ON + non-empty selection → ok", async () => {
    flag.on = true;
    expect(
      await checkSandboxRepoAccess("t1", undefined, makeSvc({ ...ROW_3, selected_repo_ids: [1] })),
    ).toBe("ok");
  });

  it("flag ON + EMPTY selection while installation has repos → selection_required (fail-closed)", async () => {
    flag.on = true;
    expect(
      await checkSandboxRepoAccess("t1", undefined, makeSvc({ ...ROW_3, selected_repo_ids: [] })),
    ).toBe("selection_required");
  });

  it("flag OFF + EMPTY selection → ok (inert — scoping not enforced)", async () => {
    flag.on = false;
    expect(
      await checkSandboxRepoAccess("t1", undefined, makeSvc({ ...ROW_3, selected_repo_ids: [] })),
    ).toBe("ok");
  });

  it("provisioned-build bypass still wins regardless of scoping", async () => {
    flag.on = true;
    expect(
      await checkSandboxRepoAccess("t1", { stage: "build" }, makeSvc({ ...ROW_3, selected_repo_ids: [] })),
    ).toBe("ok");
  });
});

describe("selection_required messaging + typed error", () => {
  it("message points at Settings → Connectors and asks a re-send", () => {
    const m = repoAccessBlockedMessage("selection_required");
    expect(m).toContain("Settings → Connectors → GitHub");
    expect(m.toLowerCase()).toContain("re-send");
  });

  it("typed error carries selection_required", () => {
    const e = new SandboxRepoAccessRequiredError("engineer", "selection_required");
    expect(e.status).toBe("selection_required");
    expect(e.message).toContain("config_error_no_repo_access");
  });
});
