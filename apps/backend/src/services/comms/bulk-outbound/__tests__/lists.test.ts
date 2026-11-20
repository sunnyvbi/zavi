import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => mocks.rpc(...a),
  tenantClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, order: () => q, range: async () => ({ data: [], error: null }) };
      return q;
    },
  }),
}));

import { CONSENT_SENTENCE } from "../config";
import { BulkEmailError } from "../errors";
import { archivedLists, archivedListsFor, importListVersion, listSummaries, recordListConsent, unarchiveList } from "../lists";

describe("importListVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ data: { ok: true, list_id: "L1", version_id: "V1", contact_count: 2, already_blocked: 1 }, error: null });
  });

  it("sends cleaned addresses to the RPC under the caller's tenant and reports the counts", async () => {
    const out = await importListVersion({
      tenantId: "tenant-a",
      userId: "user-a",
      name: "Newsletter",
      sourceKind: "csv",
      values: ["Ada@Example.com", "ada@example.com", "nope", "bo@example.com"],
      cap: 10_000,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("tenant-a", "email_list_import_version", {
      p_list_id: null,
      p_list_name: "Newsletter",
      p_source_kind: "csv",
      p_source_ref: {},
      p_emails: ["ada@example.com", "bo@example.com"],
      p_created_by: "user-a",
    });
    expect(out).toEqual({ list_id: "L1", version_id: "V1", added: 2, invalid: 1, duplicates: 1, over_limit: 0, already_unsubscribed: 1, skipped_erased: 0 });
  });

  it("refuses before any write when nothing in the column is an address", async () => {
    await expect(
      importListVersion({ tenantId: "t", userId: "u", name: "x", sourceKind: "csv", values: ["a", "b"], cap: 10 }),
    ).rejects.toMatchObject({ code: "no_addresses" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a name already in use reads as a sentence, with the right status", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: "name_taken" }, error: null });
    await expect(
      importListVersion({ tenantId: "t", userId: "u", name: "x", sourceKind: "csv", values: ["a@b.co"], cap: 10 }),
    ).rejects.toMatchObject({ code: "name_taken", status: 409, message: "You already have a list with that name. Pick another name." });
  });

  it("two lists given the same name at the same moment: the loser is told the name is taken, not a server error", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "23505", message: 'duplicate key value violates unique constraint "email_lists_tenant_name_uq"' },
    });
    await expect(
      importListVersion({ tenantId: "t", userId: "u", name: "Newsletter", sourceKind: "csv", values: ["a@b.co"], cap: 10 }),
    ).rejects.toMatchObject({ code: "name_taken", status: 409, message: "You already have a list with that name. Pick another name." });
  });

  it("a different unique clash is still a plain store error", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "email_contacts_pkey"' } });
    await expect(
      importListVersion({ tenantId: "t", userId: "u", name: "Newsletter", sourceKind: "csv", values: ["a@b.co"], cap: 10 }),
    ).rejects.toMatchObject({ code: "bulk_store_error", status: 500 });
  });

  it("a database error never carries the database's own message", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'duplicate key value "ada@example.com"' } });
    const err = await importListVersion({ tenantId: "t", userId: "u", name: "x", sourceKind: "csv", values: ["a@b.co"], cap: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(BulkEmailError);
    expect(err.message).not.toContain("example.com");
  });
});

describe("recordListConsent", () => {
  it("records the exact sentence with the member who ticked it", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, active_version_id: "V1" }, error: null });
    await recordListConsent({ tenantId: "tenant-a", userId: "user-a", listId: "L1", versionId: "V1" });
    expect(mocks.rpc).toHaveBeenCalledWith("tenant-a", "email_list_record_consent", {
      p_list_id: "L1",
      p_version_id: "V1",
      p_user_id: "user-a",
      p_consent_text: "These people agreed to hear from me.",
    });
    expect(CONSENT_SENTENCE).toBe("These people agreed to hear from me.");
  });

  it("a second tick and a replaced import are refused plainly", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: "already_recorded" }, error: null });
    await expect(recordListConsent({ tenantId: "t", userId: "u", listId: "L", versionId: "V" })).rejects.toMatchObject({ status: 409 });
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: "superseded" }, error: null });
    await expect(recordListConsent({ tenantId: "t", userId: "u", listId: "L", versionId: "V" })).rejects.toMatchObject({
      message: "A newer import replaced this one. Confirm consent for the newest import.",
    });
  });
});

describe("unarchiveList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the list and the acting user under the caller's tenant", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, unarchived: true, stopped_sends: 3 }, error: null });
    await expect(unarchiveList("tenant-a", "L1", "user-a")).resolves.toEqual({ unarchived: true, stopped_sends: 3 });
    expect(mocks.rpc).toHaveBeenCalledWith("tenant-a", "email_list_unarchive", { p_list_id: "L1", p_user_id: "user-a" });
  });

  it("an already active list is a clean no-op, not an error", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, unarchived: false, stopped_sends: 0 }, error: null });
    await expect(unarchiveList("t", "L1", "u")).resolves.toEqual({ unarchived: false, stopped_sends: 0 });
  });

  it.each([
    ["not_authorized", 403],
    ["list_not_found", 404],
    ["name_taken", 409],
  ])("the store's %s reads as a %i", async (reason, status) => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason }, error: null });
    await expect(unarchiveList("t", "L1", "u")).rejects.toMatchObject({ code: reason, status });
  });

  it("the name refusal tells the founder what to do", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: "name_taken" }, error: null });
    await expect(unarchiveList("t", "L1", "u")).rejects.toThrow("Archive that list first");
  });

  it("a unique-name race the RPC did not catch still reads as the name refusal, never a crash", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate key violates email_lists_tenant_name_uq" } });
    await expect(unarchiveList("t", "L1", "u")).rejects.toMatchObject({ code: "name_taken", status: 409 });
  });

  it("any other store failure is a plain 500 that carries no database text", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "row ada@example.com exploded" } });
    const e = await unarchiveList("t", "L1", "u").catch((x: BulkEmailError) => x);
    expect(e).toBeInstanceOf(BulkEmailError);
    expect((e as BulkEmailError).status).toBe(500);
    expect((e as BulkEmailError).message).not.toContain("ada@");
  });
});

describe("archivedLists", () => {
  it("reads under the caller's tenant, and withholds only a database list's count from a viewer who may not see it", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        { id: "a", name: "Users", archived_at: "2026-11-01T00:00:00Z", people: 40, from_database: true },
        { id: "b", name: "Csv", archived_at: "2026-11-01T00:00:00Z", people: "7", from_database: false },
      ],
      error: null,
    });
    const rows = await archivedLists("tenant-a");
    expect(mocks.rpc).toHaveBeenCalledWith("tenant-a", "email_list_archived_summaries", {});
    expect(archivedListsFor(rows, false).map((l) => [l.id, l.people, l.members_hidden])).toEqual([["a", null, true], ["b", 7, false]]);
    expect(archivedListsFor(rows, true).map((l) => [l.id, l.people, l.members_hidden])).toEqual([["a", 40, false], ["b", 7, false]]);
  });
});

describe("listSummaries", () => {
  it("derives sendable from the do-not-email count and flags an import that still needs the tick", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          id: "L1",
          name: "Newsletter",
          created_at: "2026-10-07T00:00:00Z",
          active_version_id: "V1",
          latest: { id: "V2", source_kind: "csv", contact_count: 12, created_at: "2026-10-08T00:00:00Z", consented: false },
          active: { id: "V1", contact_count: 10, blocked: 3 },
        },
      ],
      error: null,
    });
    const [l] = await listSummaries("tenant-a");
    expect(l.active).toEqual({ id: "V1", source_kind: "csv", contact_count: 10, sendable: 7, unsubscribed_or_bounced: 3 });
    expect(l.needs_consent).toBe(true);
  });
});

import { cleanListName } from "../lists";

describe("cleanListName", () => {
  it("turns line breaks and control characters into spaces and caps the length", () => {
    expect(cleanListName("News\nApprove: yes\r\u0007letter")).toBe("News Approve: yes letter");
    expect(cleanListName("a b")).toBe("a b");
    expect(cleanListName("x".repeat(200))).toHaveLength(120);
    expect(cleanListName("  \n ")).toBeNull();
  });

  it("an import stores the cleaned name", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, list_id: "L1", version_id: "V1", contact_count: 1 }, error: null });
    await importListVersion({ tenantId: "t", userId: "u", name: "Line one\nLine two", sourceKind: "csv", values: ["a@b.co"], cap: 10 });
    expect(mocks.rpc.mock.calls.at(-1)![2]).toMatchObject({ p_list_name: "Line one Line two" });
  });
});
