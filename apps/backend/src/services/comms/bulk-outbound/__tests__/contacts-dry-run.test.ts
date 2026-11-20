import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn((_table: string) => {
    const q = { select: () => q, eq: () => q, order: () => q, range: async () => ({ data: [], error: null }) };
    return q;
  }),
  auth: vi.fn(),
  existing: new Set<string>(),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => mocks.rpc(...a),
  tenantClient: () => ({ from: (table: string) => mocks.from(table) }),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true, loadTenantRole: async () => "owner" }));

import { getEmailContacts, importCsvChain, previewCsvChain } from "@/routes/workspace/email-lists";
import { cleanAddresses, cleanContactName, csvContactNames } from "../contacts-csv";
import { importListVersion } from "../lists";

type Handler = (r: Request, s: Response) => Promise<void>;
const preview = previewCsvChain[previewCsvChain.length - 1] as Handler;
const importCsv = importCsvChain[importCsvChain.length - 1] as Handler;

function response() {
  let status = 200;
  let body: any;
  const headers: Record<string, string> = {};
  const res = {
    status: vi.fn((v: number) => { status = v; return res; }),
    json: vi.fn((v: unknown) => { body = v; return res; }),
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
  } as unknown as Response;
  return { res, out: () => ({ status, body, headers }) };
}

const upload = (csv: string, body: Record<string, unknown> = {}, query: Record<string, unknown> = {}) =>
  ({
    body,
    query,
    params: {},
    headers: {},
    auth: { tenant_id: "tenant-a", user_id: "user-a" },
    file: { buffer: Buffer.from(csv, "utf8"), originalname: "people.csv" },
  }) as unknown as Request;

const CSV = [
  "Email,First name,Last name,Notes",
  "ada@example.com,Ada,Lovelace,vip",
  "BO@example.com,Bo,,",
  "not-an-email,Bad,Row,",
  "ada@example.com,Ada,Again,",
  "cy@example.com,,Twombly,",
  "dee@example.com,\"Dee\r\nBcc: x@y.com\",Hidden,",
  "",
].join("\n");

describe("POST /email-lists/preview-csv dry run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existing = new Set(["bo@example.com", "zz@example.com"]);
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.rpc.mockImplementation(async (_t: string, name: string, args: { p_emails: string[] }) => {
      if (name !== "email_contacts_existing_count") return { data: null, error: { message: "unexpected write" } };
      return { data: args.p_emails.filter((e) => mocks.existing.has(e)).length, error: null };
    });
  });

  it("without a column it answers the plain preview and reads no contacts", async () => {
    const { res, out } = response();
    await preview(upload(CSV), res);
    expect(out().status).toBe(200);
    expect(out().body.counts).toBeUndefined();
    expect(out().body.preview_rows).toHaveLength(4);
    expect(out().body.preview_rows[0]).toEqual(["ada@example.com", "Ada", "Lovelace", "vip"]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("with a column it counts new, already in contacts, repeats and bad addresses for the session's tenant", async () => {
    const { res, out } = response();
    await preview(upload(CSV, { column: "email", first_column: "First name", last_column: "Last name", tenant_id: "tenant-b" }), res);
    expect(out().status).toBe(200);
    expect(out().body.counts).toEqual({ new: 3, already_in_contacts: 1, skipped_erased: 0, duplicate_in_file: 1, bad: 1, over_limit: 0 });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("tenant-a", "email_contacts_existing_count", {
      p_user_id: "user-a",
      p_emails: ["ada@example.com", "bo@example.com", "cy@example.com", "dee@example.com"],
    });
  });

  it("writes nothing: no import RPC, no table write, no list", async () => {
    const { res } = response();
    await preview(upload(CSV, { column: "Email" }), res);
    expect(mocks.rpc.mock.calls.map((c) => c[1])).toEqual(["email_contacts_existing_count"]);
    expect(mocks.from.mock.calls.map((c) => c[0])).toEqual(["email_suppression"]);
  });

  it("over the 10,000 cap: the extra addresses are counted as over the limit, never as new", async () => {
    const rows = Array.from({ length: 10_003 }, (_, i) => `p${i}@example.com`);
    mocks.existing = new Set(["p0@example.com", "p10001@example.com"]);
    const { res, out } = response();
    await preview(upload(["email", ...rows, "p1@example.com", "junk"].join("\n"), { column: "email" }), res);
    expect(out().body.counts).toEqual({ new: 9_999, already_in_contacts: 1, skipped_erased: 0, duplicate_in_file: 1, bad: 1, over_limit: 3 });
    expect((mocks.rpc.mock.calls[0][2] as { p_emails: string[] }).p_emails).toHaveLength(10_000);
  });

  it("a column that is not in the file, or a name column that is not, is refused before any read", async () => {
    for (const body of [{ column: "nope" }, { column: "email", first_column: "nope" }]) {
      const { res, out } = response();
      await preview(upload(CSV, body), res);
      expect(out().status).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a repeat inside the file is counted as a duplicate after the import's own normalisation, not dropped", async () => {
    mocks.existing = new Set();
    const csv = [
      "email",
      "ada.qa@yopmail.com",
      "bo.qa@yopmail.com",
      "ADA.QA@yopmail.com",
      "not-an-email",
      "  <Ada.Qa@YopMail.com>",
      "mailto:BO.QA@yopmail.com",
    ].join("\n");
    const { res, out } = response();
    await preview(upload(csv, { column: "email" }), res);
    expect(out().status).toBe(200);
    expect(out().body.counts).toEqual({ new: 2, already_in_contacts: 0, skipped_erased: 0, duplicate_in_file: 3, bad: 1, over_limit: 0 });
    expect(mocks.rpc.mock.calls[0][2].p_emails).toEqual(["ada.qa@yopmail.com", "bo.qa@yopmail.com"]);
  });

  it("a full name column is accepted for the dry run, and a full name column with a first or last column is refused before any read", async () => {
    const csv = "Email,Name,First name\nada@example.com,Ada Lovelace,Ada\n";
    const ok = response();
    await preview(upload(csv, { column: "Email", full_column: "name" }), ok.res);
    expect(ok.out().status).toBe(200);
    expect(ok.out().body.counts.new).toBe(1);
    mocks.rpc.mockClear();
    for (const body of [
      { column: "Email", full_column: "Name", first_column: "First name" },
      { column: "Email", full_column: "Name", last_column: "First name" },
    ]) {
      const { res, out } = response();
      await preview(upload(csv, body), res);
      expect(out().status).toBe(400);
      expect(out().body.error.code).toBe("csv_name_columns_conflict");
    }
    const missing = response();
    await preview(upload(csv, { column: "Email", full_column: "Full name" }), missing.res);
    expect(missing.out().status).toBe(400);
    expect(missing.out().body.error.code).toBe("csv_name_column_not_found");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a database error never shows its message", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'relation "ada@example.com"' } });
    const { res, out } = response();
    await preview(upload(CSV, { column: "email" }), res);
    expect(out().status).toBe(500);
    expect(JSON.stringify(out().body)).not.toContain("example.com");
  });
});

describe("POST /email-lists/import-csv with name columns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.rpc.mockResolvedValue({ data: { ok: true, list_id: "L", version_id: "V", contact_count: 4, already_blocked: 0 }, error: null });
  });

  it("sends a cleaned first + last name lined up with each address, the first non-empty one for a repeat", async () => {
    const { res, out } = response();
    await importCsv(upload(CSV, { column: "email", name: "Waitlist", first_column: "first name", last_column: "Last name" }), res);
    expect(out().status).toBe(200);
    const args = mocks.rpc.mock.calls[0][2];
    expect(mocks.rpc.mock.calls[0][1]).toBe("email_list_import_version");
    expect(args.p_emails).toEqual(["ada@example.com", "bo@example.com", "cy@example.com", "dee@example.com"]);
    expect(args.p_names).toEqual(["Ada Lovelace", "Bo", "Twombly", "Dee Bcc: x@y.com Hidden"]);
  });

  it("a full name column is split into first word and the rest, lined up with each address, the same for any API caller", async () => {
    const csv = [
      "Email,Name",
      "ada@example.com,\"  Ada   Augusta\tLovelace \"",
      "bo@example.com,Bo",
      "cy@example.com,",
      "ADA@example.com,Someone Else",
      "",
    ].join("\n");
    const { res, out } = response();
    await importCsv(upload(csv, { column: "Email", name: "Waitlist", full_column: "name" }), res);
    expect(out().status).toBe(200);
    const args = mocks.rpc.mock.calls[0][2];
    expect(args.p_emails).toEqual(["ada@example.com", "bo@example.com", "cy@example.com"]);
    expect(args.p_names).toEqual(["Ada Augusta Lovelace", "Bo", null]);
  });

  it("a full name column with a first name column imports nothing", async () => {
    const { res, out } = response();
    await importCsv(upload("Email,Name,First\nada@example.com,Ada Lovelace,Ada\n", { column: "Email", name: "W", full_column: "Name", first_column: "First" }), res);
    expect(out().status).toBe(400);
    expect(out().body.error.code).toBe("csv_name_columns_conflict");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("without name columns no names are sent", async () => {
    const { res } = response();
    await importCsv(upload(CSV, { column: "email", name: "Waitlist" }), res);
    expect(mocks.rpc.mock.calls[0][2]).not.toHaveProperty("p_names");
  });
});

describe("names", () => {
  it("cleanContactName strips control characters, collapses spaces and caps at 200", () => {
    expect(cleanContactName("  Ada\t", "\u2028Lovelace ")).toBe("Ada Lovelace");
    expect(cleanContactName("", "  ")).toBeNull();
    expect(cleanContactName("x".repeat(300))).toHaveLength(200);
  });

  it("a full name column keeps every word in order, with spacing, control characters and the cap cleaned the same as first and last", () => {
    const rows = [
      "  Ada   Augusta Lovelace ",
      "Cher",
      "",
      "   ",
      "Ada\u2028Lovelace",
      "Ada\u0085Lovelace",
      "Ada\u0000Lovelace",
      "Ada\u00a0\ufeffLovelace",
      "Mary\tJane  Watson-Parker",
      `${"x".repeat(150)} ${"y".repeat(100)}`,
    ];
    const csv = `email,Full Name\n${rows.map((n, i) => `a${i}@b.co,"${n}"`).join("\n")}\n`;
    expect(csvContactNames(Buffer.from(csv), null, null, "full name")).toEqual([
      "Ada Augusta Lovelace",
      "Cher",
      null,
      null,
      "Ada Lovelace",
      "Ada Lovelace",
      "Ada Lovelace",
      "Ada Lovelace",
      "Mary Jane Watson-Parker",
      `${"x".repeat(150)} ${"y".repeat(49)}`,
    ]);
  });

  it("csvContactNames with the same column twice does not double the name", () => {
    expect(csvContactNames(Buffer.from("email,name\na@b.co,Ada\n"), "name", "name")).toEqual(["Ada"]);
  });

  it("a repeat whose first row had no name takes the later name; one over the cap carries none", () => {
    const c = cleanAddresses(["a@b.co", "A@b.co", "c@d.co"], 1, [null, "Later", "Over"]);
    expect(c).toEqual({ emails: ["a@b.co"], names: ["Later"], invalid: 0, duplicates: 1, over_limit: 1 });
  });

  it("importListVersion leaves names out when every name is empty", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, list_id: "L", version_id: "V", contact_count: 1, already_blocked: 0 }, error: null });
    await importListVersion({ tenantId: "t", userId: "u", name: "x", sourceKind: "csv", values: ["a@b.co"], names: ["  "], cap: 10 });
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).not.toHaveProperty("p_names");
  });
});

describe("GET /email-contacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.rpc.mockResolvedValue({
      data: { ok: true, total: 1, rows: [{ id: "c1", email: "a•••@example.com", masked: true }], counts: { contacts: 9, lists: 2, unsubscribed: 1, bounced: 3 }, masked: true },
      error: null,
    });
  });

  it("asks for the session's tenant and user with clamped paging and returns rows and counts", async () => {
    const { res, out } = response();
    await getEmailContacts(upload("", {}, { search: "  ada ", limit: "9999", offset: "-4", tenant_id: "tenant-b", list_id: "11111111-1111-4111-8111-111111111111" }), res);
    expect(mocks.rpc).toHaveBeenCalledWith("tenant-a", "email_contacts_people", {
      p_user_id: "user-a",
      p_search: "ada",
      p_list_id: "11111111-1111-4111-8111-111111111111",
      p_limit: 200,
      p_offset: 0,
    });
    expect(out().body).toEqual({ rows: [{ id: "c1", email: "a•••@example.com", masked: true }], total: 1, counts: { contacts: 9, lists: 2, unsubscribed: 1, bounced: 3 }, masked: true });
    expect(out().headers["Cache-Control"]).toBe("no-store");
  });

  it("a list id that is not a uuid is not found, and a non-member is refused", async () => {
    const a = response();
    await getEmailContacts(upload("", {}, { list_id: "x' or 1=1" }), a.res);
    expect(a.out().status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: { ok: false, code: "not_authorized" }, error: null });
    const b = response();
    await getEmailContacts(upload("", {}, {}), b.res);
    expect(b.out().status).toBe(403);
  });

  it("a page with no counts passes null through instead of zeros", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, total: 3, rows: [], counts: null, masked: false }, error: null });
    const { res, out } = response();
    await getEmailContacts(upload("", {}, { search: "ada" }), res);
    expect(out().body).toEqual({ rows: [], total: 3, counts: null, masked: false });
  });

  it("a signed-out caller gets nothing", async () => {
    mocks.auth.mockResolvedValue(null);
    const { res } = response();
    await getEmailContacts(upload("", {}, {}), res);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
