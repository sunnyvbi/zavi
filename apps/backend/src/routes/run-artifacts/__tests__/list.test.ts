
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const RUN_A = "11111111-1111-4111-1111-111111111111";
const RUN_B = "22222222-2222-4222-2222-222222222222";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  allRows: [] as Record<string, unknown>[],
  signCalls: [] as string[],
  batchCalls: [] as { bucket: string; paths: string[] }[],
  singleCalls: [] as { path: string; download: unknown }[],
  failPaths: new Set<string>(),
  failBatch: false,
  failBatchIndex: -1,
  sites: [] as Record<string, unknown>[],
  siteReads: [] as string[],
  sitesFail: false,
  runs: [] as { id: string; tenant_id: string; status: string }[],
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

const heals = vi.hoisted(() => ({ calls: [] as Array<[string, string[]]> }));
vi.mock("@/services/sites/site-thumbnail-capture", () => ({
  requestThumbnailHeals: async (tenant: string, ids: string[]) => {
    heals.calls.push([tenant, ids]);
  },
}));

vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    listForTenant: async (tenantId: string) => {
      mocks.siteReads.push(tenantId);
      if (mocks.sitesFail) throw new Error("sites unavailable");
      return mocks.sites.filter((s) => s.tenant_id === tenantId);
    },
  }),
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      let tenantFilter: string | null = null;
      if (table === "conductor_runs") {
        const runs = {
          select: () => runs,
          eq: (col: string, val: string) => {
            if (col === "tenant_id") tenantFilter = val;
            return runs;
          },
          in: (_col: string, ids: string[]) =>
            Promise.resolve({
              data: mocks.runs.filter((r) => r.tenant_id === tenantFilter && ids.includes(r.id)),
              error: null,
            }),
        };
        return runs;
      }
      const chain = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === "tenant_id") tenantFilter = val;
          return chain;
        },
        order: () => chain,
        limit: () => {
          const data = mocks.allRows.filter((r) => r.tenant_id === tenantFilter);
          return Promise.resolve({ data, error: null });
        },
      };
      return chain;
    },
  }),
  serviceClient: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, _ttl: number, opts?: { download?: unknown }) => {
          mocks.signCalls.push(path);
          mocks.singleCalls.push({ path, download: opts?.download });
          return {
            data: { signedUrl: `https://signed.example/${path}?tok=x` },
            error: null,
          };
        },
        createSignedUrls: async (paths: string[]) => {
          mocks.signCalls.push(...paths);
          mocks.batchCalls.push({ bucket, paths });
          if (mocks.failBatch || mocks.batchCalls.length - 1 === mocks.failBatchIndex) {
            return { data: null, error: { message: "storage unavailable" } };
          }
          return {
            data: [...paths].reverse().map((path) =>
              mocks.failPaths.has(path)
                ? { path, signedUrl: null, error: "not found" }
                : { path, signedUrl: `https://signed.example/${path}?tok=x`, error: null },
            ),
            error: null,
          };
        },
      }),
    },
  }),
}));

import { listRunArtifacts } from "../list";
import { clearSignedUrlCache } from "@/services/run-artifacts/signed-url-cache";

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

beforeEach(() => {
  clearSignedUrlCache();
  mocks.requireAuth.mockReset();
  mocks.signCalls = [];
  mocks.batchCalls = [];
  mocks.singleCalls = [];
  mocks.failPaths = new Set();
  mocks.failBatch = false;
  mocks.failBatchIndex = -1;
  mocks.sites = [];
  mocks.siteReads = [];
  mocks.sitesFail = false;
  mocks.runs = [];
  mocks.allRows = [
    {
      id: "art-a1", tenant_id: TENANT_A, run_id: RUN_A,
      storage_path: `${TENANT_A}/${RUN_A}/deck.pdf`,
      filename: "deck.pdf", mime: "application/pdf", bytes: 1234,
      created_at: "2026-07-06T10:00:00Z",
    },
    {
      id: "art-b1", tenant_id: TENANT_B, run_id: RUN_B,
      storage_path: `${TENANT_B}/${RUN_B}/secret.pdf`,
      filename: "secret.pdf", mime: "application/pdf", bytes: 9999,
      created_at: "2026-07-06T11:00:00Z",
    },
  ];
});

describe("listRunArtifacts — tenant isolation", () => {
  it("tenant A lists ONLY tenant A's artifacts, never tenant B's", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, access_token: "tok-a" });
    const res = mockRes();
    await listRunArtifacts({} as never, res as never);

    expect(res.statusCode).toBe(200);
    const b = res.body as { enabled: boolean; artifacts: { id: string; preview_url: string | null }[] };
    expect(b.artifacts.map((a) => a.id)).toEqual(["art-a1"]);
    expect(b.artifacts.find((a) => a.id === "art-b1")).toBeUndefined();
    expect(mocks.signCalls).toEqual([`${TENANT_A}/${RUN_A}/deck.pdf`]);
    expect(mocks.signCalls.some((p) => p.startsWith(`${TENANT_B}/`))).toBe(false);
  });

  it("tenant B, symmetrically, sees only its own artifact", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_B, access_token: "tok-b" });
    const res = mockRes();
    await listRunArtifacts({} as never, res as never);
    const b = res.body as { artifacts: { id: string; preview_url: string | null }[] };
    expect(b.artifacts.map((a) => a.id)).toEqual(["art-b1"]);
    expect(b.artifacts[0].preview_url).toContain(`${TENANT_B}/${RUN_B}/secret.pdf`);
  });

  it("searches artifact titles and filenames without crossing the tenant boundary", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, access_token: "tok-a" });
    const res = mockRes();
    await listRunArtifacts({ query: { q: "deck" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { artifacts: { id: string }[] };
    expect(body.artifacts.map((artifact) => artifact.id)).toEqual(["art-a1"]);
    expect(mocks.signCalls).toEqual([`${TENANT_A}/${RUN_A}/deck.pdf`]);
  });

  it("returns metadata but NO preview_url for a non-tenant-prefixed storage_path", async () => {
    mocks.allRows = [{
      id: "art-bad", tenant_id: TENANT_A, run_id: RUN_A,
      storage_path: `${TENANT_B}/${RUN_B}/leak.pdf`,
      filename: "leak.pdf", mime: "application/pdf", bytes: 10,
      created_at: "2026-07-06T12:00:00Z",
    }];
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, access_token: "tok-a" });
    const res = mockRes();
    await listRunArtifacts({} as never, res as never);
    const b = res.body as { artifacts: { id: string; preview_url: string | null }[] };
    expect(b.artifacts).toHaveLength(1);
    expect(b.artifacts[0].preview_url).toBeNull();
    expect(mocks.signCalls).toEqual([]);
  });

  it("401s when unauthenticated (requireAuth returns null)", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    const res = mockRes();
    await listRunArtifacts({} as never, res as never);
    expect(res.body).toBeUndefined();
    expect(mocks.signCalls).toEqual([]);
  });
});

describe("listRunArtifacts — built sites (QA B35)", () => {
  const site = (over: Record<string, unknown>) => ({
    id: "site-a1",
    tenant_id: TENANT_A,
    root_conductor_run_id: "run-root-a1",
    label: "mile-high-coffee-693dfbdb-523441",
    hostname: "mile-high-coffee-693dfbdb-523441.zaviagent.com",
    status: "live",
    live_url: "https://mile-high-coffee-693dfbdb-523441.zaviagent.com",
    live_deploy_id: "dep-1",
    owner_email: "owner@example.com",
    supabase_url: "https://secret-project.supabase.co",
    created_at: "2026-10-01T12:23:18Z",
    updated_at: "2026-10-01T12:27:21Z",
    ...over,
  });

  beforeEach(() => {
    mocks.sites = [
      site({}),
      site({ id: "site-a2", label: "lucky-paws-693dfbdb-687f66", hostname: "lucky-paws-693dfbdb-687f66.zaviagent.com", status: "failed", live_deploy_id: null, live_url: null }),
      site({ id: "site-a3", status: "fell_back_old" }),
      site({ id: "site-b1", tenant_id: TENANT_B, label: "secret-shop-aaaaaaaa-bbbbbb", hostname: "secret-shop-aaaaaaaa-bbbbbb.zaviagent.com" }),
    ];
  });

  it("lists the tenant's built sites with a clean name, never another tenant's", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, access_token: "tok-a" });
    const res = mockRes();
    await listRunArtifacts({} as never, res as never);
    const body = res.body as { artifacts: unknown[]; sites: Record<string, unknown>[] };
    expect(mocks.siteReads).toEqual([TENANT_A]);
    expect(body.sites.map((s) => s.id)).toEqual(["site-a1", "site-a2"]);
    expect(body.sites[0]).toEqual({
      id: "site-a1",
      title: "Mile High Coffee",
      hostname: "mile-high-coffee-693dfbdb-523441.zaviagent.com",
      status: "live",
      live_url: "https://mile-high-coffee-693dfbdb-523441.zaviagent.com",
      build_session_id: "run-root-a1",
      created_at: "2026-10-01T12:23:18Z",
      updated_at: "2026-10-01T12:27:21Z",
      thumbnail_url: null,
    });
    expect(body.sites[1].live_url).toBeNull();
    expect(JSON.stringify(body.sites)).not.toContain("secret-project");
    expect(JSON.stringify(body.sites)).not.toContain("owner@example.com");
    expect(body.artifacts).toHaveLength(1);
  });

  it("marks a still-building site whose build run is done as built (not published)", async () => {
    mocks.sites = [
      site({ id: "site-built", status: "building", root_conductor_run_id: "run-done", live_url: null, live_deploy_id: null }),
      site({ id: "site-going", status: "provisioning", root_conductor_run_id: "run-busy", live_url: null, live_deploy_id: null }),
      site({ id: "site-foreign-run", status: "building", root_conductor_run_id: "run-b", live_url: null, live_deploy_id: null }),
    ];
    mocks.runs = [
      { id: "run-done", tenant_id: TENANT_A, status: "done" },
      { id: "run-busy", tenant_id: TENANT_A, status: "running" },
      { id: "run-b", tenant_id: TENANT_B, status: "done" },
    ];
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, access_token: "tok-a" });
    const res = mockRes();
    await listRunArtifacts({} as never, res as never);
    const sites = (res.body as { sites: Record<string, unknown>[] }).sites;
    expect(sites.find((s) => s.id === "site-built")?.built).toBe(true);
    expect(sites.find((s) => s.id === "site-going")?.built).toBeUndefined();
    expect(sites.find((s) => s.id === "site-foreign-run")?.built).toBeUndefined();
  });

  it("signs each site's own thumbnail; a path naming another site or tenant is never signed", async () => {
    const SITE_1 = "33333333-3333-4333-8333-333333333333";
    const SITE_2 = "44444444-4444-4444-8444-444444444444";
    mocks.sites = [
      site({ id: SITE_1, thumbnail_path: `${TENANT_A}/${SITE_1}/site-thumb-0123456789ab.jpg` }),
      site({ id: SITE_2, thumbnail_path: `${TENANT_B}/${SITE_2}/site-thumb-0123456789ab.jpg` }),
      site({ id: "site-none" }),
    ];
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, access_token: "tok-a" });
    const res = mockRes();
    await listRunArtifacts({ query: { type: "website" } } as never, res as never);
    const sites = (res.body as { sites: { id: string; thumbnail_url: string | null }[] }).sites;
    expect(sites.find((s) => s.id === SITE_1)?.thumbnail_url).toMatch(/site-thumb-0123456789ab\.jpg/);
    expect(sites.find((s) => s.id === SITE_2)?.thumbnail_url).toBeNull();
    expect(sites.find((s) => s.id === "site-none")?.thumbnail_url).toBeNull();
    expect(mocks.signCalls.some((p) => p.includes(TENANT_B))).toBe(false);
  });

  it("asks the worker to heal finished sites with no thumbnail (live or built), never one still building", async () => {
    heals.calls.length = 0;
    const SITE_1 = "33333333-3333-4333-8333-333333333333";
    mocks.sites = [
      site({ id: SITE_1, thumbnail_path: `${TENANT_A}/${SITE_1}/site-thumb-0123456789ab.jpg` }),
      site({ id: "live-none" }),
      site({ id: "built-none", status: "building", root_conductor_run_id: "run-done", live_url: null, live_deploy_id: null }),
      site({ id: "going-none", status: "building", root_conductor_run_id: "run-busy", live_url: null, live_deploy_id: null }),
    ];
    mocks.runs = [
      { id: "run-done", tenant_id: TENANT_A, status: "done" },
      { id: "run-busy", tenant_id: TENANT_A, status: "running" },
    ];
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, access_token: "tok-a" });
    await listRunArtifacts({ query: { type: "website" } } as never, mockRes() as never);
    expect(heals.calls).toEqual([[TENANT_A, ["live-none", "built-none"]]]);
  });

  it("searches site names and hostnames, and skips sites for another type or a channel", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, access_token: "tok-a" });
    const search = mockRes();
    await listRunArtifacts({ query: { q: "LUCKY" } } as never, search as never);
    expect((search.body as { sites: { id: string }[] }).sites.map((s) => s.id)).toEqual(["site-a2"]);

    const websites = mockRes();
    await listRunArtifacts({ query: { type: "website" } } as never, websites as never);
    expect((websites.body as { sites: unknown[] }).sites).toHaveLength(2);

    mocks.siteReads = [];
    const images = mockRes();
    await listRunArtifacts({ query: { type: "image" } } as never, images as never);
    expect((images.body as { sites: unknown[] }).sites).toEqual([]);
    expect(mocks.siteReads).toEqual([]);
  });

  it("a failed sites read lists no sites but still lists the files", async () => {
    mocks.sitesFail = true;
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, access_token: "tok-a" });
    const res = mockRes();
    await listRunArtifacts({} as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { artifacts: { id: string }[]; sites: unknown[] };
    expect(body.sites).toEqual([]);
    expect(body.artifacts.map((a) => a.id)).toEqual(["art-a1"]);
  });
});

describe("listRunArtifacts — batch signing", () => {
  const pdfRows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `art-${index}`,
      tenant_id: TENANT_A,
      run_id: RUN_A,
      storage_path: `${TENANT_A}/${RUN_A}/file-${index}.pdf`,
      filename: `file-${index}.pdf`,
      mime: "application/pdf",
      bytes: 10,
      created_at: "2026-09-14T10:00:00Z",
    }));

  async function list() {
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, access_token: "tok-a" });
    const res = mockRes();
    await listRunArtifacts({} as never, res as never);
    return res;
  }

  it("signs one createSignedUrls call per 100 paths and maps URLs back by path", async () => {
    const rows = pdfRows(250);
    mocks.allRows = rows;
    const res = await list();

    expect(res.statusCode).toBe(200);
    expect(mocks.batchCalls.map((call) => call.paths.length)).toEqual([100, 100, 50]);
    expect(mocks.singleCalls).toEqual([]);
    const body = res.body as { artifacts: { id: string; preview_url: string | null }[] };
    expect(body.artifacts.map((artifact) => artifact.id)).toEqual(rows.map((row) => row.id));
    body.artifacts.forEach((artifact, index) => {
      expect(artifact.preview_url).toBe(
        `https://signed.example/${rows[index].storage_path}?tok=x`,
      );
    });
  });

  it("groups by bucket and never sends an off-allowlist bucket to storage", async () => {
    mocks.allRows = [
      { ...pdfRows(1)[0], id: "art-video", storage_path: `${TENANT_A}/${RUN_A}/clip.mp4`, bucket: "launch-video-artifacts" },
      { ...pdfRows(2)[1], id: "art-doc" },
      { ...pdfRows(3)[2], id: "art-evil", bucket: "some-other-bucket" },
    ];
    const res = await list();

    expect(mocks.batchCalls.map((call) => call.bucket).sort()).toEqual(["agent-artifacts", "launch-video-artifacts"]);
    expect(mocks.signCalls.some((path) => path.endsWith("file-2.pdf"))).toBe(false);
    const byId = Object.fromEntries(
      (res.body as { artifacts: { id: string; preview_url: string | null }[] }).artifacts.map((a) => [a.id, a.preview_url]),
    );
    expect(byId["art-video"]).toContain("clip.mp4");
    expect(byId["art-doc"]).toContain("file-1.pdf");
    expect(byId["art-evil"]).toBeNull();
  });

  it("a path storage refuses gets null, the rest still sign", async () => {
    const rows = pdfRows(3);
    mocks.allRows = rows;
    mocks.failPaths = new Set([rows[1].storage_path]);
    const res = await list();

    const body = res.body as { artifacts: { preview_url: string | null }[] };
    expect(body.artifacts.map((artifact) => artifact.preview_url !== null)).toEqual([true, false, true]);
  });

  it("a failed batch fails closed to null previews and the list still returns", async () => {
    mocks.allRows = pdfRows(3);
    mocks.failBatch = true;
    const res = await list();

    expect(res.statusCode).toBe(200);
    const body = res.body as { artifacts: { preview_url: string | null }[] };
    expect(body.artifacts).toHaveLength(3);
    expect(body.artifacts.every((artifact) => artifact.preview_url === null)).toBe(true);
  });

  it("one failed chunk nulls only that chunk; the other chunk still signs", async () => {
    mocks.allRows = pdfRows(150);
    mocks.failBatchIndex = 0;
    const res = await list();

    expect(mocks.batchCalls.map((call) => call.paths.length)).toEqual([100, 50]);
    const failed = new Set(mocks.batchCalls[0].paths);
    const body = res.body as { artifacts: { preview_url: string | null }[] };
    const rows = mocks.allRows as { storage_path: string }[];
    body.artifacts.forEach((artifact, index) => {
      expect(artifact.preview_url === null).toBe(failed.has(rows[index].storage_path));
    });
  });

  it("signs HTML one by one with a download disposition, outside the batch", async () => {
    mocks.allRows = [
      { ...pdfRows(1)[0], id: "art-html", storage_path: `${TENANT_A}/${RUN_A}/blog.html`, filename: "blog.html", mime: "text/html" },
      { ...pdfRows(2)[1], id: "art-pdf" },
    ];
    await list();

    expect(mocks.singleCalls).toEqual([{ path: `${TENANT_A}/${RUN_A}/blog.html`, download: "blog.html" }]);
    expect(mocks.batchCalls.flatMap((call) => call.paths)).toEqual([`${TENANT_A}/${RUN_A}/file-1.pdf`]);
  });
});
