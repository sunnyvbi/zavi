
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(async () => "ghs_faketoken"),
  ghInstallationHeaders: vi.fn(() => ({ authorization: "Bearer ghs_faketoken" })),
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
  ghInstallationHeaders: mocks.ghInstallationHeaders,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

import { callGithubTool } from "../github";

type FetchCall = { url: string; method: string; body: unknown };

function installFetch(opts: { treeSha?: string } = {}): FetchCall[] {
  const headTreeSha = "headtree000";
  const treeSha = opts.treeSha ?? "treesha333";
  const calls: FetchCall[] = [];
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (obj: unknown) => ({
      ok: true,
      status: 200,
      json: async () => obj,
      text: async () => JSON.stringify(obj),
    });
    if (/\/git\/ref\/heads\//.test(url) && method === "GET") {
      return json({ object: { sha: "headsha111" } }) as unknown as Response;
    }
    if (/\/git\/commits\/headsha111$/.test(url) && method === "GET") {
      return json({ tree: { sha: headTreeSha } }) as unknown as Response;
    }
    if (/\/git\/blobs$/.test(url) && method === "POST") {
      return json({ sha: "blobsha222" }) as unknown as Response;
    }
    if (/\/git\/trees$/.test(url) && method === "POST") {
      return json({ sha: treeSha }) as unknown as Response;
    }
    if (/\/git\/commits$/.test(url) && method === "POST") {
      return json({ sha: "commitsha444" }) as unknown as Response;
    }
    if (/\/git\/refs\/heads\/.+$/.test(url) && method === "PATCH") {
      return json({ ref: "refs/heads/engineer/foo", object: { sha: "commitsha444" } }) as unknown as Response;
    }
    if (/\/issues\/\d+\/comments$/.test(url) && method === "POST") {
      return json({ id: 1 }) as unknown as Response;
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => "unexpected fetch" } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchStub);
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mocks.mintInstallationToken.mockClear();
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { installation_id: 42, repo_full_names: ["acme-co/acme"] },
              error: null,
            }),
          }),
        }),
      }),
    }),
  }));
});

const ctx = { tenant_id: "t-1", run_id: "r-1" } as const;

describe("github.update_pr_branch recipe", () => {
  it("PATCHes the EXISTING head ref (force:false), comments, never branch-creates, never opens a PR", async () => {
    const calls = installFetch();
    const res = await callGithubTool(ctx, "update_pr_branch", {
      owner: "acme-co",
      repo: "acme",
      pull_number: 7,
      head_branch: "engineer/foo",
      title: "follow-up: handle X",
      files: [{ path: "src/x.ts", action: "modify", content: "export const x = 2;" }],
    });

    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content) as { no_change: boolean; commit_sha: string | null };
    expect(out.no_change).toBe(false);
    expect(out.commit_sha).toBe("commitsha444");

    const patch = calls.find((c) => c.method === "PATCH" && /\/git\/refs\/heads\/engineer\/foo$/.test(c.url));
    expect(patch).toBeTruthy();
    expect((patch?.body as { sha?: string })?.sha).toBe("commitsha444");
    expect((patch?.body as { force?: boolean })?.force).toBe(false);

    const commit = calls.find((c) => c.method === "POST" && /\/git\/commits$/.test(c.url));
    expect((commit?.body as { parents?: string[] })?.parents).toEqual(["headsha111"]);

    expect(calls.some((c) => c.method === "POST" && /\/git\/refs$/.test(c.url))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && /\/pulls$/.test(c.url))).toBe(false);

    const comment = calls.find((c) => c.method === "POST" && /\/issues\/7\/comments$/.test(c.url));
    expect(comment).toBeTruthy();
    expect(String((comment?.body as { body?: string })?.body)).toContain("[agent-auto]");
  });

  it("NO-OP when the resulting tree equals the current head tree — no commit, no ref PATCH, no comment", async () => {
    const calls = installFetch({ treeSha: "headtree000" });
    const res = await callGithubTool(ctx, "update_pr_branch", {
      owner: "acme-co",
      repo: "acme",
      pull_number: 7,
      head_branch: "engineer/foo",
      title: "follow-up: no actual change",
      files: [{ path: "src/x.ts", action: "modify", content: "export const x = 1;" }],
    });

    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content) as { no_change: boolean; commit_sha: string | null };
    expect(out.no_change).toBe(true);
    expect(out.commit_sha).toBeNull();

    expect(calls.some((c) => c.method === "POST" && /\/git\/trees$/.test(c.url))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && /\/git\/commits$/.test(c.url))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && /\/git\/refs\/heads\//.test(c.url))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && /\/issues\/\d+\/comments$/.test(c.url))).toBe(false);
  });

  it("fails closed (branch_not_found) when the head branch does not exist — never creates it", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ url, method, body: undefined });
        if (/\/git\/ref\/heads\//.test(url) && method === "GET") {
          return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" } as unknown as Response;
        }
        return { ok: false, status: 500, json: async () => ({}), text: async () => "unexpected" } as unknown as Response;
      }),
    );
    const res = await callGithubTool(ctx, "update_pr_branch", {
      owner: "acme-co",
      repo: "acme",
      pull_number: 7,
      head_branch: "engineer/missing",
      title: "follow-up",
      files: [{ path: "src/x.ts", action: "modify", content: "export const x = 2;" }],
    });
    expect(res.is_error).toBe(true);
    const err = JSON.parse(res.content) as { error: string };
    expect(err.error).toBe("branch_not_found");
    expect(calls.some((c) => c.method === "POST" && /\/git\/refs$/.test(c.url))).toBe(false);
  });
});
