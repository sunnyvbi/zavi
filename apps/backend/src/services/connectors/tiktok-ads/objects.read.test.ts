import { beforeEach, expect, it, vi } from "vitest";
import type { OwnedComposioAccount } from "../composio/api";
const tt = vi.hoisted(() => vi.fn());
vi.mock("./composio-read", () => ({ tt }));
import { listTiktokAdGroups } from "./objects";
const account = {} as OwnedComposioAccount;
beforeEach(() => tt.mockReset());
it("retains the first page's count when a later page omits metadata", async () => {
  tt.mockResolvedValueOnce({ list: [{ adgroup_id: "1", campaign_id: "10" }], page_info: { total_page: 3 } })
    .mockResolvedValueOnce({ list: [{ adgroup_id: "2", campaign_id: "10" }] })
    .mockResolvedValueOnce({ list: [{ adgroup_id: "3", campaign_id: "10" }] });
  expect((await listTiktokAdGroups(account, "111")).map(g => g.id)).toEqual(["1", "2", "3"]);
});
it.each([{ list: [null] }, { list: [{ adgroup_id: "1" }] }, { list: [], page_info: { total_page: "3" } }, { list: [], page_info: { total_page: 21 } }])("refuses an incomplete child read: %j", async (data) => {
  tt.mockResolvedValue(data);
  await expect(listTiktokAdGroups(account, "111")).rejects.toThrow();
});
