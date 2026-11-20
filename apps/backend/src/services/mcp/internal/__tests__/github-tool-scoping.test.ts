
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(async () => "ghs_faketoken"),
  ghInstallationHeaders: vi.fn(() => ({ authorization: "Bearer ghs_faketoken" })),
  serviceClientMock: vi.fn(() => ({})),
  getScopedReposMock: vi.fn(),
  resolveScopedReposMock: vi.fn(),
  resolveScopedOrgsMock: vi.fn(),
  assertProvisionedMock: vi.fn(async () => ({ ok: false, reason: "no row" })),
}));

vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
  ghInstallationHeaders: mocks.ghInstallationHeaders,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepos: mocks.getScopedReposMock,
  resolveScopedRepos: mocks.resolveScopedReposMock,
  resolveScopedOrgs: mocks.resolveScopedOrgsMock,
}));
vi.mock("@/services/provisioning/provisioned-repo-gate", () => ({
  assertProvisionedRepoTarget: mocks.assertProvisionedMock,
}));
function installInstallationId(id: number) {
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { installation_id: id, account_login: "acme" },
              error: null,
            }),
          }),
        }),
      }),
    }),
  });
}

import { callGithubTool } from "../github";

const ctx = { tenant_id: "t1", run_id: "r1" } as unknown as Parameters<typeof callGithubTool>[0];

function setScoped(opts: { repos: string[]; scoped: boolean; allConnected?: string[] }) {
  const allConnected = opts.allConnected ?? opts.repos;
  mocks.getScopedReposMock.mockResolvedValue({
    repos: opts.repos,
    scoped: opts.scoped,
    allConnected,
    selectionRequired: false,
  });
  const mode = opts.scoped ? "scoped" : "all";
  mocks.resolveScopedReposMock.mockResolvedValue({
    mode,
    repos: opts.repos,
    allConnected,
    selectionRequired: false,
  });
  const allowedOrgs =
    mode === "all"
      ? null
      : new Set(opts.repos.map((r) => r.split("/")[0]).filter(Boolean));
  mocks.resolveScopedOrgsMock.mockResolvedValue({ mode, allowedOrgs });
}

beforeEach(() => {
  mocks.getScopedReposMock.mockReset();
  mocks.resolveScopedReposMock.mockReset();
  mocks.resolveScopedOrgsMock.mockReset();
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockReturnValue({});
  mocks.assertProvisionedMock.mockResolvedValue({ ok: false, reason: "no row" });
  installInstallationId(123);
});

describe("github MCP scoping guard (P0-1)", () => {
  it("DENIES read_file on a connected-but-scoped-out repo (flag ON, selected=[acme/a])", async () => {
    setScoped({ repos: ["acme/a"], scoped: true, allConnected: ["acme/a", "acme/b"] });
    let fetched = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetched = true;
        return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as unknown as Response;
      }),
    );

    const res = await callGithubTool(ctx, "read_file", {
      owner: "acme",
      repo: "b",
      path: "src/secret.ts",
    });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("repo_not_authorized");
    expect(fetched).toBe(false);
  });

  it("ALLOWS read_file on the selected repo (acme/a)", async () => {
    setScoped({ repos: ["acme/a"], scoped: true, allConnected: ["acme/a", "acme/b"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            type: "file",
            encoding: "base64",
            content: Buffer.from("hello", "utf-8").toString("base64"),
          }),
          text: async () => "",
        }) as unknown as Response,
      ),
    );
    const res = await callGithubTool(ctx, "read_file", {
      owner: "acme",
      repo: "a",
      path: "README.md",
    });
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    expect(body.content).toBe("1\u2502hello");
    expect(body.line_numbers).toBe(true);
    expect(body.total_lines).toBe(1);
    expect(body.covers_whole_file).toBe(true);
  });

  it("DENIES grep on a scoped-out repo (cross-tenant source-read guard)", async () => {
    setScoped({ repos: ["acme/a"], scoped: true, allConnected: ["acme/a", "acme/b"] });
    const fetchMock = vi.fn(
      async () =>
        ({ ok: true, status: 200, json: async () => ({ tree: [] }), text: async () => "" }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await callGithubTool(ctx, "grep", {
      owner: "acme",
      repo: "b",
      pattern: "secret",
    });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("repo_not_authorized");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ALLOWS grep on the selected repo", async () => {
    setScoped({ repos: ["acme/a"], scoped: true, allConnected: ["acme/a", "acme/b"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/git/trees/")
          ? ({
              ok: true,
              status: 200,
              json: async () => ({ truncated: false, tree: [{ path: "a.md", type: "blob", size: 5 }] }),
              text: async () => "",
            } as unknown as Response)
          : ({
              ok: true,
              status: 200,
              json: async () => ({
                type: "file",
                encoding: "base64",
                content: Buffer.from("hello", "utf-8").toString("base64"),
              }),
              text: async () => "",
            } as unknown as Response),
      ),
    );
    const res = await callGithubTool(ctx, "grep", {
      owner: "acme",
      repo: "a",
      pattern: "hello",
    });
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).matches).toEqual([
      { path: "a.md", line_number: 1, line: "hello" },
    ]);
  });

  it("DENIES the OTHER repo-coord read tools too (list_open_prs on scoped-out repo)", async () => {
    setScoped({ repos: ["acme/a"], scoped: true, allConnected: ["acme/a", "acme/b"] });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => "" } as unknown as Response)));
    const res = await callGithubTool(ctx, "list_open_prs", { owner: "acme", repo: "b" });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("repo_not_authorized");
  });
});

describe("github MCP list_repos filtering (P0-2)", () => {
  it("returns only the selected repo when installation exposes both", async () => {
    setScoped({ repos: ["acme/a"], scoped: true, allConnected: ["acme/a", "acme/b"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            repositories: [
              { id: 1, full_name: "acme/a", private: true },
              { id: 2, full_name: "acme/b", private: true },
            ],
          }),
          text: async () => "",
        }) as unknown as Response,
      ),
    );
    const res = await callGithubTool(ctx, "list_repos", {});
    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content) as { repos: Array<{ full_name: string }> };
    expect(out.repos.map((r) => r.full_name)).toEqual(["acme/a"]);
  });

  it("grandfather: scoped:false (flag off / NULL selection) returns the connected set", async () => {
    setScoped({ repos: ["acme/a", "acme/b"], scoped: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            repositories: [
              { id: 1, full_name: "acme/a", private: true },
              { id: 2, full_name: "acme/b", private: true },
            ],
          }),
          text: async () => "",
        }) as unknown as Response,
      ),
    );
    const res = await callGithubTool(ctx, "list_repos", {});
    const out = JSON.parse(res.content) as { repos: Array<{ full_name: string }> };
    expect(out.repos.map((r) => r.full_name).sort()).toEqual(["acme/a", "acme/b"]);
  });
});

function stubFetchJson(makeJson: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      ({
        ok: true,
        status: 200,
        json: async () => makeJson(typeof url === "string" ? url : String(url)),
        text: async () => "",
      }) as unknown as Response,
    ),
  );
}

describe("github MCP fail-closed on scope-read error (round-4 P1)", () => {
  it("search_issues: resolver THROWS while scoping active → ZERO items (not install-wide)", async () => {
    mocks.resolveScopedReposMock.mockRejectedValue(new Error("scope db boom"));
    stubFetchJson(() => ({
      total_count: 2,
      items: [
        { number: 1, title: "leak", repository_url: "https://api.github.com/repos/acme/secret" },
        { number: 2, title: "leak2", repository_url: "https://api.github.com/repos/acme/other" },
      ],
    }));
    const res = await callGithubTool(ctx, "search_issues", { query: "is:issue" });
    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content) as { items: unknown[]; total_count: number };
    expect(out.items).toEqual([]);
    expect(out.total_count).toBe(0);
  });

  it("search_issues: resolver mode 'deny' → ZERO items", async () => {
    mocks.resolveScopedReposMock.mockResolvedValue({
      mode: "deny",
      repos: [],
      allConnected: [],
      selectionRequired: false,
    });
    stubFetchJson(() => ({
      total_count: 1,
      items: [{ number: 9, title: "x", repository_url: "https://api.github.com/repos/acme/secret" }],
    }));
    const res = await callGithubTool(ctx, "search_issues", { query: "is:issue" });
    const out = JSON.parse(res.content) as { items: unknown[]; total_count: number };
    expect(out.items).toEqual([]);
    expect(out.total_count).toBe(0);
  });

  it("search_issues: GRANDFATHER (mode 'all') → unfiltered (no regression)", async () => {
    setScoped({ repos: ["acme/a", "acme/b"], scoped: false });
    stubFetchJson(() => ({
      total_count: 2,
      items: [
        { number: 1, title: "ok", repository_url: "https://api.github.com/repos/acme/a" },
        { number: 2, title: "ok2", repository_url: "https://api.github.com/repos/acme/b" },
      ],
    }));
    const res = await callGithubTool(ctx, "search_issues", { query: "is:issue" });
    const out = JSON.parse(res.content) as { items: unknown[]; total_count: number };
    expect(out.items).toHaveLength(2);
    expect(out.total_count).toBe(2);
  });

  it("get_me: resolver THROWS while scoping active → NO accessible repos (not install-wide)", async () => {
    mocks.resolveScopedReposMock.mockRejectedValue(new Error("scope db boom"));
    stubFetchJson((url) =>
      url.includes("/installation/repositories")
        ? { total_count: 3, repositories: [{ full_name: "acme/a" }, { full_name: "acme/secret" }] }
        : { id: 1, name: "Zavi", slug: "zavi", html_url: "https://github.com/apps/zavi" },
    );
    const res = await callGithubTool(ctx, "get_me", {});
    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content) as { accessible_repos: string[]; repo_count: number };
    expect(out.accessible_repos).toEqual([]);
    expect(out.repo_count).toBe(0);
  });

  it("get_me: resolver mode 'deny' → NO accessible repos", async () => {
    mocks.resolveScopedReposMock.mockResolvedValue({
      mode: "deny",
      repos: [],
      allConnected: [],
      selectionRequired: false,
    });
    stubFetchJson((url) =>
      url.includes("/installation/repositories")
        ? { total_count: 2, repositories: [{ full_name: "acme/a" }, { full_name: "acme/secret" }] }
        : { id: 1, name: "Zavi", slug: "zavi", html_url: "https://github.com/apps/zavi" },
    );
    const res = await callGithubTool(ctx, "get_me", {});
    const out = JSON.parse(res.content) as { accessible_repos: string[]; repo_count: number };
    expect(out.accessible_repos).toEqual([]);
    expect(out.repo_count).toBe(0);
  });

  it("get_me: GRANDFATHER (mode 'all') → full install set (no regression)", async () => {
    setScoped({ repos: ["acme/a", "acme/b"], scoped: false });
    stubFetchJson((url) =>
      url.includes("/installation/repositories")
        ? { total_count: 2, repositories: [{ full_name: "acme/a" }, { full_name: "acme/b" }] }
        : { id: 1, name: "Zavi", slug: "zavi", html_url: "https://github.com/apps/zavi" },
    );
    const res = await callGithubTool(ctx, "get_me", {});
    const out = JSON.parse(res.content) as { accessible_repos: string[]; repo_count: number };
    expect(out.accessible_repos.sort()).toEqual(["acme/a", "acme/b"]);
    expect(out.repo_count).toBe(2);
  });

  it("list_repos: resolver THROWS while scoping active → EMPTY list (not install-wide)", async () => {
    mocks.resolveScopedReposMock.mockRejectedValue(new Error("scope db boom"));
    stubFetchJson(() => ({
      repositories: [
        { id: 1, full_name: "acme/a", private: true },
        { id: 2, full_name: "acme/secret", private: true },
      ],
    }));
    const res = await callGithubTool(ctx, "list_repos", {});
    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content) as { repos: Array<{ full_name: string }> };
    expect(out.repos).toEqual([]);
  });

  it("list_repos: resolver mode 'deny' → EMPTY list", async () => {
    mocks.resolveScopedReposMock.mockResolvedValue({
      mode: "deny",
      repos: [],
      allConnected: [],
      selectionRequired: false,
    });
    stubFetchJson(() => ({
      repositories: [{ id: 1, full_name: "acme/secret", private: true }],
    }));
    const res = await callGithubTool(ctx, "list_repos", {});
    const out = JSON.parse(res.content) as { repos: Array<{ full_name: string }> };
    expect(out.repos).toEqual([]);
  });
});

describe("github MCP list_teams org gating (round-4 P1-4)", () => {
  it("DENIES list_teams({org:orgB}) when only orgA has a selected repo", async () => {
    mocks.resolveScopedOrgsMock.mockResolvedValue({
      mode: "scoped",
      allowedOrgs: new Set(["orgA"]),
    });
    let fetched = false;
    stubFetchJson(() => {
      fetched = true;
      return [];
    });
    const res = await callGithubTool(ctx, "list_teams", { org: "orgB" });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("repo_not_authorized");
    expect(fetched).toBe(false);
  });

  it("ALLOWS list_teams({org:orgA}) when orgA owns a selected repo", async () => {
    mocks.resolveScopedOrgsMock.mockResolvedValue({
      mode: "scoped",
      allowedOrgs: new Set(["orgA"]),
    });
    stubFetchJson(() => [{ id: 1, slug: "core", name: "Core", description: "the core team" }]);
    const res = await callGithubTool(ctx, "list_teams", { org: "orgA" });
    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content) as { teams: Array<{ slug: string }> };
    expect(out.teams.map((t) => t.slug)).toEqual(["core"]);
  });

  it("GRANDFATHER (mode 'all') → any org allowed (no regression)", async () => {
    mocks.resolveScopedOrgsMock.mockResolvedValue({ mode: "all", allowedOrgs: null });
    stubFetchJson(() => [{ id: 2, slug: "ops", name: "Ops", description: "" }]);
    const res = await callGithubTool(ctx, "list_teams", { org: "anyorg" });
    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content) as { teams: Array<{ slug: string }> };
    expect(out.teams.map((t) => t.slug)).toEqual(["ops"]);
  });

  it("FAIL-CLOSED: resolveScopedOrgs THROWS while scoping active → DENY org", async () => {
    mocks.resolveScopedOrgsMock.mockRejectedValue(new Error("scope db boom"));
    let fetched = false;
    stubFetchJson(() => {
      fetched = true;
      return [];
    });
    const res = await callGithubTool(ctx, "list_teams", { org: "orgA" });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("repo_not_authorized");
    expect(fetched).toBe(false);
  });
});
