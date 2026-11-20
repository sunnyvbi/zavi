import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ result: { data: [] as unknown[], error: null as unknown }, from: vi.fn(), eq: vi.fn(), limit: vi.fn(), get: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantClient: (tenant: string) => ({ from: (table: string) => {
  m.from(tenant, table);
  const q = { select: () => q, eq: (...args: unknown[]) => { m.eq(...args); return q; }, order: () => q, limit: (n: number) => { m.limit(n); return Promise.resolve(m.result); } };
  return q;
} }) }));
vi.mock("../http", () => ({ chatgptAdsGet: m.get }));
import { readRecentChatgptCreations } from "../recent-creations";
const receipt = (id: unknown = "cmpn_old1") => ({ id: "action1", title: "Renters", exec_class: "chatgpt_ads.create_and_launch", exec_result: { created: { platform: "chatgpt", object_type: "campaign", id, status: "ACTIVE" } } });
const campaign = { id: "cmpn_old1", name: "zv-acme--Renters", status: "archived", updated_at: 1792524483, start_time: 1792524556, end_time: 1792610956 };
const read = (inventory: typeof campaign[] = []) => readRecentChatgptCreations("t1", "platform-key", "zv-acme--", inventory);
beforeEach(() => { vi.clearAllMocks(); m.result = { data: [receipt()], error: null }; m.get.mockResolvedValue(campaign); });
it("reads a recorded campaign by exact ID and reports archived separately from the historical ACTIVE receipt", async () => {
  const result = await read();
  expect(m.from).toHaveBeenCalledWith("t1", "channel_actions");
  expect(m.eq.mock.calls).toEqual([["channel_slug", "chatgpt_ads"], ["exec_class", "chatgpt_ads.create_and_launch"], ["exec_status", "executed"]]);
  expect(m.limit).toHaveBeenCalledWith(21);
  expect(m.get).toHaveBeenCalledWith("platform-key", "/campaigns/cmpn_old1");
  expect(result.campaigns[0]).toMatchObject({ recorded_creation: true, current_state: "verified", current_status: "archived", campaign_name: "Renters", last_updated_at: campaign.updated_at });
  expect(result.campaigns[0]).not.toHaveProperty("archived_at");
});
it("reuses inventory without an additional provider read", async () => {
  expect((await read([campaign])).campaigns[0].current_status).toBe("archived");
  expect(m.get).not.toHaveBeenCalled();
});
it("never reads a bound-account UUID from the platform account", async () => {
  m.result.data = [receipt("11111111-1111-4111-8111-111111111111")];
  expect((await read()).campaigns[0]).toMatchObject({ recorded_creation: true, current_state: "unverified", reason: "account_binding_required" });
  expect(m.get).not.toHaveBeenCalled();
});
it.each([{ ...campaign, id: "cmpn_other" }, { ...campaign, name: "zv-acme-labs--Private" }, { ...campaign, name: "zv-acme--ambiguous--Private" }, { ...campaign, status: "unknown" }])("does not expose unmatched or unreadable provider objects: %j", async value => {
  m.get.mockResolvedValue(value);
  const result = await read();
  expect(result.campaigns[0]).toMatchObject({ recorded_creation: true, current_state: "unverified", current_status: null, reason: "lookup_unavailable" });
  expect(result.campaigns[0]).not.toHaveProperty("campaign_name");
  expect(JSON.stringify(result)).not.toContain("Private");
});
it("read failure keeps recorded creation without claiming missing or current ACTIVE", async () => {
  m.get.mockRejectedValue(new Error("secret error details"));
  const result = await read();
  expect(result.campaigns[0]).toMatchObject({ recorded_creation: true, current_status: null, reason: "lookup_unavailable" });
  expect(JSON.stringify(result)).not.toContain("secret error details");
});
it("bounds receipts and missing-object reads and deduplicates repeated references", async () => {
  m.result.data = Array.from({ length: 21 }, (_, i) => ({ ...receipt(`cmpn_old${Math.floor(i / 2)}`), id: `a${i}` }));
  m.get.mockImplementation(async (_key, path: string) => ({ ...campaign, id: path.split("/").at(-1) }));
  const result = await read();
  expect(result.campaigns).toHaveLength(20);
  expect(m.get).toHaveBeenCalledTimes(5);
  expect(result.complete).toBe(false);
  expect(result.campaigns.at(-1)?.reason).toBe("lookup_limit");
});
it("an unreadable stored reference remains historical evidence without requesting a guessed ID", async () => {
  m.result.data = [receipt("https://attacker.example"), { ...receipt(), exec_result: {} }];
  const result = await read();
  expect(result.campaigns.every(c => c.recorded_creation && c.current_status === null && c.reason === "receipt_without_reference")).toBe(true);
  expect(m.get).not.toHaveBeenCalled();
});
it("marks missing history and malformed rows incomplete", async () => {
  m.result = { data: [], error: { message: "secret" } };
  expect(await read()).toMatchObject({ status: "unavailable", complete: false, campaigns: [] });
  m.result = { data: [null], error: null };
  expect(await read()).toMatchObject({ status: "read", complete: false, campaigns: [] });
});
