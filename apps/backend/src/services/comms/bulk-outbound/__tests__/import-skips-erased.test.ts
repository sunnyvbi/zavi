import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Contact = { id: string; tenant: string; email_norm: string | null; display_name: string | null; erased_at: string | null };
type Suppression = { tenant: string; email: string; reason: string };
type Version = { id: string; tenant: string; list_id: string; created_at: number; source_kind: string; source_ref: Record<string, unknown>; contact_ids: string[] };
type List = { id: string; tenant: string; name: string; archived_at: string | null };

const db = vi.hoisted(() => ({
  contacts: [] as Contact[],
  suppression: [] as Suppression[],
  versions: [] as Version[],
  lists: [] as List[],
  seq: 0,
  importCalls: 0,
  suppressionReads: 0,
  failSuppressionRead: false,
  onImport: null as null | (() => { ok: false; reason: string } | null),
}));

const contactsOf = (tenant: string) => db.contacts.filter((c) => c.tenant === tenant);

function latest(tenant: string, listId: string): Version | undefined {
  return db.versions.filter((v) => v.tenant === tenant && v.list_id === listId).sort((a, b) => b.created_at - a.created_at)[0];
}

function isBlocked(tenant: string, email: string): boolean {
  return db.suppression.some((s) => s.tenant === tenant && s.email === email);
}

function importVersion(tenant: string, a: Record<string, unknown>) {
  db.importCalls++;
  const early = db.onImport?.();
  if (early) return early;
  const emails = a.p_emails as string[];
  const names = (a.p_names as (string | null)[] | undefined) ?? null;
  if (emails.length === 0) return { ok: false, reason: "no_addresses" };
  let listId = a.p_list_id as string | null;
  if (listId) {
    const base = a.p_base_version_id as string | undefined;
    if (base && latest(tenant, listId)?.id !== base) return { ok: false, reason: "list_changed" };
  } else {
    listId = `L${++db.seq}`;
    db.lists.push({ id: listId, tenant, name: String(a.p_list_name), archived_at: null });
  }
  const ids = emails.map((email, i) => {
    const hit = db.contacts.find((c) => c.tenant === tenant && c.email_norm === email);
    if (hit) return hit.id;
    const row = { id: `C${++db.seq}`, tenant, email_norm: email, display_name: names?.[i] ?? null, erased_at: null };
    db.contacts.push(row);
    return row.id;
  });
  const base = a.p_base_version_id ? db.versions.find((v) => v.id === a.p_base_version_id) : null;
  const baseEmails = new Set(base?.contact_ids.map((id) => db.contacts.find((c) => c.id === id)?.email_norm) ?? []);
  const fresh = emails.filter((e) => !baseEmails.has(e));
  const v: Version = {
    id: `V${++db.seq}`,
    tenant,
    list_id: listId,
    created_at: db.seq,
    source_kind: String(a.p_source_kind),
    source_ref: (a.p_source_ref as Record<string, unknown>) ?? {},
    contact_ids: ids,
  };
  db.versions.push(v);
  return {
    ok: true,
    list_id: listId,
    version_id: v.id,
    contact_count: emails.length,
    already_blocked: emails.filter((e) => isBlocked(tenant, e)).length,
    new_count: fresh.length,
    new_blocked: fresh.filter((e) => isBlocked(tenant, e)).length,
  };
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (tenant: string, name: string, a: Record<string, unknown>) => {
    if (name === "email_list_import_version") return { data: importVersion(tenant, a), error: null };
    if (name === "email_list_version_emails") {
      const v = db.versions.find((x) => x.id === a.p_version_id && x.tenant === tenant);
      const out = (v?.contact_ids ?? []).map((id) => db.contacts.find((c) => c.id === id)?.email_norm).filter(Boolean);
      return { data: out, error: null };
    }
    if (name === "email_contacts_existing_count") {
      const want = a.p_emails as string[];
      return { data: contactsOf(tenant).filter((c) => c.email_norm && want.includes(c.email_norm)).length, error: null };
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
        range: async (from: number, to: number) => {
          if (table !== "email_suppression") throw new Error(`unexpected range on ${table}`);
          db.suppressionReads++;
          if (db.failSuppressionRead) return { data: null, error: { message: "boom" } };
          const reason = where.find(([c]) => c === "reason")?.[1];
          const rows = db.suppression
            .filter((s) => s.tenant === tenant && s.reason === reason)
            .sort((x, y) => (x.email < y.email ? -1 : 1))
            .slice(from, to + 1);
          return { data: rows.map((r) => ({ email: r.email })), error: null };
        },
        maybeSingle: async () => {
          const id = where.find(([c]) => c === "id" || c === "list_id")?.[1] as string;
          if (table === "email_lists") {
            const row = db.lists.find((l) => l.tenant === tenant && l.id === id && !l.archived_at);
            return { data: row ? { id: row.id } : null, error: null };
          }
          if (table === "email_list_versions") {
            const v = latest(tenant, id);
            return { data: v ? { id: v.id, source_kind: v.source_kind, source_ref: v.source_ref } : null, error: null };
          }
          throw new Error(`unexpected table ${table}`);
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true, loadTenantRole: async () => "owner" }));

import { importCsvChain, previewCsvChain } from "@/routes/workspace/email-lists";
import { BulkEmailError } from "../errors";
import { importListVersion, previewImportCounts, type ImportResult } from "../lists";

const T = "tenant-a";
const OTHER = "tenant-b";
const ERASED = "zavi-qa-f79-2@yopmail.com";

type Handler = (r: Request, s: Response) => Promise<void>;
const importCsv = importCsvChain[importCsvChain.length - 1] as Handler;
const previewCsv = previewCsvChain[previewCsvChain.length - 1] as Handler;

function call() {
  let status = 200;
  let body: any;
  const res = {
    status: vi.fn((v: number) => {
      status = v;
      return res;
    }),
    json: vi.fn((v: unknown) => {
      body = v;
      return res;
    }),
    setHeader: vi.fn(),
  } as unknown as Response;
  return { res, out: () => ({ status, body }) };
}

const upload = (csv: string, body: Record<string, unknown>) =>
  ({
    body,
    query: {},
    params: {},
    headers: {},
    auth: { tenant_id: T, user_id: "user-a" },
    file: { buffer: Buffer.from(csv, "utf8"), originalname: "people.csv" },
  }) as unknown as Request;

const seedList = (tenant: string, name: string, emails: string[], sourceKind = "csv") => {
  const id = `L${++db.seq}`;
  db.lists.push({ id, tenant, name, archived_at: null });
  const contact_ids = emails.map((email) => {
    const row = { id: `C${++db.seq}`, tenant, email_norm: email, display_name: null, erased_at: null };
    db.contacts.push(row);
    return row.id;
  });
  db.versions.push({ id: `V${++db.seq}`, tenant, list_id: id, created_at: db.seq, source_kind: sourceKind, source_ref: {}, contact_ids });
  return id;
};

const erase = (tenant: string, email: string) => {
  const c = db.contacts.find((x) => x.tenant === tenant && x.email_norm === email);
  if (c) Object.assign(c, { email_norm: null, display_name: null, erased_at: "2026-11-02T00:00:00Z" });
  db.suppression.push({ tenant, email, reason: "erased" });
};

const onLatest = (listId: string) =>
  (latest(T, listId)?.contact_ids ?? []).map((id) => db.contacts.find((c) => c.id === id)?.email_norm).sort();

const stored = (tenant = T) => contactsOf(tenant).map((c) => c.email_norm).filter(Boolean).sort();

beforeEach(() => {
  db.contacts = [];
  db.suppression = [];
  db.versions = [];
  db.lists = [];
  db.seq = 0;
  db.importCalls = 0;
  db.suppressionReads = 0;
  db.failSuppressionRead = false;
  db.onImport = null;
});

describe("an erased address is not imported again", () => {
  it("a one-row CSV into an existing list stores nothing, adds no version, and reports one skipped", async () => {
    const list = seedList(T, "Testing", [ERASED, "kept@example.com"]);
    erase(T, ERASED);
    const versionsBefore = db.versions.length;

    const done = (await importListVersion({
      tenantId: T,
      userId: "u",
      listId: list,
      sourceKind: "csv",
      values: [ERASED],
      names: ["Ada Lovelace"],
      cap: 10_000,
    })) as ImportResult;

    expect(done).toEqual({ list_id: list, version_id: null, added: 0, invalid: 0, duplicates: 0, over_limit: 0, already_unsubscribed: 0, skipped_erased: 1 });
    expect(db.importCalls).toBe(0);
    expect(stored()).toEqual(["kept@example.com"]);
    expect(contactsOf(T)).toHaveLength(2);
    expect(contactsOf(T).some((c) => c.email_norm === ERASED || c.display_name === "Ada Lovelace")).toBe(false);
    expect(db.versions).toHaveLength(versionsBefore);
  });

  it("the CSV route answers 200 with the skip when the file holds only an erased address, and creates no list", async () => {
    db.suppression.push({ tenant: T, email: ERASED, reason: "erased" });
    const { res, out } = call();
    await importCsv(upload(`email\n${ERASED}\n`, { column: "email", name: "Fresh list" }), res);
    expect(out().status).toBe(200);
    expect(out().body).toMatchObject({ list_id: null, version_id: null, added: 0, skipped_erased: 1, column: "email" });
    expect(db.lists).toEqual([]);
    expect(db.contacts).toEqual([]);
    expect(db.importCalls).toBe(0);
  });

  it("the database path follows the same rule and a mixed column keeps only the live address", async () => {
    db.suppression.push({ tenant: T, email: ERASED, reason: "erased" });
    const done = (await importListVersion({
      tenantId: T,
      userId: "u",
      name: "From DB",
      sourceKind: "database",
      sourceRef: { table: "users" },
      values: [ERASED, "live@example.com"],
      cap: 5_000,
      canSeeDatabaseAddresses: true,
    })) as ImportResult;
    expect(done).toMatchObject({ added: 1, skipped_erased: 1, already_unsubscribed: 0 });
    expect(stored()).toEqual(["live@example.com"]);
    expect(onLatest(done.list_id as string)).toEqual(["live@example.com"]);
  });

  it("a database column counts blank, null and non-address values as dropped rows, a CSV does not count blanks", async () => {
    db.suppression.push({ tenant: T, email: ERASED, reason: "erased" });
    seedList(T, "Existing", ["have@example.com"]);
    const values = ["new1@example.com", "new2@example.com", "new3@example.com", "have@example.com", ERASED, "not-an-email", "", "   ", null];
    const done = (await importListVersion({
      tenantId: T,
      userId: "u",
      name: "QA DB import",
      sourceKind: "database",
      sourceRef: { table: "users" },
      values,
      cap: 5_000,
      canSeeDatabaseAddresses: true,
    })) as ImportResult;
    expect(done).toMatchObject({ added: 4, invalid: 4, skipped_erased: 1 });
    const csv = (await importListVersion({ tenantId: T, userId: "u", name: "CSV", sourceKind: "csv", values: ["c@example.com", "", "nope"], cap: 10 })) as ImportResult;
    expect(csv).toMatchObject({ added: 1, invalid: 1 });
  });

  it("a database column with no valid address is refused with words that name the column, and writes nothing", async () => {
    await expect(
      importListVersion({ tenantId: T, userId: "u", name: "Plans", sourceKind: "database", values: ["pro", "free", "", null], cap: 5_000, canSeeDatabaseAddresses: true }),
    ).rejects.toMatchObject({ code: "no_addresses", message: expect.stringContaining("That column has no valid email addresses") });
    expect(db.importCalls).toBe(0);
    expect(db.lists).toEqual([]);
  });

  it("matches the file's spelling of the address and keeps names lined up with the people who stay", async () => {
    db.suppression.push({ tenant: T, email: ERASED, reason: "erased" });
    const done = (await importListVersion({
      tenantId: T,
      userId: "u",
      name: "Named",
      sourceKind: "csv",
      values: ["first@example.com", `  ${ERASED.toUpperCase()} `, "last@example.com"],
      names: ["First Person", "Erased Person", "Last Person"],
      cap: 10_000,
    })) as ImportResult;
    expect(done).toMatchObject({ added: 2, skipped_erased: 1 });
    expect(contactsOf(T).map((c) => [c.email_norm, c.display_name])).toEqual([
      ["first@example.com", "First Person"],
      ["last@example.com", "Last Person"],
    ]);
  });

  it("drops a row an earlier import brought back from the next version of its list", async () => {
    const list = seedList(T, "Testing", [ERASED, "kept@example.com"]);
    db.suppression.push({ tenant: T, email: ERASED, reason: "erased" });
    const done = (await importListVersion({ tenantId: T, userId: "u", listId: list, sourceKind: "csv", values: ["new@example.com"], cap: 10_000 })) as ImportResult;
    expect(done).toMatchObject({ added: 1, skipped_erased: 0 });
    expect(onLatest(list)).toEqual(["kept@example.com", "new@example.com"]);
  });

  it("finds an erased address past the first page of a workspace's erasures", async () => {
    for (let i = 0; i < 2_500; i++) db.suppression.push({ tenant: T, email: `a${String(i).padStart(5, "0")}@example.com`, reason: "erased" });
    db.suppression.push({ tenant: T, email: "zz-last@example.com", reason: "erased" });
    const done = (await importListVersion({ tenantId: T, userId: "u", name: "Big", sourceKind: "csv", values: ["zz-last@example.com", "ok@example.com"], cap: 10_000 })) as ImportResult;
    expect(done).toMatchObject({ added: 1, skipped_erased: 1 });
    expect(stored()).toEqual(["ok@example.com"]);
    expect(db.suppressionReads).toBeGreaterThan(2);
  });

  it("re-reads the erasures on a retry, so an address erased during the first attempt stays out", async () => {
    const list = seedList(T, "Testing", ["kept@example.com"]);
    let first = true;
    db.onImport = () => {
      if (!first) return null;
      first = false;
      db.suppression.push({ tenant: T, email: "racing@example.com", reason: "erased" });
      return { ok: false, reason: "list_changed" };
    };
    const done = (await importListVersion({
      tenantId: T,
      userId: "u",
      listId: list,
      sourceKind: "csv",
      values: ["racing@example.com", "ok@example.com"],
      cap: 10_000,
    })) as ImportResult;
    expect(db.importCalls).toBe(2);
    expect(done).toMatchObject({ added: 1, skipped_erased: 1 });
    expect(stored()).toEqual(["kept@example.com", "ok@example.com"]);
  });

  it("writes nothing when the erasures cannot be read", async () => {
    db.failSuppressionRead = true;
    await expect(importListVersion({ tenantId: T, userId: "u", name: "X", sourceKind: "csv", values: ["a@example.com"], cap: 10 })).rejects.toBeInstanceOf(BulkEmailError);
    expect(db.importCalls).toBe(0);
    expect(db.contacts).toEqual([]);
  });

  it("an archived list still refuses, even when every address is erased", async () => {
    const list = seedList(T, "Old", ["kept@example.com"]);
    db.lists[0].archived_at = "2026-11-01T00:00:00Z";
    db.suppression.push({ tenant: T, email: ERASED, reason: "erased" });
    await expect(importListVersion({ tenantId: T, userId: "u", listId: list, sourceKind: "csv", values: [ERASED], cap: 10 })).rejects.toMatchObject({ code: "list_not_found" });
  });

  it("a member adding only erased addresses to a database list gets the same answer as any import", async () => {
    const list = seedList(T, "Database", ["hidden@example.com"], "database");
    db.suppression.push({ tenant: T, email: ERASED, reason: "erased" });
    const before = latest(T, list)!.id;
    const done = await importListVersion({ tenantId: T, userId: "member", listId: list, sourceKind: "csv", values: [ERASED], cap: 10, canSeeDatabaseAddresses: false });
    expect(done).toEqual({ list_id: list, version_id: before, received: true, membership_hidden: true });
    expect(db.importCalls).toBe(0);
  });

  it("another workspace's erasure of the same address changes nothing here", async () => {
    db.suppression.push({ tenant: OTHER, email: ERASED, reason: "erased" });
    const done = (await importListVersion({ tenantId: T, userId: "u", name: "Mine", sourceKind: "csv", values: [ERASED], cap: 10 })) as ImportResult;
    expect(done).toMatchObject({ added: 1, skipped_erased: 0 });
    expect(stored()).toEqual([ERASED]);
  });
});

describe("the import preview", () => {
  it("counts an erased address as skipped, never as new, for a new list", async () => {
    db.contacts.push({ id: "C", tenant: T, email_norm: "known@example.com", display_name: null, erased_at: null });
    db.suppression.push({ tenant: T, email: ERASED, reason: "erased" });
    const { res, out } = call();
    await previewCsv(upload(`email\n${ERASED}\nknown@example.com\nnew@example.com\n`, { column: "email" }), res);
    expect(out().body.counts).toEqual({ new: 1, already_in_contacts: 1, skipped_erased: 1, duplicate_in_file: 0, bad: 0, over_limit: 0 });
  });

  it("counts it the same way into an existing list", async () => {
    const list = seedList(T, "Testing", ["kept@example.com"]);
    db.suppression.push({ tenant: T, email: ERASED, reason: "erased" });
    const counts = await previewImportCounts({ tenantId: T, userId: "u", listId: list, values: [ERASED, "new@example.com"], cap: 10_000 });
    expect(counts).toMatchObject({ new: 1, skipped_erased: 1 });
  });
});

describe("other suppression reasons keep today's behaviour", () => {
  it.each(["unsubscribe", "bounce", "complaint", "manual"])("a %s address is stored, listed, and counted as added and blocked", async (reason) => {
    const list = seedList(T, "Testing", ["kept@example.com"]);
    db.suppression.push({ tenant: T, email: "held@example.com", reason });
    const done = (await importListVersion({ tenantId: T, userId: "u", listId: list, sourceKind: "csv", values: ["held@example.com"], names: ["Held Person"], cap: 10_000 })) as ImportResult;
    expect(done).toMatchObject({ added: 1, already_unsubscribed: 1, skipped_erased: 0 });
    expect(done.version_id).toBeTruthy();
    expect(db.importCalls).toBe(1);
    expect(contactsOf(T).find((c) => c.email_norm === "held@example.com")).toMatchObject({ display_name: "Held Person", erased_at: null });
    expect(onLatest(list)).toEqual(["held@example.com", "kept@example.com"]);
  });
});
