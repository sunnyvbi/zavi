import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: async () => "tok",
  forceRefreshConnector: vi.fn(),
  markConnectorTokenRevoked: vi.fn(),
}));

import { resetLinkedInAdsReadCache } from "../http";
import { listLinkedInCampaignGroups, listLinkedInCampaignGroupsWithToken } from "../client";

const GROUP_STATUSES = new Set(["ACTIVE", "PAUSED", "ARCHIVED", "CANCELED", "DRAFT", "PENDING_DELETION", "REMOVED"]);
const groups = { elements: [{ id: 1242905183, name: "LinkedIn audience - 2026-11-04", status: "ACTIVE", runSchedule: { start: 1761740000000 }, changeAuditStamps: { lastModified: { time: 1762300000000 } } }], metadata: {} };

function linkedInLikeFetch(url: unknown) {
  const u = String(url);
  const values = /status:\(values:List\(([^)]*)\)\)/.exec(decodeURIComponent(u))?.[1]?.split(",") ?? [];
  const unknown = values.filter((v) => !GROUP_STATUSES.has(v));
  if (unknown.length) {
    return { ok: false, status: 400, headers: new Headers(), json: async () => ({ message: `Invalid value for status: ${unknown.join(",")}` }), text: async () => `Invalid value for status: ${unknown.join(",")}` };
  }
  return { ok: true, status: 200, headers: new Headers(), json: async () => groups };
}

beforeEach(() => {
  resetLinkedInAdsReadCache();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown) => linkedInLikeFetch(url));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("must catch: the default campaign-group search only uses statuses LinkedIn accepts for groups, so the dashboard gets its groups instead of a refused read", async () => {
  await expect(listLinkedInCampaignGroupsWithToken("tok", "559880687")).resolves.toEqual([
    { id: "1242905183", name: "LinkedIn audience - 2026-11-04", status: "ACTIVE", is_default: false, total_budget: null, run_start_at: new Date(1761740000000).toISOString(), run_end_at: null, last_modified_at: new Date(1762300000000).toISOString() },
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).not.toContain("COMPLETED");
});

it("drops a campaign-only status a caller passes through instead of letting LinkedIn refuse the whole read", async () => {
  await expect(listLinkedInCampaignGroups("t1", "559880687", 50, ["ACTIVE", "COMPLETED", "DRAFT"])).resolves.toHaveLength(1);
  const sent = decodeURIComponent(String(fetchMock.mock.calls[0][0]));
  expect(sent).toContain("status:(values:List(ACTIVE,DRAFT))");
});
