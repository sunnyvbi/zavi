import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Version = { id: string; tenant: string; list: string; at: number; emails: string[] };

const db = vi.hoisted(() => ({
  contacts: new Map<string, Set<string>>(),
  versions: [] as Version[],
  lists: [] as { id: string; tenant: string; archived: boolean }[],
  tables: [] as string[],
  rpcCalls: [] as { tenant: string; name: string; args: Record<string, unknown> }[],
  clientTenants: [] as string[],
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (tenant: string, name: string, args: Record<string, unknown>) => {
    db.rpcCalls.push({ tenant, name, args });
    if (name === "email_contacts_existing_count") {
      const mine = db.contacts.get(tenant) ?? new Set<string>();
      return { data: (args.p_emails as string[]).filter((e) => mine.has(e)).length, error: null };
    }
    if (name === "email_list_version_emails") {
      const v = db.versions.find((x) => x.tenant === tenant && x.id === args.p_version_id && x.list === args.p_list_id);
      return { data: v ? [...v.emails].sort() : [], error: null };
    }
    return { data: null, error: { message: `unexpected ${name}` } };
  },
  tenantClient: (tenant: string) => {
    db.clientTenants.push(tenant);
    return {
      from: (table: string) => {
        db.tables.push(table);
        if (table === "email_suppression") {
          const q = { select: () => q, eq: () => q, order: () => q, range: async () => ({ data: [], error: null }) };
          return q;
        }
        if (table === "email_lists") {
          const where: [string, unknown][] = [];
          const q = {
            select: () => q,
            eq: (c: string, v: unknown) => {
              where.push([c, v]);
              return q;
            },
            is: (c: string, v: unknown) => {
              where.push([`${c}:is`, v]);
              return q;
            },
            maybeSingle: async () => {
              const row = db.lists.find(
                (l) =>
                  l.tenant === tenant &&
                  where.every(([c, v]) => (c === "id" ? l.id === v : c === "archived_at:is" && v === null ? !l.archived : false)),
              );
              return { data: row ? { id: row.id } : null, error: null };
            },
          };
          return q;
        }
        if (table !== "email_list_versions") throw new Error(`unexpected table ${table}`);
        const filters: [string, unknown][] = [];
        const b = {
          select: () => b,
          eq: (c: string, v: unknown) => {
            filters.push([c, v]);
            return b;
          },
          order: () => b,
          limit: () => b,
          maybeSingle: async () => {
            const rows = db.versions
              .filter((v) => v.tenant === tenant && filters.every(([c, val]) => (c === "list_id" ? v.list === val : false)))
              .sort((x, y) => y.at - x.at);
            return { data: rows[0] ? { id: rows[0].id } : null, error: null };
          },
        };
        return b;
      },
    };
  },
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true, loadTenantRole: async () => "owner" }));

import { previewCsvChain } from "@/routes/workspace/email-lists";

const LIST = "11111111-1111-4111-8111-111111111111";
const EMPTY = "22222222-2222-4222-8222-222222222222";
const FOREIGN = "44444444-4444-4444-8444-444444444444";
const ARCHIVED = "55555555-5555-4555-8555-555555555555";
const UNKNOWN = "66666666-6666-4666-8666-666666666666";
const preview = previewCsvChain[previewCsvChain.length - 1] as (r: Request, s: Response) => Promise<void>;

function call(body: Record<string, unknown>, tenant = "tenant-a") {
  let status = 200;
  let out: any;
  const res = {
    status: vi.fn((v: number) => {
      status = v;
      return res;
    }),
    json: vi.fn((v: unknown) => {
      out = v;
      return res;
    }),
  } as unknown as Response;
  const csv = ["email", "ada@example.com", "BO@example.com", "cy@example.com", "cy@example.com", "junk", ""].join("\n");
  const req = {
    body,
    query: {},
    params: {},
    headers: {},
    auth: { tenant_id: tenant, user_id: "user-a" },
    file: { buffer: Buffer.from(csv, "utf8"), originalname: "people.csv" },
  } as unknown as Request;
  return preview(req, res).then(() => ({ status, body: out }));
}

describe("preview counts when adding a file to an existing list", () => {
  beforeEach(() => {
    db.rpcCalls = [];
    db.clientTenants = [];
    db.tables = [];
    db.lists = [
      { id: LIST, tenant: "tenant-a", archived: false },
      { id: EMPTY, tenant: "tenant-a", archived: false },
      { id: ARCHIVED, tenant: "tenant-a", archived: true },
      { id: FOREIGN, tenant: "tenant-b", archived: false },
    ];
    db.contacts = new Map([
      ["tenant-a", new Set(["bo@example.com", "cy@example.com"])],
      ["tenant-b", new Set(["ada@example.com", "bo@example.com", "cy@example.com"])],
    ]);
    db.versions = [
      { id: "V-old", tenant: "tenant-a", list: LIST, at: 1, emails: ["ada@example.com", "bo@example.com", "cy@example.com"] },
      { id: "V-new", tenant: "tenant-a", list: LIST, at: 2, emails: ["cy@example.com", "zed@example.com"] },
      { id: "V-b", tenant: "tenant-b", list: LIST, at: 3, emails: ["ada@example.com", "bo@example.com"] },
      { id: "V-f", tenant: "tenant-b", list: FOREIGN, at: 4, emails: ["ada@example.com", "bo@example.com", "cy@example.com"] },
      { id: "V-arch", tenant: "tenant-a", list: ARCHIVED, at: 5, emails: ["ada@example.com"] },
    ];
  });

  it("counts against the list's latest version, not the workspace: a workspace contact missing from the list is new to it", async () => {
    const out = await call({ column: "email", list_id: LIST, tenant_id: "tenant-b" });
    expect(out.status).toBe(200);
    expect(out.body.counts).toEqual({
      new: 2,
      already_in_contacts: 0,
      already_on_list: 1,
      skipped_erased: 0,
      duplicate_in_file: 1,
      bad: 1,
      over_limit: 0,
    });
    expect(out.body.counts.new + out.body.counts.already_on_list).toBe(3);
    expect(db.rpcCalls.map((c) => c.name)).toEqual(["email_list_version_emails"]);
    expect(db.rpcCalls[0]).toMatchObject({ tenant: "tenant-a", args: { p_list_id: LIST, p_version_id: "V-new" } });
    expect(new Set(db.clientTenants)).toEqual(new Set(["tenant-a"]));
  });

  it("a list nobody has imported into yet counts every address as new to it", async () => {
    const out = await call({ column: "email", list_id: EMPTY });
    expect(out.body.counts).toMatchObject({ new: 3, already_on_list: 0, already_in_contacts: 0 });
  });

  it("a brand-new list keeps the workspace comparison and shape", async () => {
    const out = await call({ column: "email" });
    expect(out.body.counts).toEqual({ new: 1, already_in_contacts: 2, skipped_erased: 0, duplicate_in_file: 1, bad: 1, over_limit: 0 });
    expect(db.rpcCalls.map((c) => c.name)).toEqual(["email_contacts_existing_count"]);
    expect(db.tables).toEqual(["email_suppression"]);
  });

  it("refuses a malformed list id without reading anything", async () => {
    const out = await call({ column: "email", list_id: "not-a-uuid" });
    expect(out.status).toBe(404);
    expect(out.body.error.code).toBe("list_not_found");
    expect(db.rpcCalls).toEqual([]);
  });

  it.each([
    ["another workspace's list", FOREIGN, "tenant-b"],
    ["an archived list", ARCHIVED, "tenant-a"],
    ["a well-formed id that matches no list", UNKNOWN, "tenant-a"],
  ])("refuses %s with the import's 404 and never counts against it", async (_label, listId, bodyTenant) => {
    const out = await call({ column: "email", list_id: listId, tenant_id: bodyTenant });
    expect(out.status).toBe(404);
    expect(out.body.error.code).toBe("list_not_found");
    expect(out.body.error.message).toBe("That contact list was not found.");
    expect(out.body.counts).toBeUndefined();
    expect(db.rpcCalls).toEqual([]);
    expect(db.tables).toEqual(["email_lists"]);
    expect(new Set(db.clientTenants)).toEqual(new Set(["tenant-a"]));
  });
});
