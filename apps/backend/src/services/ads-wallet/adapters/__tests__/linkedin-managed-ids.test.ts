import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/http", async (original) => ({ ...(await original<typeof import("@/services/connectors/linkedin-ads/http")>()), linkedinAdsGet: m.get }));

import { linkedinManagedAccountIds } from "../linkedin-account";

beforeEach(() => m.get.mockReset());
const u = (id: string, role: string) => ({ account: `urn:li:sponsoredAccount:${id}`, role });

it("counts the campaign roles and leaves out viewers and creative managers", async () => {
  m.get.mockResolvedValue({ elements: [u("1", "ACCOUNT_BILLING_ADMIN"), u("2", "ACCOUNT_MANAGER"), u("3", "CAMPAIGN_MANAGER"), u("4", "VIEWER"), u("5", "CREATIVE_MANAGER")], paging: { total: 5 } });
  expect([...(await linkedinManagedAccountIds("t", false))!].sort()).toEqual(["1", "2", "3"]);
});

it("an empty answer with an honest total is an answer: the login manages nothing", async () => {
  m.get.mockResolvedValue({ elements: [], paging: { total: 0 } });
  expect(await linkedinManagedAccountIds("t", false)).toEqual(new Set());
});

it.each([
  ["a cut-short page", { elements: [u("1", "VIEWER")], paging: { total: 2 } }],
  ["no total at all", { elements: [] }],
])("%s proves nothing, so it answers null rather than 'view only'", async (_label, body) => {
  m.get.mockResolvedValue(body);
  expect(await linkedinManagedAccountIds("t", false)).toBeNull();
});

it("passes the freshness through, so a fresh recheck really goes to LinkedIn", async () => {
  m.get.mockResolvedValue({ elements: [], paging: { total: 0 } });
  await linkedinManagedAccountIds("t", true);
  expect(m.get.mock.calls[0][4]).toEqual({ fresh: true });
});
