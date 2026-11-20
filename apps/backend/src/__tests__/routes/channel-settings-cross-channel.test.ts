import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const ids = vi.hoisted(() => ({
  TENANT: "73db45ff-457e-4541-bc8f-bdb625390204",
  USER: "0335f3eb-8f08-4f72-91e1-6cd085503f13",
}));
const TENANT = ids.TENANT;
const USER = ids.USER;

type Row = { tenant_id: string; channel_slug: string; field_id: string; item: string };

const h = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = [];
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let seq = 0;

  function read(tenant: string, slug: string): Record<string, unknown[]> {
    const fields: Record<string, unknown[]> = {};
    for (const r of rows as unknown as Array<Row & { id: string }>) {
      if (r.tenant_id !== tenant || r.channel_slug !== slug) continue;
      (fields[r.field_id] ??= []).push({ id: r.id, item: r.item });
    }
    return fields;
  }

  const tenantRpc = vi.fn(
    async (tenant: string, fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const slug = args.p_channel_slug;
      if (typeof slug !== "string" || slug.trim() === "") {
        throw new Error(`${fn}: p_channel_slug is required`);
      }
      if (fn === "get_channel_settings") {
        return { data: { fields: read(tenant, slug) }, error: null };
      }
      if (fn === "set_channel_settings") {
        const field = String(args.p_field_id);
        const keep = (args.p_items as Array<{ item: string }>).map((i) => String(i.item));
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const r = rows[i] as unknown as Row;
          if (
            r.tenant_id === tenant &&
            r.channel_slug === slug &&
            r.field_id === field &&
            !keep.includes(r.item)
          ) {
            rows.splice(i, 1);
          }
        }
        for (const item of keep) {
          const hit = (rows as unknown as Row[]).find(
            (r) =>
              r.tenant_id === tenant &&
              r.channel_slug === slug &&
              r.field_id === field &&
              r.item === item,
          );
          if (!hit) {
            rows.push({
              id: `row-${(seq += 1)}`,
              tenant_id: tenant,
              channel_slug: slug,
              field_id: field,
              item,
            });
          }
        }
        return { data: { ok: true, written: keep.length, deleted: 0, dropped: 0, fields: read(tenant, slug) }, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  );

  return {
    rows,
    calls,
    tenantRpc,
    seed(tenant: string, slug: string, field: string, items: string[]) {
      for (const item of items) {
        rows.push({ id: `row-${(seq += 1)}`, tenant_id: tenant, channel_slug: slug, field_id: field, item });
      }
    },
    reset: () => {
      rows.length = 0;
      calls.length = 0;
      seq = 0;
    },
  };
});

vi.mock("@/services/tenant-client", () => ({ tenantRpc: h.tenantRpc }));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn().mockResolvedValue({
    user_id: ids.USER,
    tenant_id: ids.TENANT,
    access_token: "fake-jwt",
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn().mockResolvedValue(true),
}));

import { channelSettingsGet, channelSettingsPut } from "../../routes/channels/settings";

function mkRes(): { res: Response; status: () => number; body: () => unknown } {
  let code = 200;
  let payload: unknown = null;
  const res = {
    status(c: number) {
      code = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => code, body: () => payload };
}
const getReq = (slug: string) => ({ params: { slug }, query: {}, body: {} } as unknown as Request);
const putReq = (slug: string, fieldId: string, body: unknown) =>
  ({ params: { slug, fieldId }, query: {}, body } as unknown as Request);

const A = "google_ads";
const B = "reddit_organic";
const A_ITEMS = ["fleet insurance", "car sharing app"];
const B_ITEMS = ["r/whatcarshouldibuy", "r/turo"];

beforeEach(() => {
  h.reset();
  h.tenantRpc.mockClear();
  h.seed(TENANT, A, "keywords", A_ITEMS);
  h.seed(TENANT, B, "subreddits", B_ITEMS);
  h.seed(TENANT, B, "keywords", ["peer to peer car rental"]);
});

describe("GUARD 22 — one tenant, one token, two channels", () => {
  it("fixture check: both channels really do have rows", () => {
    expect(h.rows).toHaveLength(A_ITEMS.length + B_ITEMS.length + 1);
  });

  it("a read scoped to channel A returns ZERO of channel B's rows", async () => {
    const { res, status, body } = mkRes();
    await channelSettingsGet(getReq(A), res);
    expect(status()).toBe(200);

    const json = JSON.stringify(body());
    for (const item of A_ITEMS) expect(json).toContain(item);
    for (const item of B_ITEMS) expect(json).not.toContain(item);
    expect(json).not.toContain("peer to peer car rental");
    const fields = (body() as { fields: Record<string, unknown[]> }).fields;
    expect(Object.keys(fields).sort()).toEqual(["keywords"]);
    expect(fields.keywords).toHaveLength(2);
  });

  it("the read reaches the store ONLY through an RPC that names the channel", async () => {
    const { res } = mkRes();
    await channelSettingsGet(getReq(A), res);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].fn).toBe("get_channel_settings");
    expect(h.calls[0].args.p_channel_slug).toBe(A);
    expect(h.calls[0].args).not.toHaveProperty("p_tenant_id");
  });

  it("a WRITE scoped to channel A leaves channel B's rows alone", async () => {
    const { res, status } = mkRes();
    await channelSettingsPut(putReq(A, "keywords", { items: [{ item: "fleet insurance" }] }), res);
    expect(status()).toBe(200);

    const g = mkRes();
    await channelSettingsGet(getReq(B), g.res);
    const json = JSON.stringify(g.body());
    for (const item of B_ITEMS) expect(json).toContain(item);
    expect(json).toContain("peer to peer car rental");
  });

  it("an unknown slug is refused before any store call — no slug-less fallback", async () => {
    const { res, status, body } = mkRes();
    await channelSettingsGet(getReq("not_a_channel"), res);
    expect(status()).toBe(404);
    expect((body() as { error: { code: string } }).error.code).toBe("unknown_channel");
    expect(h.calls).toHaveLength(0);
  });
});

describe("GUARD 22 — there is no reachable path that omits the slug", () => {
  const BACKEND = join(__dirname, "../../..");
  const TABLE = "channel_settings";
  const FACADE_READ = new RegExp(`\\.\\s*from\\(\\s*["'\`]${TABLE}["'\`]`);

  function codeOnly(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*");
      })
      .join("\n");
  }

  function walk(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
      const p = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(p, out);
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }

  const sources = [...walk(join(BACKEND, "src")), ...walk(join(BACKEND, "workers"))];

  it("scans a real, non-empty set of backend sources", () => {
    expect(sources.length).toBeGreaterThan(500);
  });

  it("still sees the call when it is real code, not a comment", () => {
    expect(FACADE_READ.test(codeOnly(`const x = tenantClient(t).from("${TABLE}");`))).toBe(true);
    expect(FACADE_READ.test(codeOnly(`// tenantClient(t).from("${TABLE}")`))).toBe(false);
    expect(FACADE_READ.test(codeOnly(` * a .from("${TABLE}") read`))).toBe(false);
  });

  it("no backend source reads channel_settings through the tenantClient facade", () => {
    const offenders = sources
      .filter((p) => FACADE_READ.test(codeOnly(readFileSync(p, "utf8"))))
      .map((p) => p.slice(BACKEND.length + 1));
    expect(
      offenders,
      `${offenders.join(", ")} reaches channel_settings through the tenant facade. ` +
        `The facade runs as service_role and filters on tenant_id ALONE — there is no ` +
        `channel claim in the JWT — so this returns EVERY channel's settings at once. ` +
        `Use get_channel_settings / set_channel_settings, where p_channel_slug is required.`,
    ).toEqual([]);
  });

  it("the settings route itself imports tenantRpc and NOT tenantClient", () => {
    const src = readFileSync(join(BACKEND, "src/routes/channels/settings.ts"), "utf8");
    expect(src).toMatch(/import \{[^}]*\btenantRpc\b[^}]*\} from "@\/services\/tenant-client"/);
    expect(src).not.toMatch(/import \{[^}]*\btenantClient\b/);
  });

  it("every RPC this route can call takes p_channel_slug", async () => {
    const { res } = mkRes();
    await channelSettingsGet(getReq(A), res);
    const w = mkRes();
    await channelSettingsPut(putReq(A, "keywords", { items: [{ item: "x" }] }), w.res);
    expect(h.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of h.calls) {
      expect(c.args, `${c.fn} was called without a channel`).toHaveProperty("p_channel_slug");
      expect(String(c.args.p_channel_slug).trim()).not.toBe("");
    }
  });
});
