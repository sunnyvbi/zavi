
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(async () => "ghs_tenanttoken"),
  ghInstallationHeaders: vi.fn((token: string) => ({
    authorization: `Bearer ${token}`,
  })),
  serviceClientMock: vi.fn(),
  assertProvisionedRepoTarget: vi.fn(),
}));

vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
  ghInstallationHeaders: mocks.ghInstallationHeaders,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/provisioning/provisioned-repo-gate", () => ({
  assertProvisionedRepoTarget: mocks.assertProvisionedRepoTarget,
  realProvisionedRepoGateDeps: {},
}));

import { callGithubTool } from "../github";

type FetchCall = { url: string; method: string; body: unknown };

function installFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  const json = (obj: unknown) => ({
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (/\/git\/ref\/heads\//.test(url) && method === "GET") {
      return json({ object: { sha: "basesha111" } }) as unknown as Response;
    }
    if (/\/git\/blobs$/.test(url) && method === "POST") {
      return json({ sha: "blobsha222" }) as unknown as Response;
    }
    if (/\/git\/trees$/.test(url) && method === "POST") {
      return json({ sha: "treesha333" }) as unknown as Response;
    }
    if (/\/git\/commits$/.test(url) && method === "POST") {
      return json({ sha: "commitsha444" }) as unknown as Response;
    }
    if (/\/git\/refs$/.test(url) && method === "POST") {
      return json({ ref: "refs/heads/refine-1" }) as unknown as Response;
    }
    if (/\/pulls$/.test(url) && method === "POST") {
      return json({
        number: 7,
        html_url: "https://github.com/Praxis-build/acme-app/pull/7",
        head: { sha: "commitsha444" },
      }) as unknown as Response;
    }
    return {
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "unexpected fetch",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchStub);
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.PRAXIS_GITHUB_ORG = "Praxis-build";
  process.env.GITHUB_PROVISION_TOKEN = "ghp_umbrella";
  mocks.mintInstallationToken.mockClear();
  mocks.ghInstallationHeaders.mockClear();
  mocks.assertProvisionedRepoTarget.mockReset();
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { installation_id: 42, account_login: "rravi149" },
              error: null,
            }),
          }),
        }),
      }),
    }),
  }));
});

const ctx = { tenant_id: "t-1", run_id: "r-1" } as const;

const OPEN_PR_ARGS = {
  owner: "Praxis-build",
  repo: "acme-app",
  base_branch: "main",
  head_branch: "refine-1",
  title: "refine: park as PR (brake)",
  body: "Phase-A brake PR",
  files: [{ path: "app/page.tsx", action: "modify" as const, content: "x" }],
};

describe("open_pr umbrella-credential resolution (Phase-A brake fallback path)", () => {
  it("uses the umbrella PAT (never the tenant installation) when the gate proves the repo is THIS tenant's provisioned target", async () => {
    mocks.assertProvisionedRepoTarget.mockResolvedValue({
      ok: true,
      github_full_name: "Praxis-build/acme-app",
    });
    const calls = installFetch();

    const res = await callGithubTool(ctx, "open_pr", OPEN_PR_ARGS);

    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content) as { url: string; number: number };
    expect(out.number).toBe(7);
    expect(out.url).toBe("https://github.com/Praxis-build/acme-app/pull/7");

    expect(mocks.assertProvisionedRepoTarget).toHaveBeenCalledWith(
      "t-1",
      "Praxis-build/acme-app",
    );
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
    expect(mocks.ghInstallationHeaders).toHaveBeenCalledWith("ghp_umbrella");
    expect(calls.some((c) => c.method === "POST" && /\/pulls$/.test(c.url))).toBe(
      true,
    );
  });

  it("FAIL-CLOSED: gate refusal (cross-tenant / not provisioned) falls back to the tenant installation token — the umbrella PAT is never granted", async () => {
    mocks.assertProvisionedRepoTarget.mockResolvedValue({
      ok: false,
      reason: "github_full_name mismatch",
    });
    installFetch();

    await callGithubTool(ctx, "open_pr", OPEN_PR_ARGS);

    expect(mocks.assertProvisionedRepoTarget).toHaveBeenCalledWith(
      "t-1",
      "Praxis-build/acme-app",
    );
    expect(mocks.mintInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "t-1", installation_id: 42 }),
    );
    expect(mocks.ghInstallationHeaders).not.toHaveBeenCalledWith("ghp_umbrella");
  });

  it("non-umbrella owner: the gate is never consulted and the tenant installation token is used (customer-repo path byte-identical)", async () => {
    installFetch();

    await callGithubTool(ctx, "open_pr", {
      ...OPEN_PR_ARGS,
      owner: "acme-corp",
      repo: "storefront",
    });

    expect(mocks.assertProvisionedRepoTarget).not.toHaveBeenCalled();
    expect(mocks.mintInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "t-1", installation_id: 42 }),
    );
  });

  it("push_to_main keeps its pre-existing umbrella routing (no gate at this layer — dispatch-decision's tryPushToMain gates upstream)", async () => {
    const calls = installFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ url, method, body: undefined });
        const json = (obj: unknown) => ({
          ok: true,
          status: 200,
          json: async () => obj,
          text: async () => JSON.stringify(obj),
        });
        if (/\/git\/ref\/heads\//.test(url) && method === "GET") {
          return json({ object: { sha: "basesha111" } }) as unknown as Response;
        }
        if (/\/git\/blobs$/.test(url)) return json({ sha: "b" }) as unknown as Response;
        if (/\/git\/trees$/.test(url)) return json({ sha: "t" }) as unknown as Response;
        if (/\/git\/commits$/.test(url)) return json({ sha: "c" }) as unknown as Response;
        if (/\/git\/refs\/heads\/main$/.test(url) && method === "PATCH") {
          return json({ object: { sha: "c" } }) as unknown as Response;
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => "unexpected",
        } as unknown as Response;
      }),
    );

    const res = await callGithubTool(ctx, "push_to_main", {
      owner: "Praxis-build",
      repo: "acme-app",
      base_branch: "main",
      title: "build: push",
      files: [{ path: "a.ts", action: "create", content: "x" }],
    });

    expect(res.is_error).toBe(false);
    expect(mocks.assertProvisionedRepoTarget).not.toHaveBeenCalled();
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
    expect(mocks.ghInstallationHeaders).toHaveBeenCalledWith("ghp_umbrella");
  });
});
