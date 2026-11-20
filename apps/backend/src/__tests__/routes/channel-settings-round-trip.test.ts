import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const ids = vi.hoisted(() => ({
  TENANT: "73db45ff-457e-4541-bc8f-bdb625390204",
  USER: "0335f3eb-8f08-4f72-91e1-6cd085503f13",
}));
const TENANT = ids.TENANT;
const USER = ids.USER;

type Row = {
  id: string;
  tenant_id: string;
  channel_slug: string;
  field_id: string;
  item: string;
  item_type: string | null;
  status: string | null;
  position: number | null;
  note: string | null;
  detail: string | null;
};

const h = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = [];
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let seq = 0;

  function read(tenant: string, slug: string): Record<string, unknown[]> {
    const fields: Record<string, unknown[]> = {};
    for (const r of rows as unknown as Row[]) {
      if (r.tenant_id !== tenant || r.channel_slug !== slug) continue;
      (fields[r.field_id] ??= []).push({
        id: r.id,
        item: r.item,
        item_type: r.item_type,
        status: r.status,
        position: r.position,
        note: r.note,
        detail: r.detail,
      });
    }
    return fields;
  }

  function write(
    tenant: string,
    slug: string,
    field: string,
    items: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    const keep: string[] = [];
    let written = 0;
    items.forEach((it, i) => {
      const item = String(it.item);
      keep.push(item);
      const existing = (rows as unknown as Row[]).find(
        (r) =>
          r.tenant_id === tenant &&
          r.channel_slug === slug &&
          r.field_id === field &&
          r.item === item,
      );
      const cols = {
        item_type: (it.item_type as string | null) ?? null,
        status: (it.status as string | null) ?? null,
        position: (it.position as number | null) ?? i,
        note: (it.note as string | null) ?? null,
        detail: (it.detail as string | null) ?? null,
      };
      if (existing) {
        Object.assign(existing, cols);
      } else {
        rows.push({
          id: `settings-row-${++seq}`,
          tenant_id: tenant,
          channel_slug: slug,
          field_id: field,
          item,
          ...cols,
        });
      }
      written += 1;
    });
    let deleted = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i] as unknown as Row;
      if (
        r.tenant_id === tenant &&
        r.channel_slug === slug &&
        r.field_id === field &&
        !keep.includes(r.item)
      ) {
        rows.splice(i, 1);
        deleted += 1;
      }
    }
    return { ok: true, written, deleted, dropped: 0, fields: read(tenant, slug) };
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
        return {
          data: write(
            tenant,
            slug,
            String(args.p_field_id),
            args.p_items as Array<Record<string, unknown>>,
          ),
          error: null,
        };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  );

  return { rows, calls, tenantRpc, read, reset: () => { rows.length = 0; calls.length = 0; seq = 0; } };
});

vi.mock("@/services/tenant-client", () => ({
  tenantRpc: h.tenantRpc,
}));
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

const putReq = (slug: string, fieldId: string, body: unknown) =>
  ({ params: { slug, fieldId }, query: {}, body } as unknown as Request);
const getReq = (slug: string) =>
  ({ params: { slug }, query: {}, body: {} } as unknown as Request);

function savedField(body: unknown, fieldId: string): Array<{ id: string; item: string }> {
  const fields = (body as { fields?: Record<string, Array<{ id: string; item: string }>> }).fields;
  return fields?.[fieldId] ?? [];
}

async function seedKeywords(slug = "google_ads") {
  const { res } = mkRes();
  await channelSettingsPut(
    putReq(slug, "keywords", {
      items: [
        { item: "fleet insurance", item_type: "problem", status: "tracking", position: 0 },
        { item: "car sharing app", item_type: "category", status: "tracking", position: 1 },
        { item: "turo alternative", item_type: "competitor", status: "paused", position: 2 },
      ],
    }),
    res,
  );
}

beforeEach(() => {
  h.reset();
  h.tenantRpc.mockClear();
});

describe("GUARD 18 — the route half: an unchanged item keeps its id across an edit", () => {
  it("edits ONE item and the other two keep the exact ids they had before", async () => {
    await seedKeywords();

    const before = h.read(TENANT, "google_ads").keywords as unknown as Array<{
      id: string;
      item: string;
    }>;
    expect(before).toHaveLength(3);
    const idOf = (item: string) => before.find((r) => r.item === item)?.id;
    const fleetId = idOf("fleet insurance");
    const sharingId = idOf("car sharing app");
    expect(fleetId).toBeTruthy();
    expect(sharingId).toBeTruthy();

    const { res, status, body } = mkRes();
    await channelSettingsPut(
      putReq("google_ads", "keywords", {
        items: [
          { item: "  fleet insurance  ", item_type: "problem", status: "tracking", position: 0 },
          { item: "car sharing app", item_type: "category", status: "tracking", position: 1 },
          { item: "getaround alternative", item_type: "competitor", status: "tracking", position: 2 },
        ],
      }),
      res,
    );
    expect(status()).toBe(200);

    const after = savedField(body(), "keywords");
    expect(after).toHaveLength(3);
    expect(after.find((r) => r.item === "fleet insurance")?.id).toBe(fleetId);
    expect(after.find((r) => r.item === "car sharing app")?.id).toBe(sharingId);
    expect(after.find((r) => r.item === "getaround alternative")?.id).not.toBe(
      before.find((r) => r.item === "turo alternative")?.id,
    );
  });

  it("an item dropped from the payload is GONE, not merged back", async () => {
    await seedKeywords();
    expect(h.read(TENANT, "google_ads").keywords).toHaveLength(3);

    const { res, body } = mkRes();
    await channelSettingsPut(
      putReq("google_ads", "keywords", {
        items: [
          { item: "fleet insurance", item_type: "problem", status: "tracking", position: 0 },
        ],
      }),
      res,
    );

    const after = savedField(body(), "keywords");
    expect(after.map((r) => r.item)).toEqual(["fleet insurance"]);
    expect((body() as { deleted?: number }).deleted).toBe(2);

    const g = mkRes();
    await channelSettingsGet(getReq("google_ads"), g.res);
    const fields = (g.body() as { fields: Record<string, unknown[]> }).fields;
    expect(fields.keywords).toHaveLength(1);
    expect(JSON.stringify(fields)).not.toContain("turo alternative");
  });

  it("replaces ONE field and leaves the channel's other fields untouched", async () => {
    await seedKeywords();
    const c = mkRes();
    await channelSettingsPut(
      putReq("google_ads", "competitors", {
        items: [{ item: "Turo", detail: "turo.com", status: "tracking" }],
      }),
      c.res,
    );

    const k = mkRes();
    await channelSettingsPut(
      putReq("google_ads", "keywords", { items: [{ item: "fleet insurance" }] }),
      k.res,
    );

    const fields = (k.body() as { fields: Record<string, unknown[]> }).fields;
    expect(fields.competitors).toHaveLength(1);
    expect(JSON.stringify(fields.competitors)).toContain("turo.com");
  });

  it("sends ONE field per call, never a whole-object write, and never the tenant", async () => {
    await seedKeywords();
    const call = h.calls.find((c) => c.fn === "set_channel_settings");
    expect(call).toBeTruthy();
    expect(call?.args.p_channel_slug).toBe("google_ads");
    expect(call?.args.p_field_id).toBe("keywords");
    expect(Array.isArray(call?.args.p_items)).toBe(true);
    expect(call?.args).not.toHaveProperty("p_tenant_id");
  });

  it("never forwards a client-supplied id — the client cannot repoint an FK", async () => {
    const { res } = mkRes();
    await channelSettingsPut(
      putReq("google_ads", "keywords", {
        items: [{ item: "fleet insurance", id: "11111111-1111-1111-1111-111111111111" }],
      }),
      res,
    );
    const call = h.calls.find((c) => c.fn === "set_channel_settings");
    const items = call?.args.p_items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("id");
    expect(JSON.stringify(items)).not.toContain("11111111-1111-1111-1111-111111111111");
  });

  it("returns the saved set WITH ids, so the client never guesses which one survived", async () => {
    await seedKeywords();
    const { res, body } = mkRes();
    await channelSettingsPut(
      putReq("google_ads", "keywords", { items: [{ item: "fleet insurance" }] }),
      res,
    );
    const after = savedField(body(), "keywords");
    expect(after).toHaveLength(1);
    expect(after[0].id).toBeTruthy();
  });

  it("a channel with no rows reads { fields: {} } rather than erroring", async () => {
    const { res, status, body } = mkRes();
    await channelSettingsGet(getReq("reddit_organic"), res);
    expect(status()).toBe(200);
    expect(body()).toEqual({ fields: {} });
  });
});

describe("GUARD 19 (writesTo half) — a field with a real store is REFUSED, not shadow-copied", () => {
  for (const [slug, fieldId] of [["google_ads", "budget"], ["google_ads", "cadence"], ["google_ads", "autonomy"], ["email_marketing", "email_test_lists"]] as const) {
    it(`refuses PUT .../settings/${fieldId} with 409 and writes NOTHING`, async () => {
      const { res, status, body } = mkRes();
      await channelSettingsPut(
        putReq(slug, fieldId, { items: [{ item: "2500" }] }),
        res,
      );
      expect(status()).toBe(409);
      expect((body() as { error: { code: string } }).error.code).toBe("field_writes_elsewhere");
      expect(h.calls.filter((c) => c.fn === "set_channel_settings")).toHaveLength(0);
      expect(h.rows).toHaveLength(0);
    });
  }

  it("refuses BEFORE validating the body — a malformed budget save is still not a 400", async () => {
    const { res, status } = mkRes();
    await channelSettingsPut(putReq("google_ads", "budget", { items: "not-an-array" }), res);
    expect(status()).toBe(409);
  });

  it("still ACCEPTS a field that has no store of its own", async () => {
    const { res, status } = mkRes();
    await channelSettingsPut(
      putReq("google_ads", "keywords", { items: [{ item: "fleet insurance" }] }),
      res,
    );
    expect(status()).toBe(200);
    expect(h.calls.filter((c) => c.fn === "set_channel_settings")).toHaveLength(1);
  });

  it("the refused ids come from the SHARED list, not a copy that can drift", async () => {
    const shared = await import("@zavi/shared");
    expect([...shared.WRITES_ELSEWHERE_FIELD_IDS].sort()).toEqual([
      "autonomy",
      "budget",
      "cadence",
      "email_test_lists",
    ]);
    const src = readFileSync(
      join(__dirname, "../../routes/channels/settings.ts"),
      "utf8",
    );
    expect(src).toContain("writesElsewhere");
    expect(src).not.toMatch(/new Set\(\s*\[\s*["']budget["']/);
  });
});

describe("GUARD 18 — the SQL half: the three ways an id-preserving upsert can still be wrong", () => {
  const sql = readFileSync(
    join(__dirname, "../../../../../supabase/migrations/20260920050000_channel_settings.sql"),
    "utf8",
  )
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

  it("the DELETE is scoped by tenant AND channel AND field, not by the keep-list alone", () => {
    const stmt = sql.match(/delete from channel_settings[\s\S]*?;/i)?.[0];
    expect(stmt, "set_channel_settings must delete what left the payload").toBeTruthy();
    expect(stmt).toMatch(/s\.tenant_id\s*=\s*p_tenant_id/i);
    expect(stmt).toMatch(/s\.channel_slug\s*=\s*p_channel_slug/i);
    expect(stmt).toMatch(/s\.field_id\s*=\s*p_field_id/i);
    expect(stmt).toMatch(/not \(s\.item = any \(v_keep\)\)/i);
  });

  it("there is exactly ONE delete — no whole-field wipe before the upsert loop", () => {
    expect(sql.match(/delete from channel_settings/gi) ?? []).toHaveLength(1);
  });

  it("the ON CONFLICT update never reassigns id or item", () => {
    const setList = sql.match(/do update\s+set([\s\S]*?);/i)?.[1];
    expect(setList, "the upsert must have a SET list").toBeTruthy();
    expect(setList).not.toMatch(/\bid\s*=/);
    expect(setList).not.toMatch(/(?<!_)\bitem\s*=/);
    for (const col of ["item_type", "status", "position", "note", "detail"]) {
      expect(setList).toMatch(new RegExp(`${col}\\s*=\\s*excluded\\.${col}`, "i"));
    }
  });

  it("v_keep starts as an EMPTY array, so clearing a field actually clears it", () => {
    expect(sql).toMatch(/v_keep\s+text\[\]\s*:=\s*array\[\]::text\[\]/i);
  });
});
