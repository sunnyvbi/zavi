import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const db = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));
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
      eq: () => q,
      maybeSingle: async () => ({ data: db.row, error: null }),
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

import { getWorkspaceAppCodeZip } from "../app-code";
import { APP_CODE_ZIP_MAX_BYTES, AppCodeNotFound, AppCodeTooLarge, buildAppCodeZip } from "@/services/provisioning/app-code";

type Res = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status: (n: number) => Res;
  json: (b: unknown) => Res;
  send: (b: unknown) => Res;
  setHeader: (k: string, v: string) => void;
};
function mockRes(): Res {
  const res: Res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(n) {
      res.statusCode = n;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    },
    send(b) {
      res.body = b;
      return res;
    },
    setHeader(k, v) {
      res.headers[k.toLowerCase()] = v;
    },
  };
  return res;
}

const SHA = "a".repeat(40);

function unixModes(zip: Uint8Array): Record<string, number> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: Record<string, number> = {};
  for (let i = 0; i + 46 <= zip.byteLength; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLen = view.getUint16(i + 28, true);
    const external = view.getUint32(i + 38, true);
    out[strFromU8(zip.subarray(i + 46, i + 46 + nameLen))] = external >>> 16;
  }
  return out;
}
type Entry = { content: string; mode?: string };

function zipball(files: Record<string, Entry>): Uint8Array {
  const entries: Record<string, Uint8Array> = { "Praxis-build-site-1a2b3c4/": new Uint8Array() };
  for (const [p, f] of Object.entries(files)) entries[`Praxis-build-site-1a2b3c4/${p}`] = strToU8(f.content);
  return zipSync(entries);
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

const fetchCalls: string[] = [];
function repoIs(files: Record<string, Entry>, opts: { archive?: Uint8Array; treeSizes?: Record<string, number>; status?: number; text?: string } = {}) {
  const archive = opts.archive ?? zipball(files);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetchCalls.push(url);
      if (opts.status) return { status: opts.status, json: async () => ({}), text: async () => opts.text ?? "", body: null };
      if (url.includes("/commits/")) return { status: 200, json: async () => ({ sha: SHA }), text: async () => "", body: null };
      if (url.includes("/git/trees/")) {
        return {
          status: 200,
          json: async () => ({
            tree: Object.entries(files).map(([path, f]) => ({
              path,
              type: "blob",
              mode: f.mode ?? "100644",
              size: opts.treeSizes?.[path] ?? strToU8(f.content).byteLength,
            })),
          }),
          text: async () => "",
          body: null,
        };
      }
      return { status: 200, json: async () => ({}), text: async () => "", body: stream(archive) };
    }),
  );
}

beforeEach(() => {
  process.env.GITHUB_PROVISION_TOKEN = "umbrella";
  auth.tenant_id = "tenant-a";
  db.row = { mode: "provisioned", external_ref: { github_full_name: "Praxis-build/site-93bd8436" } };
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchCalls.length = 0;
});

describe("download code (zip)", () => {
  it("packs the tenant's own repo under one folder, without env files or preview tooling", async () => {
    repoIs({
      "package.json": { content: "{}" },
      "src/App.tsx": { content: "export default function App() {}" },
      "scripts/setup.sh": { content: "#!/bin/sh\necho hi\n", mode: "100755" },
      "public/link.svg": { content: "logo.svg", mode: "120000" },
      ".env": { content: "SECRET=1" },
      "server/.env.production": { content: "SECRET=2" },
      ".env.example": { content: "KEY=" },
      "public/zavi-picker.js": { content: "picker()" },
      "app/layout.tsx": { content: '<html><body>{children}<script src="/zavi-picker.js" /></body></html>' },
    });
    const res = mockRes();
    await getWorkspaceAppCodeZip({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(fetchCalls).toEqual([
      "https://api.github.com/repos/Praxis-build/site-93bd8436/commits/main",
      `https://api.github.com/repos/Praxis-build/site-93bd8436/git/trees/${SHA}?recursive=1`,
      `https://api.github.com/repos/Praxis-build/site-93bd8436/zipball/${SHA}`,
    ]);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="site-93bd8436.zip"');
    expect(res.headers["access-control-expose-headers"]).toBe("Content-Disposition");
    const out = unzipSync(new Uint8Array(res.body as Buffer));
    expect(Object.keys(out).sort()).toEqual([
      "site-93bd8436/.env.example",
      "site-93bd8436/app/layout.tsx",
      "site-93bd8436/package.json",
      "site-93bd8436/public/link.svg",
      "site-93bd8436/scripts/setup.sh",
      "site-93bd8436/src/App.tsx",
    ]);
    const modes = unixModes(new Uint8Array(res.body as Buffer));
    expect(modes["site-93bd8436/scripts/setup.sh"]).toBe(0o100755);
    expect(modes["site-93bd8436/public/link.svg"]).toBe(0o120777);
    expect(modes["site-93bd8436/src/App.tsx"]).toBe(0o100644);
    expect(strFromU8(out["site-93bd8436/app/layout.tsx"])).not.toContain("zavi-picker");
    expect(strFromU8(out["site-93bd8436/src/App.tsx"])).toBe("export default function App() {}");
  });

  it("answers 409 and never calls GitHub when there is no built app", async () => {
    db.row = null;
    repoIs({ "a.txt": { content: "a" } });
    const res = mockRes();
    await getWorkspaceAppCodeZip({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(fetchCalls).toHaveLength(0);
  });

  it("stops at auth before touching GitHub", async () => {
    auth.tenant_id = null;
    repoIs({ "a.txt": { content: "a" } });
    const res = mockRes();
    await getWorkspaceAppCodeZip({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  it("maps a missing repo to 404 and a GitHub failure to 502 without leaking the body", async () => {
    repoIs({}, { status: 404 });
    const missing = mockRes();
    await getWorkspaceAppCodeZip({ query: {} } as never, missing as never);
    expect(missing.statusCode).toBe(404);

    repoIs({}, { status: 500, text: "upstream token ghp_secret broke" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = mockRes();
    await getWorkspaceAppCodeZip({ query: {} } as never, failed as never);
    errors.mockRestore();
    expect(failed.statusCode).toBe(502);
    expect(JSON.stringify(failed.body)).not.toContain("ghp_secret");
  });
});

describe("buildAppCodeZip limits", () => {
  const args = { full_name: "o/r", branch: "main", token: "t" };
  const fetchNow = () => (globalThis as unknown as { fetch: Parameters<typeof buildAppCodeZip>[1] }).fetch;

  it("refuses a repo past the size limit from its tree, before downloading anything", async () => {
    repoIs({ "big.bin": { content: "x" } }, { treeSizes: { "big.bin": APP_CODE_ZIP_MAX_BYTES + 1 } });
    await expect(buildAppCodeZip(args, fetchNow())).rejects.toBeInstanceOf(AppCodeTooLarge);
    expect(fetchCalls.some((u) => u.includes("/zipball/"))).toBe(false);
  });

  it("stops reading an archive that is bigger than its tree says", async () => {
    const huge = new Uint8Array(3 * 1024 * 1024);
    repoIs({ "a.txt": { content: "a" } }, { archive: huge });
    await expect(buildAppCodeZip(args, fetchNow())).rejects.toBeInstanceOf(AppCodeTooLarge);
  });

  it("never unpacks a file past the size its tree entry gives", async () => {
    repoIs({ "a.txt": { content: "a".repeat(5000) }, "b.txt": { content: "b" } }, { treeSizes: { "a.txt": 10 } });
    const { zip } = await buildAppCodeZip(args, fetchNow());
    expect(Object.keys(unzipSync(zip))).toEqual(["r/b.txt"]);
  });

  it("counts files left out of the download toward the archive it reads, so a big ignored file never breaks it", async () => {
    const env = "x".repeat(2 * 1024 * 1024);
    const archive = zipSync({ "p-r-1/.env": [strToU8(env), { level: 0 }], "p-r-1/a.txt": strToU8("a") });
    repoIs({ ".env": { content: env }, "a.txt": { content: "a" } }, { archive });
    const { zip } = await buildAppCodeZip(args, fetchNow());
    expect(Object.keys(unzipSync(zip))).toEqual(["r/a.txt"]);
  });

  it("treats a repo with no files as not found", async () => {
    repoIs({});
    await expect(buildAppCodeZip(args, fetchNow())).rejects.toBeInstanceOf(AppCodeNotFound);
  });
});
