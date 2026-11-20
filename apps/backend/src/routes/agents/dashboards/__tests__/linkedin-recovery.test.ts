import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("@/services/linkedin-social/refresh-status", () => ({ readLinkedInRefreshStatus: async () => m.receipt }));
const m = vi.hoisted(() => ({ refresh: vi.fn(), usable: vi.fn(), accounts: [] as unknown[], used: 3, receipt: null as any }));
vi.mock("@/services/connectors/metadata", () => ({ readConnectorList: async () => [] }));
vi.mock("@/services/connectors/social-publish-account", () => ({ isLinkedInSocialUsable: m.usable }));
vi.mock("@/services/channels/context", () => ({ defaultChannelContext: async () => ({}) }));
vi.mock("@/services/linkedin-social/snapshots", () => ({
 LINKEDIN_CHANNEL: "linkedin", LINKEDIN_METER_KEY: "linkedin_metrics", LINKEDIN_READS_PER_DAY: 3,
 savedPageUrl: () => "https://www.linkedin.com/company/example/", refreshLinkedIn: m.refresh,
}));
import { build, shapeLinkedIn } from "../linkedin-organic";
const context = (manual = false) => ({ tenantId: "tenant-a", meteredRefresh: manual, sb: { from(table: string) {
 const q: any = {}; for (const k of ["select", "eq", "gte", "order", "in", "limit"]) q[k] = () => q;
 const result = () => ({ data: table === "social_account_snapshots" ? m.accounts : table === "tenant_metered_read_counters" ? { reads: m.used } : table === "tenant_app_setting" ? null : [], error: null });
 q.maybeSingle = async () => result(); q.then = (fn: any) => Promise.resolve(result()).then(fn); return q;
}} }) as never;
beforeEach(() => {
 vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-18T08:00:00Z"));
 m.accounts = [{ captured_on: "2026-11-02", name: "Example", followers_count: 1111 }];
 m.receipt = null; m.used = 3; m.usable.mockReset().mockResolvedValue(false);
 m.refresh.mockReset().mockResolvedValue({ ok: false, reason: "cap_reached", message: "All 3 of today's LinkedIn refreshes are used. They reset at midnight UTC." });
});
afterEach(() => { vi.useRealTimers(); });
it("shows stale snapshot date and an exhausted allowance on automatic loads", async () => {
 const out: any = await build(context());
 expect(out.freshness).toEqual({ last_success_day: "2026-11-02", stale: true });
 expect(out.problem).toContain("All 3"); expect(out.top_posts).toEqual([]);
});
it("does not retry automatically after a failed attempt already used a slot", async () => {
 m.used = 1; const out: any = await build(context());
 expect(m.refresh).not.toHaveBeenCalled(); expect(out.problem).toMatch(/automatic refresh|newer numbers/i);
});
it("reserves an automatic first read separately from a manual refresh", async () => {
 m.used = 0; await build(context());
 expect(m.refresh).toHaveBeenCalledWith("tenant-a", { automatic: true });
 m.refresh.mockClear(); await build(context(true));
 expect(m.refresh).toHaveBeenCalledWith("tenant-a", { automatic: false });
});
it("does not present a missing publisher as the measured company", async () => {
 const out: any = await build(context()); expect(out.publishing_connected).toBe(false); expect(out.publishing_account).toBeNull();
});
it("keeps connection-read failures unknown", async () => {
 m.usable.mockRejectedValue(new Error("read failed"));
 expect((await build(context()) as any).publishing_connected).toBeNull();
});
it("compares followers to the immediately previous successful read", () => {
 const out = shapeLinkedIn([
 { captured_on: "2026-10-21", name: "Example", followers_count: 1036 },
 { captured_on: "2026-10-30", name: "Example", followers_count: 1107 },
 { captured_on: "2026-11-02", name: "Example", followers_count: 1111 },
 ], []);
 expect(out.metrics[0]).toMatchObject({ value: 1111, prev_value: 1107, prev_day: "2026-10-30" });
});

it("does not present an older failed receipt as today's failure", async () => {
 m.receipt = {page_url:"https://www.linkedin.com/company/example/",at:"2026-11-17T08:00:00Z",ok:false,message:"Old failure"};
 expect((await build(context()) as any).problem).toContain("All 3");
 m.receipt.at = "2026-11-18T08:00:00Z";
 expect((await build(context()) as any).problem).toBe("Old failure");
});
it("marks an unreadable allowance as unknown without spending a read", async () => {
 m.used = NaN;
 const out: any = await build(context());
 expect(out.refresh.available).toBe(false);expect(m.refresh).not.toHaveBeenCalled();
});
