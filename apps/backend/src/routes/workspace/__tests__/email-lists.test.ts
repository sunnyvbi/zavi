import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  importVersion: vi.fn(),
  consent: vi.fn(),
  summaries: vi.fn(),
  contacts: vi.fn(),
  archive: vi.fn(),
  archived: vi.fn(),
  unarchive: vi.fn(),
  erase: vi.fn(),
  tables: vi.fn(),
  readColumn: vi.fn(),
  addDomain: vi.fn(),
  verifyDomain: vi.fn(),
  getDomain: vi.fn(),
  removeDomain: vi.fn(),
  viewerRole: "owner" as string | null,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: (...a: unknown[]) => mocks.role(...a),
  loadTenantRole: async () => {
    if (mocks.viewerRole === "<unreadable>") throw new Error("tenant_users role read failed");
    return mocks.viewerRole;
  },
}));
vi.mock("@/services/comms/bulk-outbound/lists", async (orig) => {
  const real = await orig<typeof import("@/services/comms/bulk-outbound/lists")>();
  return {
  importListVersion: (...a: unknown[]) => mocks.importVersion(...a),
  recordListConsent: (...a: unknown[]) => mocks.consent(...a),
  listSummaries: (...a: unknown[]) => mocks.summaries(...a),
  listContactsPage: (...a: unknown[]) => mocks.contacts(...a),
  archiveList: (...a: unknown[]) => mocks.archive(...a),
  archivedLists: (...a: unknown[]) => mocks.archived(...a),
  archivedListsFor: real.archivedListsFor,
  unarchiveList: (...a: unknown[]) => mocks.unarchive(...a),
  eraseContact: (...a: unknown[]) => mocks.erase(...a),
  };
});
vi.mock("@/services/comms/bulk-outbound/database-import", () => ({
  listImportTables: (...a: unknown[]) => mocks.tables(...a),
  readDatabaseColumn: (...a: unknown[]) => mocks.readColumn(...a),
}));
vi.mock("@/services/comms/bulk-outbound/sending-domain", () => ({
  addSendingDomain: (...a: unknown[]) => mocks.addDomain(...a),
  verifySendingDomain: (...a: unknown[]) => mocks.verifyDomain(...a),
  getSendingDomain: (...a: unknown[]) => mocks.getDomain(...a),
  removeSendingDomain: (...a: unknown[]) => mocks.removeDomain(...a),
}));
vi.mock("@/services/comms/bulk-outbound/readiness", () => ({ readEmailSettingText: async () => null, readPostalAddress: async (): Promise<string | null> => null }));
vi.mock("@/services/comms/bulk-outbound/config", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/config")>()),
  bulkSendgridKey: () => "bulk-key",
}));

import {
  deleteEmailContact,
  deleteEmailList,
  getArchivedEmailLists,
  getEmailListContacts,
  getImportTableColumns,
  getImportTables,
  importCsvChain,
  postImportDatabase,
  postListConsent,
  postUnarchiveEmailList,
} from "../email-lists";
import { addSendingDomainHandler, deleteSendingDomainHandler, getSendingDomainHandler, verifySendingDomainHandler } from "../sending-domain";
import { BulkEmailError } from "@/services/comms/bulk-outbound/errors";

const LIST = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status: vi.fn((v: number) => { status = v; return res; }),
    json: vi.fn((v: unknown) => { body = v; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body: body as Record<string, any> }) };
}

const req = (over: Record<string, unknown>) =>
  ({ body: {}, params: {}, query: {}, headers: {}, auth: { tenant_id: "tenant-a", user_id: "user-a" }, ...over }) as unknown as Request;

describe("email-lists routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.role.mockResolvedValue(true);
    mocks.viewerRole = "owner";
    mocks.importVersion.mockResolvedValue({ list_id: LIST, version_id: VERSION, added: 2, invalid: 0, duplicates: 0, over_limit: 0, already_unsubscribed: 0 });
  });

  it("a signed-out caller gets nothing", async () => {
    mocks.auth.mockResolvedValue(null);
    const { res } = response();
    await getImportTables(req({}), res);
    await postImportDatabase(req({ body: { name: "x", table: "users", column: "email" } }), res);
    await postListConsent(req({ params: { id: LIST, vid: VERSION }, body: { confirmed: true } }), res);
    expect(mocks.tables).not.toHaveBeenCalled();
    expect(mocks.readColumn).not.toHaveBeenCalled();
    expect(mocks.consent).not.toHaveBeenCalled();
  });

  it("CSV import uses the session's tenant and user, whatever the form says", async () => {
    const handler = importCsvChain[importCsvChain.length - 1] as (r: Request, s: Response) => Promise<void>;
    const { res, result } = response();
    await handler(
      req({
        body: { name: "Newsletter", column: "email", tenant_id: OTHER_TENANT, user_id: "someone-else" },
        file: { buffer: Buffer.from("email\nada@example.com\nbo@example.com\n"), originalname: "people.csv" },
      }),
      res,
    );
    expect(result().status).toBe(200);
    expect(mocks.importVersion).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      userId: "user-a",
      listId: null,
      name: "Newsletter",
      sourceKind: "csv",
      sourceRef: { column: "email" },
      values: ["ada@example.com", "bo@example.com"],
      cap: 10_000,
      canSeeDatabaseAddresses: true,
    });
  });

  it.each([
    ["an unreadable role", "<unreadable>", 503, "role_check_failed"],
    ["no role", null, 403, "not_authorized"],
    ["a viewer", "viewer", 403, "not_authorized"],
  ])("CSV import with %s writes nothing", async (_label, role, status, code) => {
    mocks.viewerRole = role;
    const handler = importCsvChain[importCsvChain.length - 1] as (r: Request, s: Response) => Promise<void>;
    for (const body of [{ name: "Newsletter", column: "email" }, { list_id: LIST, column: "email" }]) {
      const { res, result } = response();
      await handler(req({ body, file: { buffer: Buffer.from("email\nada@example.com\n"), originalname: "people.csv" } }), res);
      expect(result().status).toBe(status);
      expect(result().body.error.code).toBe(code);
    }
    expect(mocks.importVersion).not.toHaveBeenCalled();
  });

  it("CSV import by a member reaches the import, with database addresses hidden", async () => {
    mocks.viewerRole = "member";
    const handler = importCsvChain[importCsvChain.length - 1] as (r: Request, s: Response) => Promise<void>;
    const { res, result } = response();
    await handler(req({ body: { list_id: LIST, column: "email" }, file: { buffer: Buffer.from("email\nada@example.com\n"), originalname: "people.csv" } }), res);
    expect(result().status).toBe(200);
    expect(mocks.importVersion).toHaveBeenCalledWith(expect.objectContaining({ listId: LIST, canSeeDatabaseAddresses: false }));
  });

  it("CSV import refuses a file that is not a .csv, and a file where the column must be chosen", async () => {
    const handler = importCsvChain[importCsvChain.length - 1] as (r: Request, s: Response) => Promise<void>;
    const a = response();
    await handler(req({ body: { name: "x" }, file: { buffer: Buffer.from("email\na@b.co\n"), originalname: "people.xlsx" } }), a.res);
    expect(a.result().body.error.code).toBe("csv_required");
    const b = response();
    await handler(req({ body: { name: "x" }, file: { buffer: Buffer.from("work,home\na@b.co,c@d.co\n"), originalname: "p.csv" } }), b.res);
    expect(b.result().body.error.message).toBe("Choose which column holds the email addresses.");
    expect(mocks.importVersion).not.toHaveBeenCalled();
  });

  it("database import reads only the caller's database and records where the copy came from, with no credentials", async () => {
    mocks.readColumn.mockResolvedValue({ db_type: "postgres", table: "Users", column: "Email", values: ["a@b.co"], truncated: true });
    const { res, result } = response();
    await postImportDatabase(req({ body: { name: "Customers", table: "users", column: "email", tenant_id: OTHER_TENANT } }), res);
    expect(mocks.readColumn).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a", table: "users", column: "email" });
    expect(mocks.importVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        sourceKind: "database",
        sourceRef: { db_type: "postgres", table: "Users", column: "Email" },
        cap: 5_000,
      }),
    );
    expect(result().body.notice).toBe("Imported the first 5,000 rows. For a larger list, upload a CSV.");
  });

  it("a table or column that is not allowed is a 400 and imports nothing", async () => {
    mocks.readColumn.mockRejectedValue(new BulkEmailError("database_table_not_found", "That table was not found in your connected database."));
    const { res, result } = response();
    await postImportDatabase(req({ body: { name: "x", table: "secrets", column: "email" } }), res);
    expect(result().status).toBe(400);
    expect(mocks.importVersion).not.toHaveBeenCalled();
  });

  it("consent needs the tick and is recorded for the session's tenant and member", async () => {
    const a = response();
    await postListConsent(req({ params: { id: LIST, vid: VERSION }, body: {} }), a.res);
    expect(a.result().status).toBe(400);
    expect(mocks.consent).not.toHaveBeenCalled();
    const b = response();
    await postListConsent(req({ params: { id: LIST, vid: VERSION }, body: { confirmed: true, tenant_id: OTHER_TENANT } }), b.res);
    expect(mocks.consent).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a", listId: LIST, versionId: VERSION });
  });

  it("another workspace's list reads as not found for consent, contacts, archive and erase", async () => {
    const notFound = new BulkEmailError("list_not_found", "That contact list was not found.", 404);
    mocks.consent.mockRejectedValue(notFound);
    mocks.contacts.mockRejectedValue(notFound);
    mocks.archive.mockRejectedValue(notFound);
    mocks.erase.mockRejectedValue(new BulkEmailError("contact_not_found", "That contact was not found.", 404));
    for (const call of [
      (r: Response) => postListConsent(req({ params: { id: LIST, vid: VERSION }, body: { confirmed: true } }), r),
      (r: Response) => getEmailListContacts(req({ params: { id: LIST } }), r),
      (r: Response) => deleteEmailList(req({ params: { id: LIST } }), r),
      (r: Response) => deleteEmailContact(req({ params: { id: LIST } }), r),
    ]) {
      const { res, result } = response();
      await call(res);
      expect(result().status).toBe(404);
    }
    expect(mocks.contacts).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a" }));
    expect(mocks.archive).toHaveBeenCalledWith("tenant-a", LIST);
    expect(mocks.erase).toHaveBeenCalledWith("tenant-a", LIST);
  });

  it("an unexpected error never echoes its message", async () => {
    mocks.readColumn.mockRejectedValue(new Error("row ada@example.com exploded"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { res, result } = response();
    await postImportDatabase(req({ body: { name: "x", table: "users", column: "email" } }), res);
    expect(result().status).toBe(500);
    expect(JSON.stringify(result().body)).not.toContain("example.com");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("example.com");
    spy.mockRestore();
  });
});

describe("the connected database is read by an owner or admin only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.role.mockImplementation(async (_auth: unknown, allowed: readonly string[], res: Response) => {
      expect(allowed).toEqual(["owner", "admin"]);
      res.status(403).json({ error: { code: "forbidden" } });
      return false;
    });
  });

  it("a member cannot list the tables, list a table's columns, or import a column", async () => {
    for (const call of [
      (r: Response) => getImportTables(req({}), r),
      (r: Response) => getImportTableColumns(req({ params: { table: "users" } }), r),
      (r: Response) => postImportDatabase(req({ body: { name: "x", table: "users", column: "email" } }), r),
    ]) {
      const { res, result } = response();
      await call(res);
      expect(result().status).toBe(403);
    }
    expect(mocks.tables).not.toHaveBeenCalled();
    expect(mocks.readColumn).not.toHaveBeenCalled();
    expect(mocks.importVersion).not.toHaveBeenCalled();
  });

  it("a member cannot archive a list or erase a contact, and nothing is archived or erased", async () => {
    for (const call of [
      (r: Response) => deleteEmailList(req({ params: { id: LIST } }), r),
      (r: Response) => deleteEmailContact(req({ params: { id: LIST } }), r),
    ]) {
      const { res, result } = response();
      await call(res);
      expect(result()).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    }
    expect(mocks.role).toHaveBeenCalledTimes(2);
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.erase).not.toHaveBeenCalled();
  });

  it("a failed role read archives and erases nothing", async () => {
    mocks.role.mockRejectedValue(new Error("tenant_users role read failed"));
    for (const call of [
      (r: Response) => deleteEmailList(req({ params: { id: LIST } }), r),
      (r: Response) => deleteEmailContact(req({ params: { id: LIST } }), r),
    ]) {
      const { res, result } = response();
      await call(res);
      expect(result().status).toBe(500);
    }
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.erase).not.toHaveBeenCalled();
  });

  it("unarchive uses the session's tenant and user, never the body's, and passes back what the store said", async () => {
    mocks.role.mockResolvedValue(true);
    mocks.unarchive.mockResolvedValue({ unarchived: true, stopped_sends: 2 });
    const { res, result } = response();
    await postUnarchiveEmailList(req({ params: { id: LIST }, body: { tenant_id: OTHER_TENANT, user_id: "other" } }), res);
    expect(result()).toMatchObject({ status: 200, body: { ok: true, unarchived: true, stopped_sends: 2 } });
    expect(mocks.unarchive).toHaveBeenCalledWith("tenant-a", LIST, "user-a");
  });

  it("a member, a failed role read and an overridden workspace unarchive nothing", async () => {
    mocks.role.mockImplementation(async (_auth: unknown, _roles: unknown, r: Response) => {
      r.status(403).json({ error: { code: "forbidden" } });
      return false;
    });
    const member = response();
    await postUnarchiveEmailList(req({ params: { id: LIST } }), member.res);
    expect(member.result()).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    mocks.role.mockRejectedValue(new Error("tenant_users role read failed"));
    const unreadable = response();
    await postUnarchiveEmailList(req({ params: { id: LIST } }), unreadable.res);
    expect(unreadable.result().status).toBe(500);
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a", tenant_overridden: true });
    const overridden = response();
    await postUnarchiveEmailList(req({ params: { id: LIST } }), overridden.res);
    expect(overridden.result()).toMatchObject({ status: 403, body: { error: { code: "tenant_override_forbidden" } } });
    expect(mocks.unarchive).not.toHaveBeenCalled();
  });

  it("the store's refusals reach the founder as their own status, and a bad id never reaches the store", async () => {
    mocks.role.mockResolvedValue(true);
    mocks.unarchive.mockRejectedValue(new BulkEmailError("name_taken", "Another list already uses this name.", 409));
    const taken = response();
    await postUnarchiveEmailList(req({ params: { id: LIST } }), taken.res);
    expect(taken.result()).toMatchObject({ status: 409, body: { error: { code: "name_taken" } } });
    mocks.unarchive.mockClear();
    const bad = response();
    await postUnarchiveEmailList(req({ params: { id: "nope" } }), bad.res);
    expect(bad.result().status).toBe(404);
    expect(mocks.unarchive).not.toHaveBeenCalled();
  });

  it("archived lists hide a database list's count from a member and when the role cannot be read, and show it to an owner", async () => {
    const rows = [
      { id: "a", name: "Users", archived_at: "2026-11-01T00:00:00Z", people: 40, from_database: true },
      { id: "b", name: "Csv", archived_at: "2026-11-01T00:00:00Z", people: 7, from_database: false },
    ];
    mocks.archived.mockResolvedValue(rows);
    const see = async (role: string | null) => {
      mocks.viewerRole = role;
      const { res, result } = response();
      await getArchivedEmailLists(req({}), res);
      return result().body as { lists: Array<Record<string, unknown>> };
    };
    for (const role of ["member", "<unreadable>"]) {
      const body = await see(role);
      expect(body.lists[0]).toMatchObject({ people: null, members_hidden: true });
      expect(body.lists[1]).toMatchObject({ people: 7, members_hidden: false });
      expect(JSON.stringify(body)).not.toContain("from_database");
      expect(JSON.stringify(body)).not.toContain("40");
    }
    expect((await see("owner")).lists[0]).toMatchObject({ people: 40, members_hidden: false });
    expect(mocks.archived).toHaveBeenCalledWith("tenant-a");
  });

  it("a member sees no one and no count on a database-sourced list; an owner sees them in full; a CSV list is open", async () => {
    const page = (source_kind: string) => ({
      total: 1, version_id: "v", source_kind,
      contacts: [{ id: "c1", email: "ada@example.com", status: "ok" }],
    });
    mocks.viewerRole = "member";
    mocks.contacts.mockResolvedValue(page("database"));
    const a = response();
    await getEmailListContacts(req({ params: { id: LIST } }), a.res);
    expect(a.result().body).toEqual({ total: null, contacts: [], version_id: "v", source_kind: "database", masked: true, members_hidden: true });

    mocks.viewerRole = "owner";
    const b = response();
    await getEmailListContacts(req({ params: { id: LIST } }), b.res);
    expect(b.result().body).toMatchObject({ masked: false, contacts: [{ email: "ada@example.com" }] });

    mocks.viewerRole = "member";
    mocks.contacts.mockResolvedValue(page("csv"));
    const c = response();
    await getEmailListContacts(req({ params: { id: LIST } }), c.res);
    expect(c.result().body).toMatchObject({ masked: false, contacts: [{ email: "ada@example.com" }] });
  });

  it("a session acting as another workspace cannot write", async () => {
    mocks.role.mockResolvedValue(true);
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "staff", tenant_overridden: true });
    for (const call of [
      (r: Response) => postListConsent(req({ params: { id: LIST, vid: VERSION }, body: { confirmed: true } }), r),
      (r: Response) => postImportDatabase(req({ body: { name: "x", table: "users", column: "email" } }), r),
      (r: Response) => deleteEmailList(req({ params: { id: LIST } }), r),
      (r: Response) => deleteEmailContact(req({ params: { id: LIST } }), r),
      (r: Response) => addSendingDomainHandler(req({ body: { domain: "acme.com" } }), r),
    ]) {
      const { res, result } = response();
      await call(res);
      expect(result()).toMatchObject({ status: 403, body: { error: { code: "tenant_override_forbidden" } } });
    }
    expect(mocks.consent).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.erase).not.toHaveBeenCalled();
    expect(mocks.addDomain).not.toHaveBeenCalled();
  });
});

describe("sending-domain routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
  });

  it("only an owner or admin can add or check the domain", async () => {
    mocks.role.mockImplementation(async (_auth: unknown, allowed: readonly string[], res: Response) => {
      expect(allowed).toEqual(["owner", "admin"]);
      res.status(403).json({ error: { code: "forbidden" } });
      return false;
    });
    const a = response();
    await addSendingDomainHandler(req({ body: { domain: "acme.com" } }), a.res);
    const b = response();
    await verifySendingDomainHandler(req({}), b.res);
    expect(a.result().status).toBe(403);
    expect(b.result().status).toBe(403);
    expect(mocks.addDomain).not.toHaveBeenCalled();
    expect(mocks.verifyDomain).not.toHaveBeenCalled();
  });

  it("the domain is added for the session's tenant; a taken domain reads plainly", async () => {
    mocks.role.mockResolvedValue(true);
    mocks.addDomain.mockRejectedValue(new BulkEmailError("domain_taken", "This domain is already connected to another workspace.", 409));
    const { res, result } = response();
    await addSendingDomainHandler(req({ body: { domain: "acme.com", tenant_id: OTHER_TENANT } }), res);
    expect(mocks.addDomain).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a", domain: "acme.com" });
    expect(result()).toEqual({ status: 409, body: { error: { code: "domain_taken", message: "This domain is already connected to another workspace." } } });
  });

  it("removing the domain is owner/admin, for the session's tenant", async () => {
    mocks.role.mockResolvedValue(true);
    mocks.removeDomain.mockResolvedValue({ released: true });
    const { res, result } = response();
    await deleteSendingDomainHandler(req({ body: { tenant_id: OTHER_TENANT } }), res);
    expect(mocks.removeDomain).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" });
    expect(result().body).toEqual({ released: true });

    mocks.role.mockImplementation(async (_a: unknown, _r: unknown, r2: Response) => {
      r2.status(403).json({ error: { code: "forbidden" } });
      return false;
    });
    mocks.removeDomain.mockClear();
    const m = response();
    await deleteSendingDomainHandler(req({}), m.res);
    expect(m.result().status).toBe(403);
    expect(mocks.removeDomain).not.toHaveBeenCalled();
  });

  it("an owner opening the page releases a domain left pending over 7 days; a member does not", async () => {
    mocks.getDomain.mockResolvedValue(null);
    mocks.removeDomain.mockResolvedValue({ released: false });
    mocks.viewerRole = "owner";
    await getSendingDomainHandler(req({}), response().res);
    expect(mocks.removeDomain).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a", onlyIfStale: true });
    mocks.removeDomain.mockClear();
    mocks.viewerRole = "member";
    const { res, result } = response();
    await getSendingDomainHandler(req({}), res);
    expect(mocks.removeDomain).not.toHaveBeenCalled();
    expect(result().body).toMatchObject({ can_manage: false });
  });
});
