import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ raw: vi.fn() }));
vi.mock("../client", () => ({
  linkedinAdsToken: async () => "tok",
  withLinkedInAdsToken: async (_t: string, call: (token: string) => Promise<unknown>) => call("tok"),
  listLinkedInAdAccountsRaw: m.raw,
}));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (v: string) => v, tenantClient: vi.fn() }));

import { ACCOUNT_LIST_REFRESH_MS, ACCOUNT_LIST_TTL_MS, EMPTY_ACCOUNT_LIST_REFRESH_MS, EMPTY_ACCOUNT_LIST_TTL_MS, linkedinAccountList, linkedinAccountOpen, linkedinChoicesForLogin, linkedinOpenAccountList } from "../account-list-cache";
import { resetLinkedInAdsReadCache } from "../read-cache";

const ACTIVE = { id: "11", name: "Acme", currency: "USD", status: "ACTIVE" };
const CLOSED = { id: "12", name: "Old", currency: "USD", status: "CANCELED" };

beforeEach(() => {
  resetLinkedInAdsReadCache();
  m.raw.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

it.each([["empty", []], ["only closed accounts", [CLOSED]]])("a(n) %s list is not kept for a day: the account made an hour later is seen on the next open", async (_label, first) => {
  m.raw.mockResolvedValueOnce(first).mockResolvedValueOnce([ACTIVE]);
  await linkedinAccountList("t");
  vi.advanceTimersByTime(60 * 60_000);
  expect((await linkedinAccountList("t")).accounts).toEqual([ACTIVE]);
  expect(m.raw).toHaveBeenCalledTimes(2);
});

it("the same list with an account in it is still kept for the full day", async () => {
  m.raw.mockResolvedValue([ACTIVE]);
  await linkedinAccountList("t");
  vi.advanceTimersByTime(ACCOUNT_LIST_TTL_MS - 1);
  await linkedinAccountList("t");
  expect(m.raw).toHaveBeenCalledTimes(1);
});

it("the empty answer is still cached briefly, so tab focus cannot hammer LinkedIn", async () => {
  m.raw.mockResolvedValue([]);
  await linkedinAccountList("t");
  vi.advanceTimersByTime(EMPTY_ACCOUNT_LIST_TTL_MS - 1);
  await linkedinAccountList("t");
  expect(m.raw).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  await linkedinAccountList("t");
  expect(m.raw).toHaveBeenCalledTimes(2);
});

it("Refresh after making an account answers within seconds, not after the five minute floor", async () => {
  m.raw.mockResolvedValueOnce([]).mockResolvedValueOnce([ACTIVE]);
  await linkedinAccountList("t");
  vi.advanceTimersByTime(EMPTY_ACCOUNT_LIST_REFRESH_MS);
  const refreshed = await linkedinAccountList("t", true);
  expect(refreshed.accounts).toEqual([ACTIVE]);
  expect(refreshed.just_refreshed).toBe(true);
  expect(EMPTY_ACCOUNT_LIST_REFRESH_MS).toBeLessThan(ACCOUNT_LIST_REFRESH_MS);
});

it("two fast Refresh presses on an empty list ask LinkedIn once", async () => {
  m.raw.mockResolvedValue([]);
  await linkedinAccountList("t");
  await linkedinAccountList("t", true);
  expect(m.raw).toHaveBeenCalledTimes(1);
});

it.each(["CANCELED", "PENDING_DELETION", "REMOVED"])("%s accounts are not offered to choose", async (status) => {
  m.raw.mockResolvedValue([ACTIVE, { ...ACTIVE, id: "12", status }]);
  expect((await linkedinOpenAccountList("t")).accounts.map((a) => a.id)).toEqual(["11"]);
});

it("an account with no status is offered, since only a closed status proves it is closed", () => {
  expect(linkedinAccountOpen(null)).toBe(true);
  expect(linkedinAccountOpen("DRAFT")).toBe(true);
});

const own = { id: "b1", provider_account_id: "12", funding_source: "provider" as const };

it("a saved account LinkedIn closed is reported as closed, separately from one the login cannot see", async () => {
  m.raw.mockResolvedValue([ACTIVE, CLOSED]);
  const out = await linkedinChoicesForLogin("t", { accounts: [own], selected_id: "b1" });
  expect(out).toMatchObject({ selected_id: null, unseen_selected_id: "b1", unseen_selected_closed: true });
  expect(out.accounts[0]).toMatchObject({ not_on_login: true });
});

it("a saved account that has gone from the login is not called closed", async () => {
  m.raw.mockResolvedValue([ACTIVE]);
  const out = await linkedinChoicesForLogin("t", { accounts: [own], selected_id: "b1" });
  expect(out).toMatchObject({ unseen_selected_id: "b1", unseen_selected_closed: false });
});
