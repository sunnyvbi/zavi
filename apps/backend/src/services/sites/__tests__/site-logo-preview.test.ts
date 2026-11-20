import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  answers: [] as Array<{ data: unknown; error: { code?: string; message: string } | null }>,
  tenants: [] as string[],
  filters: [] as Array<[string, unknown]>,
  deletes: [] as Array<[string, unknown]>,
  deleteError: null as null | { message: string },
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => {
    db.tenants.push(tid);
    return {
      from: () => {
        const chain = {
          insert: (row: Record<string, unknown>) => {
            db.inserts.push(row);
            return { select: () => ({ single: async () => db.answers.shift()! }) };
          },
          select: () => chain,
          eq: (k: string, v: unknown) => {
            db.filters.push([k, v]);
            return chain;
          },
          maybeSingle: async () => db.answers.shift()!,
          delete: () => {
            const del = {
              eq: (k: string, v: unknown) => (db.deletes.push([k, v]), del),
              is: (k: string, v: unknown) => (db.deletes.push([k, v]), del),
              lt: (k: string, v: unknown) => (db.deletes.push([k, typeof v]), del),
              then: (ok: (r: unknown) => void) => ok({ error: db.deleteError }),
            };
            return del;
          },
        };
        return chain;
      },
    };
  },
}));

import { cleanPreviewId, previewDataUrl, realLogoPreviewStore } from "../site-logo-preview";

const T = "11111111-1111-4111-8111-111111111111";
const S = "aaaaaaaa-0000-4000-8000-000000000001";

describe("realLogoPreviewStore.claim", () => {
  it("takes the site's free preview when nobody has", async () => {
    db.inserts.length = 0;
    db.answers.push({ data: { id: "p1", free: true }, error: null });
    expect(await realLogoPreviewStore().claim(T, S, "a fox")).toEqual({ id: "p1", free: true });
    expect(db.inserts).toEqual([{ site_id: S, description: "a fox", free: true }]);
    expect(db.tenants.at(-1)).toBe(T);
  });

  it("falls back to a paid preview when the free one is already taken (unique violation)", async () => {
    db.inserts.length = 0;
    db.answers.push({ data: null, error: { code: "23505", message: "duplicate key" } }, { data: { id: "p2", free: false }, error: null });
    expect(await realLogoPreviewStore().claim(T, S, "a fox")).toEqual({ id: "p2", free: false });
    expect(db.inserts.map((r) => r.free)).toEqual([true, false]);
  });

  it("throws on any other error rather than handing out a free preview", async () => {
    db.answers.push({ data: null, error: { code: "57014", message: "timeout" } });
    await expect(realLogoPreviewStore().claim(T, S, "a fox")).rejects.toThrow(/timeout/);
  });
});

describe("realLogoPreviewStore cleanup", () => {
  it("clears this site's unfinished rows older than any generation before claiming", async () => {
    db.deletes.length = 0;
    db.answers.push({ data: { id: "p3", free: true }, error: null });
    await realLogoPreviewStore().claim(T, S, "a fox");
    expect(db.deletes).toEqual([["site_id", S], ["svg", null], ["created_at", "string"]]);
  });

  it("drop reports a failed delete instead of pretending it worked", async () => {
    db.deleteError = { message: "db down" };
    await expect(realLogoPreviewStore().drop(T, "p1")).rejects.toThrow(/db down/);
    db.deleteError = null;
  });
});

describe("realLogoPreviewStore.get", () => {
  it("reads by site and id through the tenant-scoped client", async () => {
    db.filters.length = 0;
    db.answers.push({ data: { id: "p1", site_id: S, svg: "<svg/>" }, error: null });
    expect(await realLogoPreviewStore().get(T, S, "p1")).toEqual({ id: "p1", site_id: S, svg: "<svg/>" });
    expect(db.filters).toEqual([["site_id", S], ["id", "p1"]]);
    expect(db.tenants.at(-1)).toBe(T);
  });
});

describe("helpers", () => {
  it("accepts only a uuid preview id", () => {
    expect(cleanPreviewId(" AAAAAAAA-0000-4000-8000-000000000001 ")).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(cleanPreviewId("../x")).toBeNull();
    expect(cleanPreviewId(42)).toBeNull();
  });
  it("serves the SVG as an image data URL", () => {
    expect(previewDataUrl("<svg/>")).toBe(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);
  });
});
