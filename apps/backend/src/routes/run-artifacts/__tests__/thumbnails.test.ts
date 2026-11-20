import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const RUN = "11111111-1111-4111-1111-111111111111";
const ID_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const ID_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const ID_PDF = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const ID_FOREIGN = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  tenantFilter: null as string | null,
  inIds: [] as string[],
  signs: [] as { path: string; options: unknown }[],
  inFlight: 0,
  peak: 0,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ user_id: "u1", tenant_id: TENANT }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, val: string) => {
          mocks.tenantFilter = val;
          return {
            in: async (_c: string, ids: string[]) => {
              mocks.inIds = ids;
              return {
                data: mocks.rows.filter((r) => r.tenant_id === val && ids.includes(String(r.id))),
                error: null,
              };
            },
          };
        },
      }),
    }),
    storage: {
      from: () => ({
        createSignedUrl: async (path: string, _ttl: number, options?: unknown) => {
          mocks.inFlight += 1;
          mocks.peak = Math.max(mocks.peak, mocks.inFlight);
          await new Promise((r) => setTimeout(r, 5));
          mocks.inFlight -= 1;
          mocks.signs.push({ path, options });
          return { data: { signedUrl: `https://signed/${path}?w=640` }, error: null };
        },
      }),
    },
  }),
}));

import { IMAGE_THUMBNAIL } from "../file-url";
import { MAX_THUMBNAIL_IDS, runArtifactThumbnails } from "../thumbnails";
import { clearSignedUrlCache } from "@/services/run-artifacts/signed-url-cache";

function mkRes() {
  const res: Record<string, unknown> = { statusCode: 200 };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res as { statusCode: number; body: { thumbnails?: Record<string, string | null>; error?: { code: string } } };
}

async function call(body: unknown) {
  const res = mkRes();
  await runArtifactThumbnails({ body } as never, res as never);
  return res;
}

const row = (id: string, tenant: string, filename: string, mime: string) => ({
  id,
  tenant_id: tenant,
  storage_path: `${tenant}/${RUN}/${filename}`,
  bucket: "agent-artifacts",
  mime,
});

beforeEach(() => {
  clearSignedUrlCache();
  mocks.rows = [
    row(ID_A, TENANT, "a.png", "image/png"),
    row(ID_B, TENANT, "b.webp", "image/webp"),
    row(ID_PDF, TENANT, "report.pdf", "application/pdf"),
    row(ID_FOREIGN, OTHER_TENANT, "theirs.png", "image/png"),
  ];
  mocks.signs = [];
  mocks.inIds = [];
  mocks.inFlight = 0;
  mocks.peak = 0;
});

describe("POST /api/run-artifacts/thumbnails", () => {
  it("signs every owned image in one call, with the gallery transform, and says nothing about the rest", async () => {
    const res = await call({ ids: [ID_A, ID_B, ID_PDF, ID_FOREIGN] });
    expect(res.statusCode).toBe(200);
    expect(mocks.tenantFilter).toBe(TENANT);
    expect(res.body.thumbnails).toEqual({
      [ID_A]: `https://signed/${TENANT}/${RUN}/a.png?w=640`,
      [ID_B]: `https://signed/${TENANT}/${RUN}/b.webp?w=640`,
    });
    expect(Object.keys(res.body.thumbnails!)).not.toContain(ID_FOREIGN);
    expect(Object.keys(res.body.thumbnails!)).not.toContain(ID_PDF);
    expect(mocks.signs.every((s) => s.options && (s.options as { transform: unknown }).transform === IMAGE_THUMBNAIL)).toBe(true);
    expect(mocks.signs.map((s) => s.path)).not.toContain(`${OTHER_TENANT}/${RUN}/theirs.png`);
  });

  it("a second call for the same ids is served from the memo with no storage call", async () => {
    const first = await call({ ids: [ID_A, ID_B] });
    const second = await call({ ids: [ID_A, ID_B] });
    expect(second.body.thumbnails).toEqual(first.body.thumbnails);
    expect(mocks.signs).toHaveLength(2);
  });

  it("signs through a bounded pool, never all at once", async () => {
    mocks.rows = Array.from({ length: 20 }, (_, i) =>
      row(`${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`, TENANT, `img-${i}.png`, "image/png"),
    );
    const ids = mocks.rows.map((r) => String(r.id));
    const res = await call({ ids });
    expect(Object.keys(res.body.thumbnails!)).toHaveLength(20);
    expect(mocks.peak).toBeLessThanOrEqual(6);
    expect(mocks.peak).toBeGreaterThan(1);
  });

  it("rejects a missing, empty, oversized or malformed id list", async () => {
    expect((await call({})).statusCode).toBe(400);
    expect((await call({ ids: [] })).statusCode).toBe(400);
    expect((await call({ ids: ["not-a-uuid", 42] })).statusCode).toBe(400);
    const tooMany = Array.from({ length: MAX_THUMBNAIL_IDS + 1 }, (_, i) =>
      `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    expect((await call({ ids: tooMany })).statusCode).toBe(400);
    expect(mocks.signs).toHaveLength(0);
  });

  it("an image whose path is not the tenant's canonical shape is never signed", async () => {
    mocks.rows = [{ ...row(ID_A, TENANT, "a.png", "image/png"), storage_path: `${OTHER_TENANT}/${RUN}/a.png` }];
    const res = await call({ ids: [ID_A] });
    expect(res.body.thumbnails).toEqual({});
    expect(mocks.signs).toHaveLength(0);
  });
});
