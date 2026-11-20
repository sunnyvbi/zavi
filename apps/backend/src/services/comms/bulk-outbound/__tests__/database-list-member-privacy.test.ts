import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Version = {
  id: string;
  tenant: string;
  list: string;
  at: number;
  source_kind: "csv" | "database";
  source_ref: Record<string, string>;
  emails: string[];
  consented: boolean;
};

const db = vi.hoisted(() => ({
  role: "owner" as string | null,
  versions: [] as Version[],
  lists: [] as { id: string; tenant: string; name: string }[],
  seq: 0,
  clock: 0,
  importCalls: [] as Record<string, unknown>[],
}));

function latest(tenant: string, list: string): Version | undefined {
  return db.versions.filter((v) => v.tenant === tenant && v.list === list).sort((a, b) => b.at - a.at)[0];
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (tenant: string, name: string, args: Record<string, unknown>) => {
    if (name === "email_list_version_emails") {
      const v = db.versions.find((x) => x.tenant === tenant && x.id === args.p_version_id && x.list === args.p_list_id);
      return { data: v ? [...v.emails] : [], error: null };
    }
    if (name === "email_list_import_version") {
      db.importCalls.push(args);
      const list = args.p_list_id as string;
      if ((latest(tenant, list)?.id ?? null) !== ((args.p_base_version_id as string | undefined) ?? null)) {
        return { data: { ok: false, reason: "list_changed" }, error: null };
      }
      const before = new Set(latest(tenant, list)?.emails ?? []);
      const emails = args.p_emails as string[];
      const v: Version = {
        id: `V${++db.seq}`,
        tenant,
        list,
        at: ++db.clock,
        source_kind: args.p_source_kind as "csv" | "database",
        source_ref: args.p_source_ref as Record<string, string>,
        emails,
        consented: false,
      };
      db.versions.push(v);
      return {
        data: { ok: true, list_id: list, version_id: v.id, contact_count: emails.length, new_count: emails.filter((e) => !before.has(e)).length, new_blocked: 0 },
        error: null,
      };
    }
    if (name === "email_list_summaries") {
      return {
        data: db.lists
          .filter((l) => l.tenant === tenant)
          .map((l) => {
            const top = latest(tenant, l.id);
            const active = db.versions.filter((v) => v.list === l.id && v.consented).sort((a, b) => b.at - a.at)[0];
            return {
              id: l.id,
              name: l.name,
              created_at: "2026-10-01T00:00:00Z",
              active_version_id: active?.id ?? null,
              latest: top
                ? { id: top.id, source_kind: top.source_kind, source_ref: top.source_ref, contact_count: top.emails.length, created_at: "2026-10-02T00:00:00Z", consented: top.consented }
                : null,
              active: active ? { id: active.id, source_kind: active.source_kind, contact_count: active.emails.length, blocked: 0 } : null,
            };
          }),
        error: null,
      };
    }
    if (name === "email_list_contacts_page") {
      const v = db.versions.find((x) => x.tenant === tenant && x.id === args.p_version_id && x.list === args.p_list_id);
      const all = v?.emails ?? [];
      const page = all.slice(args.p_offset as number, (args.p_offset as number) + (args.p_limit as number));
      return { data: { total: all.length, contacts: page.map((email, i) => ({ id: `c${i}`, email, status: "subscribed" })) }, error: null };
    }
    return { data: null, error: { message: `unexpected ${name}` } };
  },
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      const where: [string, unknown][] = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => {
          where.push([c, v]);
          return q;
        },
        is: () => q,
        order: () => q,
        limit: () => q,
        range: async () => ({ data: [], error: null }),
        maybeSingle: async () => {
          if (table === "email_lists") {
            const row = db.lists.find((l) => l.tenant === tenant && where.every(([c, v]) => c === "id" && l.id === v));
            return { data: row ? { id: row.id } : null, error: null };
          }
          if (table === "email_list_versions") {
            const listId = where.find(([c]) => c === "list_id")?.[1] as string;
            const top = latest(tenant, listId);
            return { data: top ? { id: top.id, source_kind: top.source_kind, source_ref: top.source_ref } : null, error: null };
          }
          throw new Error(`unexpected table ${table}`);
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (req: Request) => (req as unknown as { auth: unknown }).auth,
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async () => true,
  loadTenantRole: async () => db.role,
}));

import { getEmailListContacts, getEmailLists, importCsvChain, previewCsvChain } from "@/routes/workspace/email-lists";

const LIST = "11111111-1111-4111-8111-111111111111";
const DB_EMAILS = ["alice@secret.example", "bob@secret.example", "carol@secret.example"];
const importCsv = importCsvChain[importCsvChain.length - 1] as (r: Request, s: Response) => Promise<void>;
const previewCsv = previewCsvChain[previewCsvChain.length - 1] as (r: Request, s: Response) => Promise<void>;

function res() {
  const out = { status: 200, body: undefined as any };
  const r = {
    status(c: number) {
      out.status = c;
      return r;
    },
    json(b: unknown) {
      out.body = b;
      return r;
    },
    setHeader() {
      return r;
    },
  } as unknown as Response;
  return { out, r };
}

function req(extra: Record<string, unknown>) {
  return { query: {}, params: {}, headers: {}, auth: { tenant_id: "tenant-a", user_id: "member-1" }, ...extra } as unknown as Request;
}

function csvFile(rows: string[]) {
  return { buffer: Buffer.from(["email", ...rows].join("\n"), "utf8"), originalname: "mine.csv" };
}

async function readContacts() {
  const { out, r } = res();
  await getEmailListContacts(req({ params: { id: LIST }, query: { limit: "200" } }), r);
  return out;
}

beforeEach(() => {
  db.role = "member";
  db.seq = 0;
  db.clock = 0;
  db.importCalls = [];
  db.lists = [{ id: LIST, tenant: "tenant-a", name: "Customers" }];
  db.versions = [
    {
      id: "V-db",
      tenant: "tenant-a",
      list: LIST,
      at: 0,
      source_kind: "database",
      source_ref: { db_type: "postgres", table: "users", column: "email" },
      emails: [...DB_EMAILS],
      consented: true,
    },
  ];
});

async function readLists() {
  const { out, r } = res();
  await getEmailLists(req({}), r);
  return out;
}

describe("a member adding a CSV to a database-sourced list", () => {
  it("writes, keeps the list database-sourced, and answers only \"received\"", async () => {
    const { out: imp, r } = res();
    await importCsv(req({ body: { column: "email", list_id: LIST }, file: csvFile(["dave@mine.example"]) }), r);
    expect(imp.status).toBe(200);
    expect(imp.body).toEqual({ list_id: LIST, version_id: "V1", received: true, membership_hidden: true, column: "email" });
    expect(db.importCalls).toHaveLength(1);
    expect(db.importCalls[0].p_source_kind).toBe("database");
    expect([...(db.importCalls[0].p_emails as string[])].sort()).toEqual([...DB_EMAILS, "dave@mine.example"].sort());
    expect(db.importCalls[0].p_source_ref).toEqual({ column: "email", mixed: "database_and_csv" });
  });

  it("marks both sources whatever the file overlaps, so the mark tells a member nothing", async () => {
    const mark = async (email: string) => {
      const { r } = res();
      await importCsv(req({ body: { column: "email", list_id: LIST }, file: csvFile([email]) }), r);
      return ((await readLists()).body.lists as Array<Record<string, any>>).find((l) => l.id === LIST)!.latest.mixed;
    };
    expect(await mark(DB_EMAILS[0])).toBe(true);
    db.versions = db.versions.filter((v) => v.id === "V-db");
    expect(await mark("nobody@mine.example")).toBe(true);
  });

  it("the owner's consent step names both sources, never only the database", async () => {
    const { r } = res();
    await importCsv(req({ body: { column: "email", list_id: LIST }, file: csvFile(["dave@mine.example"]) }), r);
    db.role = "owner";
    const card = ((await readLists()).body.lists as Array<Record<string, any>>).find((l) => l.id === LIST)!;
    expect(card.needs_consent).toBe(true);
    expect(card.latest).toMatchObject({ source_kind: "database", mixed: true, source_label: null, consented: false });
    expect(card.active.id).toBe("V-db");
  });

  it("answers the same whether or not the address was already on the list", async () => {
    const send = async (email: string) => {
      const { out, r } = res();
      await importCsv(req({ body: { column: "email", list_id: LIST }, file: csvFile([email]) }), r);
      const { version_id: _v, ...rest } = out.body as Record<string, unknown>;
      return { status: out.status, rest };
    };
    const on = await send(DB_EMAILS[0]);
    const off = await send("nobody@mine.example");
    expect(on).toEqual(off);
  });

  it.each(["member", "viewer", null])("a %s reads no members and no count of it afterwards", async (role) => {
    const { r } = res();
    await importCsv(req({ body: { column: "email", list_id: LIST }, file: csvFile(["dave@mine.example"]) }), r);
    db.role = role;
    const contacts = await readContacts();
    expect(contacts.status).toBe(200);
    expect(contacts.body).toMatchObject({ total: null, contacts: [], members_hidden: true, source_kind: "database" });
    const lists = await readLists();
    const card = (lists.body.lists as Array<Record<string, any>>).find((l) => l.id === LIST)!;
    expect(card.members_hidden).toBe(true);
    expect(card.latest.contact_count).toBeNull();
    const raw = JSON.stringify([contacts.body, lists.body]);
    for (const e of [...DB_EMAILS, "dave@mine.example"]) expect(raw).not.toContain(e.split("@")[0]);
    expect(raw).not.toMatch(/"(total|contact_count|sendable|unsubscribed_or_bounced)":\d/);
  });

  it("an owner reading the same merged list still sees the addresses and counts in full", async () => {
    const { r } = res();
    await importCsv(req({ body: { column: "email", list_id: LIST }, file: csvFile(["dave@mine.example"]) }), r);
    db.role = "owner";
    const after = await readContacts();
    expect(after.body.masked).toBe(false);
    expect(after.body.total).toBe(4);
    expect((after.body.contacts as { email: string }[]).map((c) => c.email).sort()).toEqual([...DB_EMAILS, "dave@mine.example"].sort());
    const card = ((await readLists()).body.lists as Array<Record<string, any>>).find((l) => l.id === LIST)!;
    expect(card.members_hidden).toBe(false);
    expect(card.latest.contact_count).toBe(4);
  });

  it("an owner's own import still gets its counts", async () => {
    db.role = "owner";
    const { out, r } = res();
    await importCsv(req({ body: { column: "email", list_id: LIST }, file: csvFile([DB_EMAILS[0], "dave@mine.example"]) }), r);
    expect(out.body).toMatchObject({ added: 1 });
  });

  it("a CSV list stays a CSV list when a CSV is added to it", async () => {
    db.versions[0].source_kind = "csv";
    const { r } = res();
    await importCsv(req({ body: { column: "email", list_id: LIST }, file: csvFile(["dave@mine.example"]) }), r);
    expect(db.importCalls[0].p_source_kind).toBe("csv");
    expect((await readContacts()).body.masked).toBe(false);
  });
});

describe("previewing a CSV into a database-sourced list", () => {
  async function preview() {
    const { out, r } = res();
    await previewCsv(
      req({ body: { column: "email", list_id: LIST }, file: csvFile(["alice@secret.example", "bob@secret.example", "dave@mine.example"]) }),
      r,
    );
    return out;
  }

  it.each(["member", "viewer", null])("does not tell a %s which addresses are already on it", async (role) => {
    db.role = role;
    const out = await preview();
    expect(out.status).toBe(200);
    expect(out.body.counts.already_on_list).toBeUndefined();
    expect(out.body.counts.new).toBe(3);
    expect(out.body.counts.membership_hidden).toBe(true);
    expect(db.importCalls).toHaveLength(0);
  });

  it.each(["owner", "admin"])("tells an %s how many are already on it", async (role) => {
    db.role = role;
    const out = await preview();
    expect(out.body.counts).toMatchObject({ new: 1, already_on_list: 2 });
  });

  it("still tells a member about overlap on a CSV list", async () => {
    db.versions[0].source_kind = "csv";
    const out = await preview();
    expect(out.body.counts).toMatchObject({ new: 1, already_on_list: 2 });
  });
});
