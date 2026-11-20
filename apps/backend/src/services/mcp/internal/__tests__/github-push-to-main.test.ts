
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

import { callGithubTool, isProvisionedUmbrellaOwner, mapInOrderWithConcurrency } from "../github";

type FetchCall = { url: string; method: string; body: unknown };

function installFetch(): FetchCall[] {
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
    if (/\/git\/refs\/heads\/main$/.test(url) && method === "PATCH") {
      return json({ ref: "refs/heads/main", object: { sha: "commitsha444" } }) as unknown as Response;
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => "unexpected fetch" } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchStub);
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.PRAXIS_GITHUB_ORG = "Praxis-build";
  mocks.mintInstallationToken.mockClear();
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { installation_id: 42 }, error: null }),
          }),
        }),
      }),
    }),
  }));
});

const ctx = { tenant_id: "t-1", run_id: "r-1" } as const;

describe("isProvisionedUmbrellaOwner", () => {
  it("matches the configured umbrella org, case-insensitively", () => {
    process.env.PRAXIS_GITHUB_ORG = "Praxis-build";
    expect(isProvisionedUmbrellaOwner("Praxis-build")).toBe(true);
    expect(isProvisionedUmbrellaOwner("praxis-build")).toBe(true);
    expect(isProvisionedUmbrellaOwner(" PRAXIS-BUILD ")).toBe(true);
  });
  it("does not match a customer org or empty owner", () => {
    process.env.PRAXIS_GITHUB_ORG = "Praxis-build";
    expect(isProvisionedUmbrellaOwner("rravi149")).toBe(false);
    expect(isProvisionedUmbrellaOwner("acme")).toBe(false);
    expect(isProvisionedUmbrellaOwner(undefined)).toBe(false);
    expect(isProvisionedUmbrellaOwner("")).toBe(false);
  });
});

describe("github.push_to_main recipe", () => {
  it("PATCHes refs/heads/main; never branch-creates, never opens a PR", async () => {
    const calls = installFetch();
    const res = await callGithubTool(ctx, "push_to_main", {
      owner: "praxis-built",
      repo: "acme",
      base_branch: "main",
      title: "build: implement idea",
      files: [{ path: "app/page.tsx", action: "create", content: "export default () => null;" }],
    });

    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content) as { pushed: boolean; branch: string; commit_sha: string };
    expect(out.pushed).toBe(true);
    expect(out.branch).toBe("main");
    expect(out.commit_sha).toBe("commitsha444");

    const patch = calls.find((c) => c.method === "PATCH" && /\/git\/refs\/heads\/main$/.test(c.url));
    expect(patch).toBeTruthy();
    expect((patch?.body as { sha?: string; force?: boolean })?.sha).toBe("commitsha444");
    expect((patch?.body as { force?: boolean })?.force).toBe(false);

    const branchCreate = calls.find((c) => c.method === "POST" && /\/git\/refs$/.test(c.url));
    expect(branchCreate).toBeUndefined();

    const prOpen = calls.find((c) => c.method === "POST" && /\/pulls$/.test(c.url));
    expect(prOpen).toBeUndefined();

    expect(calls.some((c) => c.method === "POST" && /\/git\/blobs$/.test(c.url))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && /\/git\/trees$/.test(c.url))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && /\/git\/commits$/.test(c.url))).toBe(true);
  });

  it("delete action commits a null-sha tree entry (no blob) and still PATCHes main", async () => {
    const calls = installFetch();
    const res = await callGithubTool(ctx, "push_to_main", {
      owner: "praxis-built",
      repo: "acme",
      base_branch: "main",
      title: "build: remove file",
      files: [{ path: "old.ts", action: "delete" }],
    });
    expect(res.is_error).toBe(false);
    expect(calls.some((c) => c.method === "POST" && /\/git\/blobs$/.test(c.url))).toBe(false);
    const tree = calls.find((c) => c.method === "POST" && /\/git\/trees$/.test(c.url));
    const entries = (tree?.body as { tree?: Array<{ sha: string | null }> })?.tree ?? [];
    expect(entries[0]?.sha).toBeNull();
    expect(calls.some((c) => c.method === "PATCH" && /\/git\/refs\/heads\/main$/.test(c.url))).toBe(true);
  });

  it("(false-LIVE P0, 2026-06-27) push_to_main to an UMBRELLA-org repo uses the PAT even when the tenant has its OWN github connector", async () => {
    process.env.PRAXIS_GITHUB_ORG = "Praxis-build";
    process.env.GITHUB_PROVISION_TOKEN = "ghp_umbrella_pat_yyy";
    mocks.serviceClientMock.mockImplementation(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { installation_id: 131251677, account_login: "rravi149" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }));
    const calls = installFetch();
    const res = await callGithubTool(ctx, "push_to_main", {
      owner: "Praxis-build",
      repo: "localpro-6ec4d609",
      base_branch: "main",
      title: "build: implement LocalPro marketplace",
      files: [{ path: "app/page.tsx", action: "create", content: "export default () => null;" }],
    });
    expect(res.is_error).toBe(false);
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === "PATCH" && /\/git\/refs\/heads\/main$/.test(c.url))).toBe(true);
  });

  it("REGRESSION: push_to_main to a NON-umbrella (customer) repo still uses the tenant installation token", async () => {
    process.env.PRAXIS_GITHUB_ORG = "Praxis-build";
    process.env.GITHUB_PROVISION_TOKEN = "ghp_umbrella_pat_yyy";
    const calls = installFetch();
    const res = await callGithubTool(ctx, "push_to_main", {
      owner: "rravi149",
      repo: "upcar",
      base_branch: "main",
      title: "build: a customer-repo change",
      files: [{ path: "app/page.tsx", action: "create", content: "export default () => null;" }],
    });
    expect(res.is_error).toBe(false);
    expect(mocks.mintInstallationToken).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "PATCH" && /\/git\/refs\/heads\/main$/.test(c.url))).toBe(true);
  });

  it("autopilot connector (Praxis-build, no installation_id) uses GITHUB_PROVISION_TOKEN PAT (w51 P0)", async () => {
    process.env.GITHUB_PROVISION_TOKEN = "ghp_autopilot_pat_xxx";
    mocks.serviceClientMock.mockImplementation(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { installation_id: null, account_login: "Praxis-build" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }));
    const calls = installFetch();
    const res = await callGithubTool(ctx, "push_to_main", {
      owner: "Praxis-build",
      repo: "gt-wave5-todo-0e6a4959",
      base_branch: "main",
      title: "build: implement to-do app",
      files: [{ path: "app/page.tsx", action: "create", content: "export default () => null;" }],
    });
    expect(res.is_error).toBe(false);
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === "PATCH" && /\/git\/refs\/heads\/main$/.test(c.url))).toBe(true);
  });
});

describe("github.push_to_main creates blobs in parallel, at most five at a time", () => {
  type Pending = { path: string; resolve: () => void };

  function installControlledFetch(opts: { failPaths?: Record<string, number> } = {}) {
    const calls: FetchCall[] = [];
    const pending: Pending[] = [];
    let inFlight = 0;
    const seen = { maxInFlight: 0 };
    const json = (obj: unknown, status = 200) =>
      ({
        ok: status < 400,
        status,
        json: async () => obj,
        text: async () => JSON.stringify(obj),
      }) as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (/\/git\/ref\/heads\//.test(url) && method === "GET") return json({ object: { sha: "base" } });
        if (/\/git\/blobs$/.test(url) && method === "POST") {
          const text = Buffer.from((body as { content: string }).content, "base64").toString("utf-8");
          const path = text.replace(/^content-of:/, "");
          inFlight += 1;
          seen.maxInFlight = Math.max(seen.maxInFlight, inFlight);
          await new Promise<void>((resolve) => pending.push({ path, resolve }));
          inFlight -= 1;
          const fail = opts.failPaths?.[path];
          if (fail) return json({ message: "nope" }, fail);
          return json({ sha: `sha-of:${path}` });
        }
        if (/\/git\/trees$/.test(url) && method === "POST") return json({ sha: "tree" });
        if (/\/git\/commits$/.test(url) && method === "POST") return json({ sha: "commit" });
        if (/\/git\/refs\/heads\/main$/.test(url) && method === "PATCH") return json({ object: { sha: "commit" } });
        return json({}, 500);
      }),
    );
    return { calls, pending, seen };
  }

  const fileList = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      i % 4 === 3
        ? { path: `gone-${i}.ts`, action: "delete" as const }
        : { path: `f-${i}.ts`, action: "create" as const, content: `content-of:f-${i}.ts` },
    );

  async function drain(pending: Pending[], order: "lifo" | "fifo", done: () => boolean) {
    while (!done()) {
      await new Promise((r) => setTimeout(r, 0));
      const next = order === "lifo" ? pending.pop() : pending.shift();
      next?.resolve();
    }
  }

  it("keeps five blob requests in flight and builds the tree in file order even when later blobs finish first", async () => {
    const { calls, pending, seen } = installControlledFetch();
    const files = fileList(16);
    let settled = false;
    const run = callGithubTool(ctx, "push_to_main", {
      owner: "praxis-built",
      repo: "acme",
      base_branch: "main",
      title: "build",
      files,
    }).finally(() => (settled = true));
    await vi.waitFor(() => expect(pending.length).toBe(5));
    expect(seen.maxInFlight).toBe(5);
    await drain(pending, "lifo", () => settled);
    const res = await run;
    expect(res.is_error).toBe(false);
    expect(seen.maxInFlight).toBe(5);
    const tree = calls.find((c) => c.method === "POST" && /\/git\/trees$/.test(c.url));
    const entries = (tree?.body as { tree: Array<{ path: string; sha: string | null }> }).tree;
    expect(entries).toEqual(
      files.map((f) => ({
        path: f.path,
        mode: "100644",
        type: "blob",
        sha: f.action === "delete" ? null : `sha-of:${f.path}`,
      })),
    );
    expect(calls.filter((c) => /\/git\/blobs$/.test(c.url))).toHaveLength(12);
  });

  it("a failed blob fails the push with the FIRST failing file in tree order, starts nothing new, and never commits", async () => {
    const { calls, pending } = installControlledFetch({ failPaths: { "f-2.ts": 502, "f-5.ts": 500 } });
    let settled = false;
    const run = callGithubTool(ctx, "push_to_main", {
      owner: "praxis-built",
      repo: "acme",
      base_branch: "main",
      title: "build",
      files: fileList(16),
    });
    run.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() => expect(pending.length).toBe(5));
    await drain(pending, "lifo", () => settled);
    await expect(run).rejects.toThrow(/^push_to_main blob f-2\.ts HTTP 502$/);
    expect(calls.some((c) => /\/git\/trees$/.test(c.url))).toBe(false);
    expect(calls.some((c) => /\/git\/commits$/.test(c.url))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const blobPaths = calls
      .filter((c) => /\/git\/blobs$/.test(c.url))
      .map((c) => Buffer.from((c.body as { content: string }).content, "base64").toString("utf-8"));
    expect(blobPaths).not.toContain("content-of:f-14.ts");
  });

  it("a file with no content is refused before any blob is created", async () => {
    const { calls } = installControlledFetch();
    const res = await callGithubTool(ctx, "push_to_main", {
      owner: "praxis-built",
      repo: "acme",
      base_branch: "main",
      title: "build",
      files: [
        { path: "a.ts", action: "create", content: "content-of:a.ts" },
        { path: "b.ts", action: "modify" },
      ],
    });
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("push_to_main: file b.ts action=modify requires content");
    expect(calls.some((c) => /\/git\/blobs$/.test(c.url))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("mapInOrderWithConcurrency", () => {
  it("never runs more than the limit at once and returns results in input order", async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapInOrderWithConcurrency([30, 5, 20, 1, 10, 2, 7], 3, async (ms, i) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight -= 1;
      return `${i}:${ms}`;
    });
    expect(max).toBe(3);
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10", "5:2", "6:7"]);
  });

  it("an empty list resolves to an empty list", async () => {
    await expect(mapInOrderWithConcurrency([], 5, async () => 1)).resolves.toEqual([]);
  });

  it("rejects with the lowest-index failure even when a later one fails first", async () => {
    const started: number[] = [];
    const err = await mapInOrderWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 4, async (i) => {
      started.push(i);
      if (i === 1) {
        await new Promise((r) => setTimeout(r, 20));
        throw new Error("one");
      }
      if (i === 3) throw new Error("three");
      await new Promise((r) => setTimeout(r, 5));
      return i;
    }).catch((e) => e);
    expect((err as Error).message).toBe("one");
    expect(started).not.toContain(7);
  });
});
