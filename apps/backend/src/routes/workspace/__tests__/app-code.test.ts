import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  error: null as { code: string; message: string } | null,
  tenantFilters: [] as string[],
}));
const auth = vi.hoisted(() => ({ tenant_id: "tenant-a" as string | null }));

vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    listForTenant: async () => [],
    get: async () => null,
    getByRun: async () => null,
    getByRepo: async () => null,
  }),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ from: () => { throw new Error("no session read expected"); } }),
  serviceClient: () => {
    const q = {
      select: () => q,
      eq: (col: string, val: string) => {
        if (col === "tenant_id") db.tenantFilters.push(val);
        return q;
      },
      maybeSingle: async () => ({ data: db.error ? null : db.row, error: db.error }),
    };
    return { from: () => q };
  },
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (!auth.tenant_id) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return null;
    }
    return { tenant_id: auth.tenant_id, user_id: "u1" };
  }),
  authMiddleware: vi.fn(),
}));

import { getWorkspaceAppCodeFile, getWorkspaceAppCodeTree } from "../app-code";
import { isSecretPath, isValidCodePath } from "@/services/provisioning/app-code";

type Res = { statusCode: number; body: unknown; status: (n: number) => Res; json: (b: unknown) => Res };
function mockRes(): Res {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

const fetchCalls: string[] = [];
function githubReturns(byUrl: (url: string) => { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetchCalls.push(url);
      const r = byUrl(url);
      return { status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    }),
  );
}

beforeEach(() => {
  process.env.GITHUB_PROVISION_TOKEN = "umbrella";
  auth.tenant_id = "tenant-a";
  db.row = {
    mode: "provisioned",
    external_ref: { github_full_name: "Praxis-build/mohit-93bd8436", default_branch: "main" },
  };
});
afterEach(() => {
  db.error = null;
  vi.unstubAllGlobals();
  fetchCalls.length = 0;
  db.tenantFilters.length = 0;
});

describe("app code tree", () => {
  it("reads only the signed-in tenant's own repo and hides env files", async () => {
    githubReturns(() => ({
      status: 200,
      body: {
        tree: [
          { path: "src", type: "tree" },
          { path: "src/app.tsx", type: "blob", size: 120 },
          { path: ".env", type: "blob", size: 80 },
          { path: "apps/api/.env.production", type: "blob", size: 80 },
          { path: ".env.example", type: "blob", size: 40 },
        ],
      },
    }));
    const res = mockRes();
    await getWorkspaceAppCodeTree({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(db.tenantFilters).toEqual(["tenant-a"]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("/repos/Praxis-build/mohit-93bd8436/git/trees/main");
    const paths = (res.body as { entries: Array<{ path: string }> }).entries.map((e) => e.path);
    expect(paths).toEqual(["src", "src/app.tsx", ".env.example"]);
    expect(res.body).toMatchObject({ branch: "main", name: "mohit-93bd8436" });
  });

  it("passes each file's blob sha through so the browser can cache by content", async () => {
    githubReturns(() => ({
      status: 200,
      body: {
        tree: [
          { path: "src", type: "tree", sha: "t1" },
          { path: "src/app.tsx", type: "blob", size: 120, sha: "b1" },
          { path: "README.md", type: "blob", size: 9 },
          { path: ".env", type: "blob", size: 80, sha: "b-secret" },
        ],
      },
    }));
    const res = mockRes();
    await getWorkspaceAppCodeTree({ query: {} } as never, res as never);
    expect((res.body as { entries: unknown[] }).entries).toEqual([
      { path: "src", type: "dir" },
      { path: "src/app.tsx", type: "file", size: 120, sha: "b1" },
      { path: "README.md", type: "file", size: 9 },
    ]);
  });

  it("never calls GitHub for a tenant without a built repo", async () => {
    db.row = { mode: "connected", external_ref: { github_full_name: "someone/else" } };
    githubReturns(() => ({ status: 200, body: { tree: [] } }));
    const res = mockRes();
    await getWorkspaceAppCodeTree({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses a malformed repo name stored on the row", async () => {
    db.row = { mode: "provisioned", external_ref: { github_full_name: "../../orgs/x" } };
    githubReturns(() => ({ status: 200, body: { tree: [] } }));
    const res = mockRes();
    await getWorkspaceAppCodeTree({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(fetchCalls).toHaveLength(0);
  });

  it("stops at auth before touching the database or GitHub", async () => {
    auth.tenant_id = null;
    githubReturns(() => ({ status: 200, body: { tree: [] } }));
    const res = mockRes();
    await getWorkspaceAppCodeTree({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(401);
    expect(db.tenantFilters).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("repo lookup failure", () => {
  it.each([
    ["tree", getWorkspaceAppCodeTree, {}],
    ["file", getWorkspaceAppCodeFile, { path: "src/index.ts" }],
  ] as const)("returns a stable code without the database message on the %s route", async (_label, handler, query) => {
    db.error = { code: "42501", message: 'permission denied for table "tenant_resources" on host db-internal-7' };
    githubReturns(() => ({ status: 200, body: {} }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = mockRes();
    await handler({ query } as never, res as never);
    const logged = errors.mock.calls.map((c) => c.join(" ")).join("\n");
    errors.mockRestore();
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("repo_lookup_failed");
    expect(JSON.stringify(res.body)).not.toContain("db-internal-7");
    expect(JSON.stringify(res.body)).not.toContain("permission denied");
    expect(logged).toContain("db-internal-7");
    expect(fetchCalls).toEqual([]);
  });
});

describe("app code file", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("returns a text file from the tenant's repo", async () => {
    githubReturns(() => ({
      status: 200,
      body: { type: "file", size: 12, encoding: "base64", content: b64("export {};\n") },
    }));
    const res = mockRes();
    await getWorkspaceAppCodeFile({ query: { path: "src/app.tsx" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ kind: "text", content: "export {};\n" });
    expect(fetchCalls[0]).toContain("/repos/Praxis-build/mohit-93bd8436/contents/src/app.tsx?ref=main");
  });

  it.each([".env", "apps/web/.env.local", "config/.ENV.production"])(
    "refuses %s without asking GitHub",
    async (path) => {
      githubReturns(() => ({ status: 200, body: { type: "file", content: b64("SECRET=1"), encoding: "base64", size: 8 } }));
      const res = mockRes();
      await getWorkspaceAppCodeFile({ query: { path } } as never, res as never);
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain("SECRET");
      expect(fetchCalls).toHaveLength(0);
    },
  );

  it.each(["../other-repo/secrets", "/etc/passwd", "src//x", "src/../../x", "a\\b", ["a", "b"]])(
    "refuses the path %j without asking GitHub",
    async (path) => {
      githubReturns(() => ({ status: 200, body: {} }));
      const res = mockRes();
      await getWorkspaceAppCodeFile({ query: { path } } as never, res as never);
      expect(res.statusCode).toBe(400);
      expect(fetchCalls).toHaveLength(0);
    },
  );

  it("encodes each path segment so a query string cannot ride along", async () => {
    githubReturns(() => ({ status: 200, body: { type: "file", size: 2, encoding: "base64", content: b64("hi") } }));
    const res = mockRes();
    await getWorkspaceAppCodeFile({ query: { path: "src/a?ref=evil#x.ts" } } as never, res as never);
    expect(fetchCalls[0]).toContain("/contents/src/a%3Fref%3Devil%23x.ts?ref=main");
  });

  it("opens an empty file as empty text, not as binary", async () => {
    githubReturns(() => ({ status: 200, body: { type: "file", size: 0, encoding: "base64", content: "" } }));
    const res = mockRes();
    await getWorkspaceAppCodeFile({ query: { path: "public/.gitkeep" } } as never, res as never);
    expect(res.body).toEqual({ path: "public/.gitkeep", kind: "text", content: "", size: 0 });
  });

  it("still reports a file without base64 content as binary", async () => {
    githubReturns(() => ({ status: 200, body: { type: "file", size: 3, encoding: "none" } }));
    const res = mockRes();
    await getWorkspaceAppCodeFile({ query: { path: "assets/big.bin" } } as never, res as never);
    expect(res.body).toEqual({ path: "assets/big.bin", kind: "binary", size: 3 });
  });

  it("reports a binary file without shipping its bytes", async () => {
    githubReturns(() => ({
      status: 200,
      body: { type: "file", size: 4, encoding: "base64", content: Buffer.from([0, 1, 2, 3]).toString("base64") },
    }));
    const res = mockRes();
    await getWorkspaceAppCodeFile({ query: { path: "public/favicon.ico" } } as never, res as never);
    expect(res.body).toEqual({ path: "public/favicon.ico", kind: "binary", size: 4 });
  });

  it("treats a directory path as not found", async () => {
    githubReturns(() => ({ status: 200, body: [{ name: "x" }] }));
    const res = mockRes();
    await getWorkspaceAppCodeFile({ query: { path: "src" } } as never, res as never);
    expect(res.statusCode).toBe(404);
  });
});

describe("symlinks and odd repo names", () => {
  it("leaves symlinks out of the tree so a link to .env cannot be listed", async () => {
    githubReturns(() => ({
      status: 200,
      body: {
        tree: [
          { path: "config.txt", type: "blob", mode: "120000", size: 4 },
          { path: "src/app.tsx", type: "blob", mode: "100644", size: 10 },
        ],
      },
    }));
    const res = mockRes();
    await getWorkspaceAppCodeTree({ query: {} } as never, res as never);
    const paths = (res.body as { entries: Array<{ path: string }> }).entries.map((e) => e.path);
    expect(paths).toEqual(["src/app.tsx"]);
  });

  it("refuses a read that GitHub resolved to a different file, e.g. a symlink to .env", async () => {
    const b64 = Buffer.from("SECRET=1", "utf8").toString("base64");
    githubReturns(() => ({ status: 200, body: { type: "file", path: ".env", size: 8, encoding: "base64", content: b64 } }));
    const res = mockRes();
    await getWorkspaceAppCodeFile({ query: { path: "config.txt" } } as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
  });

  it.each(["../x", "Praxis-build/..", "./x"])("never calls GitHub for a stored repo name like %s", async (name) => {
    db.row = { mode: "provisioned", external_ref: { github_full_name: name } };
    githubReturns(() => ({ status: 200, body: { tree: [] } }));
    const res = mockRes();
    await getWorkspaceAppCodeTree({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("path rules", () => {
  it("keeps example env files visible", () => {
    expect(isSecretPath(".env.example")).toBe(false);
    expect(isSecretPath("web/.env.sample")).toBe(false);
    expect(isSecretPath("src/env.ts")).toBe(false);
    expect(isSecretPath(".envrc")).toBe(true);
  });
  it("accepts ordinary nested paths", () => {
    expect(isValidCodePath("src/routes/index.tsx")).toBe(true);
    expect(isValidCodePath(".lovable/project.json")).toBe(true);
  });
});
