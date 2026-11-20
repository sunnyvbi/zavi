import { beforeEach, describe, expect, it, vi } from "vitest";

type Version = { id: string; tenant_id: string; list_id: string; created_at: number; emails: string[]; names: (string | null)[] | null; source_kind?: string; source_ref?: Record<string, unknown> };

const db = vi.hoisted(() => ({
  versions: [] as Version[],
  lists: new Map<string, string>(),
  clock: 0,
  seq: 0,
  blocked: new Set<string>(),
  importCalls: [] as { tenant: string; args: Record<string, unknown> }[],
  clientTenants: [] as string[],
  reads: 0,
  readWaiters: [] as { n: number; go: () => void }[],
  holdImportsUntilReads: 0,
  afterRead: null as null | (() => void),
}));

function readsReached(n: number): Promise<void> {
  if (db.reads >= n) return Promise.resolve();
  return new Promise((go) => db.readWaiters.push({ n, go }));
}

function latestVersion(tenant: string, listId: string): Version | undefined {
  return db.versions
    .filter((x) => x.tenant_id === tenant && x.list_id === listId)
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))[0];
}

function newVersion(tenant: string, listId: string, emails: string[], names: (string | null)[] | null = null, sourceKind = "csv"): Version {
  const v = { id: `V${++db.seq}`, tenant_id: tenant, list_id: listId, created_at: ++db.clock, emails, names, source_kind: sourceKind };
  db.versions.push(v);
  return v;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => {
    db.clientTenants.push(tenant);
    return {
      from: (table: string) => {
        if (table === "email_suppression") {
          const q = { select: () => q, eq: () => q, order: () => q, range: async () => ({ data: [], error: null }) };
          return q;
        }
        if (table !== "email_list_versions") throw new Error(`unexpected table ${table}`);
        const filters: [string, unknown][] = [];
        const orders: { col: "created_at" | "id"; desc: boolean }[] = [];
        let limit = Infinity;
        const builder = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return builder;
          },
          order: (col: string, opts: { ascending: boolean }) => {
            if (col !== "created_at" && col !== "id") throw new Error("unexpected order");
            orders.push({ col, desc: !opts.ascending });
            return builder;
          },
          limit: (n: number) => {
            limit = n;
            return builder;
          },
          maybeSingle: async () => {
            const rows = db.versions
              .filter((v) => v.tenant_id === tenant && filters.every(([c, val]) => (v as unknown as Record<string, unknown>)[c] === val))
              .sort((a, b) => {
                for (const o of orders) {
                  const x = a[o.col];
                  const y = b[o.col];
                  if (x === y) continue;
                  return (x < y ? -1 : 1) * (o.desc ? -1 : 1);
                }
                return 0;
              })
              .slice(0, limit);
            if (rows.length > 1) return { data: null, error: { message: "more than one row" } };
            return { data: rows[0] ? { id: rows[0].id, source_kind: rows[0].source_kind, source_ref: rows[0].source_ref ?? {} } : null, error: null };
          },
        };
        return builder;
      },
    };
  },
  tenantRpc: async (tenant: string, name: string, args: Record<string, unknown>) => {
    if (name === "email_list_version_emails") {
      const v = db.versions.find((x) => x.tenant_id === tenant && x.id === args.p_version_id && x.list_id === args.p_list_id);
      const all = v ? [...v.emails].sort() : [];
      await Promise.resolve();
      db.reads++;
      db.afterRead?.();
      for (const w of db.readWaiters.filter((x) => db.reads >= x.n)) w.go();
      return { data: all.slice(0, Number(args.p_limit)), error: null };
    }
    if (name === "email_list_contacts_page") {
      const v = db.versions.find((x) => x.tenant_id === tenant && x.id === args.p_version_id && x.list_id === args.p_list_id);
      const all = v ? [...v.emails].sort() : [];
      const limit = Math.min(Math.max(Number(args.p_limit), 1), 200);
      const offset = Number(args.p_offset);
      const contacts = all.slice(offset, offset + limit).map((email) => ({ id: email, email, status: db.blocked.has(email) ? "unsubscribed" : "ok" }));
      return { data: { total: all.length, contacts }, error: null };
    }
    if (name === "email_list_import_version") {
      await readsReached(db.holdImportsUntilReads);
      db.importCalls.push({ tenant, args });
      const listId = args.p_list_id as string | null;
      if (listId && db.lists.get(listId) !== tenant) return { data: { ok: false, reason: "list_not_found" }, error: null };
      const base = (args.p_base_version_id as string | undefined) ?? null;
      if (listId && base && latestVersion(tenant, listId)?.id !== base) return { data: { ok: false, reason: "list_changed" }, error: null };
      const baseEmails = new Set(base ? db.versions.find((x) => x.id === base)?.emails ?? [] : []);
      const id = listId ?? `L${++db.seq}`;
      if (!listId) db.lists.set(id, tenant);
      const emails = [...new Set(args.p_emails as string[])];
      if (emails.length > 10_000) return { data: { ok: false, reason: "too_many" }, error: null };
      const v = newVersion(tenant, id, emails, (args.p_names as (string | null)[] | undefined) ?? null, String(args.p_source_kind));
      v.source_ref = (args.p_source_ref as Record<string, unknown> | undefined) ?? {};
      const alreadyBlocked = emails.filter((e) => db.blocked.has(e)).length;
      const fresh = emails.filter((e) => !baseEmails.has(e));
      return {
        data: {
          ok: true,
          list_id: id,
          version_id: v.id,
          contact_count: emails.length,
          already_blocked: alreadyBlocked,
          new_count: fresh.length,
          new_blocked: fresh.filter((e) => db.blocked.has(e)).length,
        },
        error: null,
      };
    }
    throw new Error(`unexpected rpc ${name}`);
  },
}));

import { importListVersion as importAny, type ImportResult } from "../lists";

const importListVersion = async (a: Parameters<typeof importAny>[0]) => (await importAny(a)) as ImportResult;

const TENANT = "7c70da58-091e-4ff5-8f77-343034d448d9";
const OTHER = "11111111-2222-3333-4444-555555555555";
const LIST = "list-qa-messy-1026";

const qa = ["zavi-email-qa-1@yopmail.com", "zavi-email-qa-2@yopmail.com", "zavi-email-qa-3@yopmail.com"];
const pages = Array.from({ length: 55 }, (_, i) => `zavi-email-qa-page-${i}@yopmail.com`);

function latestEmails(tenant: string, listId: string): string[] {
  const v = db.versions.filter((x) => x.tenant_id === tenant && x.list_id === listId).sort((a, b) => b.created_at - a.created_at)[0];
  return v ? [...v.emails].sort() : [];
}

describe("importing into an existing list adds to it", () => {
  beforeEach(() => {
    db.versions = [];
    db.lists = new Map([[LIST, TENANT]]);
    db.clock = 0;
    db.seq = 0;
    db.blocked = new Set();
    db.importCalls = [];
    db.clientTenants = [];
    db.reads = 0;
    db.readWaiters = [];
    db.holdImportsUntilReads = 0;
    db.afterRead = null;
    newVersion(TENANT, LIST, ["old-only@yopmail.com"]);
    newVersion(TENANT, LIST, [...qa, ...pages]);
  });

  it("keeps the 58 people already on the list and adds the file's new ones, without duplicates", async () => {
    const file = ["Zavi-Email-QA-1@yopmail.com", "new-a@yopmail.com", "new-b@yopmail.com"];
    const out = await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: file, cap: 10_000 });

    const after = latestEmails(TENANT, LIST);
    expect(after).toEqual([...qa, ...pages, "new-a@yopmail.com", "new-b@yopmail.com"].sort());
    expect(after).not.toContain("old-only@yopmail.com");
    const sent = db.importCalls[0].args.p_emails as string[];
    expect(sent).toHaveLength(new Set(sent).size);
    expect(out.added).toBe(2);
    expect(db.importCalls[0].tenant).toBe(TENANT);
    expect(db.clientTenants.every((t) => t === TENANT)).toBe(true);
  });

  it("a plain member adds to a list copied from the database but gets no counts back", async () => {
    newVersion(TENANT, LIST, [...qa], null, "database");
    const add = (email: string, canSeeDatabaseAddresses?: boolean) =>
      importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: [email], cap: 10_000, canSeeDatabaseAddresses });
    const on = await add(qa[0]);
    const off = await add("someone-new@yopmail.com");
    expect(on).toEqual({ list_id: LIST, version_id: expect.any(String), received: true, membership_hidden: true });
    expect({ ...off, version_id: "" }).toEqual({ ...on, version_id: "" });
    expect(latestEmails(TENANT, LIST)).toContain("someone-new@yopmail.com");
    expect(db.importCalls.every((c) => c.args.p_source_kind === "database")).toBe(true);
    expect(await add(qa[1], true)).toMatchObject({ added: 0 });
  });

  it("a CSV added to a database list, or a database column added to a CSV list, marks the version as both sources", async () => {
    const mark = () => (db.importCalls.at(-1)!.args.p_source_ref as Record<string, unknown>).mixed;
    await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: ["csv-a@yopmail.com"], cap: 10_000, sourceRef: { column: "email" } });
    expect(mark()).toBeUndefined();
    await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "database", values: ["db-a@yopmail.com"], cap: 10_000 });
    expect(mark()).toBe("database_and_csv");
    await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: ["csv-b@yopmail.com"], cap: 10_000 });
    expect(mark()).toBe("database_and_csv");
    expect(db.importCalls.at(-1)!.args.p_source_kind).toBe("database");
  });

  it("two imports in a row keep the first one's people, even before consent", async () => {
    await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: ["first@yopmail.com"], cap: 10_000 });
    await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "database", values: ["second@yopmail.com"], cap: 5_000 });
    const after = latestEmails(TENANT, LIST);
    expect(after).toContain("first@yopmail.com");
    expect(after).toContain("second@yopmail.com");
    expect(after).toEqual(expect.arrayContaining(qa));
    expect(after).toHaveLength(60);
  });

  it("names stay lined up with the file's addresses and the kept people get no name", async () => {
    await importListVersion({
      tenantId: TENANT,
      userId: "u1",
      listId: LIST,
      sourceKind: "csv",
      values: ["new-a@yopmail.com", "zavi-email-qa-2@yopmail.com"],
      names: ["Ada Lovelace", "Bo Q"],
      cap: 10_000,
    });
    const args = db.importCalls[0].args;
    const emails = args.p_emails as string[];
    const names = args.p_names as (string | null)[];
    expect(names).toHaveLength(emails.length);
    expect(names[emails.indexOf("new-a@yopmail.com")]).toBe("Ada Lovelace");
    expect(names[emails.indexOf("zavi-email-qa-2@yopmail.com")]).toBe("Bo Q");
    expect(names[emails.indexOf("zavi-email-qa-1@yopmail.com")]).toBeNull();
  });

  it("refuses with a clear reason when the list plus the file would pass 10,000, and writes nothing", async () => {
    db.versions = [];
    newVersion(TENANT, LIST, Array.from({ length: 9_999 }, (_, i) => `p${i}@yopmail.com`));
    const err = await importListVersion({
      tenantId: TENANT,
      userId: "u1",
      listId: LIST,
      sourceKind: "csv",
      values: ["p1@yopmail.com", "x@yopmail.com", "y@yopmail.com"],
      cap: 10_000,
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "too_many", status: 400 });
    expect(err.message).toMatch(/over 10,000/);
    expect(db.importCalls).toHaveLength(0);
    expect(latestEmails(TENANT, LIST)).toHaveLength(9_999);
  });

  it("an overlap that keeps the total at 10,000 still imports", async () => {
    db.versions = [];
    newVersion(TENANT, LIST, Array.from({ length: 9_999 }, (_, i) => `p${i}@yopmail.com`));
    await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: ["p1@yopmail.com", "x@yopmail.com"], cap: 10_000 });
    expect(latestEmails(TENANT, LIST)).toHaveLength(10_000);
  });

  it("never pulls another workspace's people into the list", async () => {
    newVersion(OTHER, LIST, ["someone-else@yopmail.com"]);
    await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: ["new-a@yopmail.com"], cap: 10_000 });
    expect(db.importCalls[0].args.p_emails).not.toContain("someone-else@yopmail.com");
    expect(latestEmails(TENANT, LIST)).toHaveLength(59);
  });

  it("reports added and already unsubscribed over the file's new people only, across many pages of the list", async () => {
    db.versions = [];
    const members = Array.from({ length: 450 }, (_, i) => `member-${String(i).padStart(3, "0")}@yopmail.com`);
    newVersion(TENANT, LIST, members);
    for (const m of members.slice(0, 300)) db.blocked.add(m);
    db.blocked.add("new-blocked@yopmail.com");
    const file = [members[0], members[400], "new-ok@yopmail.com", "new-blocked@yopmail.com"];
    const out = await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: file, cap: 10_000 });

    expect(latestEmails(TENANT, LIST)).toHaveLength(452);
    expect(out.added).toBe(2);
    expect(out.already_unsubscribed).toBe(1);
  });

  it("a file of people all already on the list adds nobody and reports nobody newly unsubscribed", async () => {
    db.blocked = new Set(qa);
    const out = await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: [...qa], cap: 10_000 });
    expect(out.added).toBe(0);
    expect(out.already_unsubscribed).toBe(0);
  });

  it("two versions with the same created_at resolve to the higher id every time", async () => {
    db.versions = [];
    db.versions.push({ id: "V1", tenant_id: TENANT, list_id: LIST, created_at: 5, emails: ["lower@yopmail.com"], names: null });
    db.versions.push({ id: "V2", tenant_id: TENANT, list_id: LIST, created_at: 5, emails: ["higher@yopmail.com"], names: null });
    await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: ["x@yopmail.com"], cap: 10_000 });
    expect(db.importCalls[0].args.p_emails).toEqual(["x@yopmail.com", "higher@yopmail.com"]);
  });

  it("two adds racing on the same list keep both files' people", async () => {
    db.holdImportsUntilReads = 2;
    const add = (email: string) => importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: [email], cap: 10_000 });
    const [a, b] = await Promise.all([add("racer-a@yopmail.com"), add("racer-b@yopmail.com")]);

    const after = latestEmails(TENANT, LIST);
    expect(after).toContain("racer-a@yopmail.com");
    expect(after).toContain("racer-b@yopmail.com");
    expect(after).toEqual(expect.arrayContaining([...qa, ...pages]));
    expect(after).toHaveLength(60);
    expect(a.added).toBe(1);
    expect(b.added).toBe(1);
    expect(db.versions.filter((v) => v.list_id === LIST).every((v) => v.emails.length <= 60)).toBe(true);
  });

  it("refuses with a retryable 409 and writes nothing when the list keeps changing under it", async () => {
    let n = 0;
    db.afterRead = () => {
      const latest = latestVersion(TENANT, LIST)!;
      newVersion(TENANT, LIST, [...latest.emails, `interloper-${++n}@yopmail.com`]);
    };
    const err = await importListVersion({ tenantId: TENANT, userId: "u1", listId: LIST, sourceKind: "csv", values: ["mine@yopmail.com"], cap: 10_000 }).catch((e) => e);

    expect(err).toMatchObject({ code: "list_changed", status: 409 });
    expect(err.message).toMatch(/try again/i);
    expect(db.versions.some((v) => v.emails.includes("mine@yopmail.com"))).toBe(false);
    const after = latestEmails(TENANT, LIST);
    expect(after).toContain("interloper-1@yopmail.com");
    expect(after).toContain("interloper-2@yopmail.com");
    expect(db.importCalls).toHaveLength(2);
  });

  it("people already on the list who were unsubscribed never count as newly unsubscribed", async () => {
    db.versions = [];
    newVersion(TENANT, LIST, ["kept-ok@yopmail.com", "kept-unsub@yopmail.com"]);
    db.blocked = new Set(["kept-unsub@yopmail.com", "new-unsub@yopmail.com"]);
    const out = await importListVersion({
      tenantId: TENANT,
      userId: "u1",
      listId: LIST,
      sourceKind: "csv",
      values: ["new-ok@yopmail.com", "new-unsub@yopmail.com", "kept-unsub@yopmail.com"],
      cap: 10_000,
    });
    expect(out.added).toBe(2);
    expect(out.already_unsubscribed).toBe(1);
  });

  it("a new list starts from the file alone", async () => {
    const out = await importListVersion({ tenantId: TENANT, userId: "u1", name: "Fresh", sourceKind: "csv", values: ["a@yopmail.com", "b@yopmail.com"], cap: 10_000 });
    expect(db.importCalls[0].args.p_emails).toEqual(["a@yopmail.com", "b@yopmail.com"]);
    expect(latestEmails(TENANT, out.list_id!)).toEqual(["a@yopmail.com", "b@yopmail.com"]);
    expect(out.added).toBe(2);
  });
});
