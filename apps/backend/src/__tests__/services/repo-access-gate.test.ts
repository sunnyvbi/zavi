
import { describe, it, expect } from "vitest";
import {
  checkSandboxRepoAccess,
  repoAccessBlockedMessage,
  isUmbrellaProvisionedTenant,
  hasRealGithubInstall,
  SandboxRepoAccessRequiredError,
} from "@/services/sandbox/repo-access-gate";

type Resp = { data: unknown; error: { message: string } | null };

function makeSvc(resp: Resp) {
  return {
    from() {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve(resp),
      };
      return b;
    },
  } as never;
}

function makeSvcByTable(byTable: Record<string, Resp>) {
  return {
    from(table: string) {
      const resp = byTable[table] ?? { data: null, error: null };
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve(resp),
      };
      return b;
    },
  } as never;
}

const CONNECTED = { installation_id: 123, repo_full_names: ["o/r1", "o/r2"] };
const ZERO = { installation_id: 123, repo_full_names: [] };
const UMBRELLA = {
  installation_id: null,
  account_login: "Praxis-build",
  repo_full_names: ["Praxis-build/i-am-running-my-1cf4e324"],
};
const USER_REPO_NO_INSTALL = {
  installation_id: null,
  account_login: "rravi149",
  repo_full_names: ["rravi149/upcar"],
};

describe("checkSandboxRepoAccess", () => {
  it("ok when connected with repos", async () => {
    expect(await checkSandboxRepoAccess("t1", undefined, makeSvc({ data: CONNECTED, error: null }))).toBe("ok");
  });

  it("not_connected when no connector row", async () => {
    expect(await checkSandboxRepoAccess("t1", undefined, makeSvc({ data: null, error: null }))).toBe("not_connected");
  });

  it("not_connected when row lacks installation_id", async () => {
    expect(
      await checkSandboxRepoAccess("t1", undefined, makeSvc({ data: { repo_full_names: ["o/r"] }, error: null })),
    ).toBe("not_connected");
  });

  it("zero_repos when connected but nothing shared", async () => {
    expect(await checkSandboxRepoAccess("t1", undefined, makeSvc({ data: ZERO, error: null }))).toBe("zero_repos");
  });

  it("fail-OPEN on DB read error (in-run check stays authoritative)", async () => {
    expect(
      await checkSandboxRepoAccess("t1", undefined, makeSvc({ data: null, error: { message: "boom" } })),
    ).toBe("ok");
  });

  it("bypasses for scaffold/build umbrella payloads (provisioned repo, not the installation)", async () => {
    const svc = makeSvc({ data: null, error: null });
    expect(await checkSandboxRepoAccess("t1", { stage: "build" }, svc)).toBe("ok");
    expect(await checkSandboxRepoAccess("t1", { stage: "scaffold", target: {} }, svc)).toBe("ok");
  });

  it("does NOT bypass for user_repo build targets (they use the installation)", async () => {
    const svc = makeSvc({ data: ZERO, error: null });
    expect(
      await checkSandboxRepoAccess("t1", { stage: "build", target: { github_target_mode: "user_repo" } }, svc),
    ).toBe("zero_repos");
  });

  it("does NOT bypass for non-build payloads", async () => {
    const svc = makeSvc({ data: ZERO, error: null });
    expect(await checkSandboxRepoAccess("t1", { stage: "review" }, svc)).toBe("zero_repos");
    expect(await checkSandboxRepoAccess("t1", {}, svc)).toBe("zero_repos");
  });

  it("ok for an umbrella-provisioned app on a refine/chat payload (undefined)", async () => {
    const svc = makeSvc({ data: UMBRELLA, error: null });
    expect(await checkSandboxRepoAccess("t1", undefined, svc)).toBe("ok");
  });

  it("ok for an umbrella-provisioned app on a plain (non-build) payload", async () => {
    const svc = makeSvc({ data: UMBRELLA, error: null });
    expect(await checkSandboxRepoAccess("t1", {}, svc)).toBe("ok");
    expect(await checkSandboxRepoAccess("t1", { stage: "review" }, svc)).toBe("ok");
  });

  it("still not_connected for a genuine user_repo app with null installation_id", async () => {
    const svc = makeSvc({ data: USER_REPO_NO_INSTALL, error: null });
    expect(await checkSandboxRepoAccess("t1", undefined, svc)).toBe("not_connected");
  });

  it("umbrella sentinel with an EMPTY repo list does not bypass (falls to not_connected)", async () => {
    const svc = makeSvc({
      data: { installation_id: null, account_login: "Praxis-build", repo_full_names: [] },
      error: null,
    });
    expect(await checkSandboxRepoAccess("t1", undefined, svc)).toBe("not_connected");
  });
});

describe("isUmbrellaProvisionedTenant", () => {
  it("true when the tenant's own github row is the Praxis-build sentinel with repos", async () => {
    expect(await isUmbrellaProvisionedTenant("t1", makeSvc({ data: UMBRELLA, error: null }))).toBe(true);
  });

  it("false for a genuine user_repo tenant (account_login is a real github login)", async () => {
    expect(
      await isUmbrellaProvisionedTenant("t1", makeSvc({ data: USER_REPO_NO_INSTALL, error: null })),
    ).toBe(false);
  });

  it("false for a connected-install tenant (no sentinel)", async () => {
    expect(
      await isUmbrellaProvisionedTenant(
        "t1",
        makeSvc({ data: { ...CONNECTED, account_login: "rravi149" }, error: null }),
      ),
    ).toBe(false);
  });

  it("false when no connector row", async () => {
    expect(await isUmbrellaProvisionedTenant("t1", makeSvc({ data: null, error: null }))).toBe(false);
  });

  it("false (soft-fail) on a read error", async () => {
    expect(
      await isUmbrellaProvisionedTenant("t1", makeSvc({ data: null, error: { message: "boom" } })),
    ).toBe(false);
  });

  it("false when the sentinel row has an empty repo list", async () => {
    expect(
      await isUmbrellaProvisionedTenant(
        "t1",
        makeSvc({ data: { account_login: "Praxis-build", repo_full_names: [] }, error: null }),
      ),
    ).toBe(false);
  });
});

describe("checkSandboxRepoAccess — install_dead (dead GitHub App install)", () => {
  it("install_dead when connected-but-stale AND github MCP explicitly disabled", async () => {
    const svc = makeSvcByTable({
      connector_metadata: { data: CONNECTED, error: null },
      tenant_mcp_servers: { data: { enabled: false }, error: null },
    });
    expect(await checkSandboxRepoAccess("t1", undefined, svc)).toBe("install_dead");
  });

  it("NOT install_dead (→ ok) when github MCP row is ABSENT (never wired)", async () => {
    const svc = makeSvcByTable({
      connector_metadata: { data: CONNECTED, error: null },
      tenant_mcp_servers: { data: null, error: null },
    });
    expect(await checkSandboxRepoAccess("t1", undefined, svc)).toBe("ok");
  });

  it("NOT install_dead (→ ok) when github MCP is enabled=true", async () => {
    const svc = makeSvcByTable({
      connector_metadata: { data: CONNECTED, error: null },
      tenant_mcp_servers: { data: { enabled: true }, error: null },
    });
    expect(await checkSandboxRepoAccess("t1", undefined, svc)).toBe("ok");
  });

  it("fail-OPEN: a tenant_mcp_servers read error does NOT mark install_dead", async () => {
    const svc = makeSvcByTable({
      connector_metadata: { data: CONNECTED, error: null },
      tenant_mcp_servers: { data: null, error: { message: "boom" } },
    });
    expect(await checkSandboxRepoAccess("t1", undefined, svc)).toBe("ok");
  });

  it("not_connected still wins over install_dead when there's no installation_id", async () => {
    const svc = makeSvcByTable({
      connector_metadata: { data: null, error: null },
      tenant_mcp_servers: { data: { enabled: false }, error: null },
    });
    expect(await checkSandboxRepoAccess("t1", undefined, svc)).toBe("not_connected");
  });
});

describe("repoAccessBlockedMessage + typed error", () => {
  it("messages point at Settings → Connectors and ask a re-send", () => {
    for (const s of ["not_connected", "zero_repos"] as const) {
      const m = repoAccessBlockedMessage(s);
      expect(m).toContain("Settings → Connectors → GitHub");
      expect(m.toLowerCase()).toContain("re-send");
    }
  });

  it("install_dead message says reconnect (not connect) and points at Settings", () => {
    const m = repoAccessBlockedMessage("install_dead");
    expect(m).toContain("Settings → Connectors → GitHub");
    expect(m.toLowerCase()).toContain("reconnect");
    expect(m.toLowerCase()).toContain("re-send");
  });

  it("typed error carries the distinct code for catch-mapping", () => {
    const e = new SandboxRepoAccessRequiredError("engineer", "zero_repos");
    expect(e.name).toBe("SandboxRepoAccessRequiredError");
    expect(e.message).toContain("config_error_no_repo_access");
    expect(e.status).toBe("zero_repos");
  });

  it("typed error carries install_dead status + code", () => {
    const e = new SandboxRepoAccessRequiredError("engineer", "install_dead");
    expect(e.status).toBe("install_dead");
    expect(e.message).toContain("config_error_no_repo_access");
    expect(e.message.toLowerCase()).toContain("removed or expired");
  });
});

describe("hasRealGithubInstall", () => {
  it("true for a positive numeric installation on a non-umbrella account", () => {
    expect(hasRealGithubInstall({ installation_id: 147981112, account_login: "acme" })).toBe(true);
  });

  it("false for the umbrella sentinel, even with an installation id", () => {
    expect(
      hasRealGithubInstall({ installation_id: 5, account_login: "Praxis-build" }),
    ).toBe(false);
    expect(
      hasRealGithubInstall({ installation_id: null, account_login: "Praxis-build" }),
    ).toBe(false);
  });

  it("false for a missing row, a null / zero / non-numeric installation id", () => {
    expect(hasRealGithubInstall(null)).toBe(false);
    expect(hasRealGithubInstall(undefined)).toBe(false);
    expect(hasRealGithubInstall({ installation_id: null, account_login: "acme" })).toBe(false);
    expect(hasRealGithubInstall({ installation_id: 0, account_login: "acme" })).toBe(false);
    expect(hasRealGithubInstall({ installation_id: "123", account_login: "acme" })).toBe(false);
  });
});
