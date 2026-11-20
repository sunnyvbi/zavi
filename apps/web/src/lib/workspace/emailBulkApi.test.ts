import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { archiveContactList, confirmListConsent, importCsv, importDatabase, unarchiveContactList } from "./emailBulkApi";
import { forgetEmailTestLists, getEmailTestLists } from "./emailCampaignSettingsApi";

const LISTS = "/api/workspace/email-test-lists";
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
let failWrites = false;

beforeEach(() => {
  forgetEmailTestLists();
  failWrites = false;
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path === LISTS) return json({ routes: [], orphans: [] });
    if (failWrites) return json({ error: { code: "boom", message: "No." } }, 500);
    return json({ added: 1, duplicates: 0, invalid: 0, ok: true, active_version_id: "v2" });
  });
});

const listReads = () => apiFetch.mock.calls.filter(([p]) => p === LISTS).length;

const writes: Array<[string, () => Promise<unknown>]> = [
  ["importCsv", () => importCsv({ file: new File(["email\na@b.co"], "a.csv", { type: "text/csv" }), column: "email", name: "New" })],
  ["importDatabase", () => importDatabase({ table: "users", column: "email", name: "Users" })],
  ["archiveContactList", () => archiveContactList("list-1")],
  ["unarchiveContactList", () => unarchiveContactList("list-1")],
  ["confirmListConsent", () => confirmListConsent("list-1", "v2")],
];

describe("a contact-list change drops the cached test lists", () => {
  it.each(writes)("after %s resolves, the next read asks the server again", async (_name, write) => {
    await getEmailTestLists();
    await getEmailTestLists();
    expect(listReads()).toBe(1);
    await write();
    await getEmailTestLists();
    expect(listReads()).toBe(2);
  });

  it.each(writes)("after %s fails, the next read asks the server again too", async (_name, write) => {
    await getEmailTestLists();
    failWrites = true;
    await expect(write()).rejects.toThrow("No.");
    await getEmailTestLists();
    expect(listReads()).toBe(2);
  });

  it("a read still in flight when the import lands is not served afterwards", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    apiFetch.mockImplementation(async (path: string) => {
      if (path === LISTS) {
        if (apiFetch.mock.calls.filter(([p]) => p === LISTS).length === 1) await held;
        return new Response(JSON.stringify({ routes: [], orphans: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ added: 1, duplicates: 0, invalid: 0 }), { status: 200 });
    });
    const stale = getEmailTestLists();
    await importCsv({ file: new File(["email\na@b.co"], "a.csv"), column: "email", name: "New" });
    const next = getEmailTestLists();
    expect(next).not.toBe(stale);
    release();
    await Promise.all([stale, next]);
    expect(listReads()).toBe(2);
  });
});
