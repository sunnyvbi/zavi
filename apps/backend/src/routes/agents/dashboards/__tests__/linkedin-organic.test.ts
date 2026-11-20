import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/services/linkedin-social/refresh-status", () => ({ readLinkedInRefreshStatus: async () => null }));
const m = vi.hoisted(() => ({ refresh: vi.fn(), connectors: vi.fn(), usable: vi.fn() }));
vi.mock("@/services/connectors/metadata", () => ({ readConnectorList: m.connectors }));
vi.mock("@/services/connectors/social-publish-account", () => ({ isLinkedInSocialUsable: m.usable }));
vi.mock("@/services/channels/context", () => ({ defaultChannelContext: async () => ({}) }));
vi.mock("@/services/linkedin-social/snapshots", () => ({
  LINKEDIN_CHANNEL: "linkedin", LINKEDIN_METER_KEY: "linkedin_metrics", LINKEDIN_READS_PER_DAY: 3,
  savedPageUrl: () => "https://www.linkedin.com/company/zavi/", refreshLinkedIn: m.refresh,
}));
vi.mock("@/services/channels/staged-drafts", () => ({ LINKEDIN_CHANNELS: new Set(["linkedin"]), stagedDrafts: async () => [] }));
import { build } from "../linkedin-organic";
function context(failedTable: string, failAfterRefresh = false) {
  return { tenantId: "tenant-a", meteredRefresh: true, sb: {
    from(table: string) {
      const result = () => table === failedTable && (!failAfterRefresh || m.refresh.mock.calls.length > 0)
        ? { data: null, error: { message: "database unavailable" } } : { data: [], error: null };
      const q: Record<string, unknown> = {};
      for (const key of ["select", "eq", "gte", "lte", "order", "limit"]) q[key] = () => q;
      q.maybeSingle = async () => result();
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return q;
    },
  } } as never;
}
beforeEach(() => { m.refresh.mockReset().mockResolvedValue({ ok: true }); m.connectors.mockReset().mockResolvedValue([]); m.usable.mockReset().mockResolvedValue(true); });
describe("LinkedIn stored read failures", () => {
  it.each(["social_account_snapshots", "social_post_metric_snapshots"])("reports %s failure without spending a refresh", async table => {
    const out = await build(context(table)) as { problem: string };
    expect(m.refresh).not.toHaveBeenCalled();
    expect(out.problem).toMatch(/could not load your stored LinkedIn/);
  });
  it("reports a failed reload after a successful provider refresh", async () => {
    const out = await build(context("social_post_metric_snapshots", true)) as { problem: string };
    expect(m.refresh).toHaveBeenCalledTimes(1);
    expect(out.problem).toMatch(/could not load your stored LinkedIn/);
  });
});

it("projects only the native OAuth personal name, independently of the public reference page", async () => {
  m.connectors.mockResolvedValue([{ slug: "linkedin_ads", team_name: "Company ads" }, { slug: "linkedin_social", team_name: " Ravi Founder " }]);
  const out = await build(context("")) as { publishing_account: unknown; page_url: string };
  expect(m.connectors).toHaveBeenCalledWith("tenant-a");
  expect(out.publishing_account).toEqual({ name: "Ravi Founder" });
  expect(out.page_url).toBe("https://www.linkedin.com/company/zavi/");
});
it("keeps an unreadable personal name unknown while allowing the dashboard to load", async () => {
  m.connectors.mockRejectedValue(new Error("metadata unavailable"));
  const out = await build(context("")) as { publishing_account: unknown; page_url: string };
  expect(out.publishing_account).toBeNull();
  expect(out.page_url).toContain("/company/");
});
it("does not use a company or blank connector label as a personal identity", async () => {
  m.connectors.mockResolvedValue([{ slug: "linkedin_ads", team_name: "Company ads" }, { slug: "linkedin_social", team_name: " " }]);
  expect((await build(context("")) as { publishing_account: unknown }).publishing_account).toBeNull();
});
it("names no publisher when the native connection is expired or unusable", async () => {
  m.connectors.mockResolvedValue([{ slug: "linkedin_social", team_name: "Ravi Founder" }]);
  m.usable.mockResolvedValue(false);
  expect((await build(context("")) as { publishing_account: unknown }).publishing_account).toBeNull();
  expect(m.usable).toHaveBeenCalledWith("tenant-a");
});

it("shows no today-only refresh banner over a past date range", async () => {
  const sb = { from(table: string) {
    const q: Record<string, unknown> = {};
    for (const key of ["select", "eq", "gte", "lte", "order", "limit"]) q[key] = () => q;
    q.maybeSingle = async () => ({ data: table === "tenant_metered_read_counters" ? { reads: 3 } : null, error: null });
    q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return q;
  } };
  const today = await build({ tenantId: "tenant-a", meteredRefresh: false, rangeDays: null, customRange: null, sb } as never) as { problem: string | null };
  expect(today.problem).toMatch(/All 3 of today's LinkedIn refreshes are used/);
  const past = await build({ tenantId: "tenant-a", meteredRefresh: false, rangeDays: null, customRange: { since: "2026-10-01", until: "2026-10-31" }, sb } as never) as { problem: string | null; period: unknown };
  expect(past.problem).toBeNull();
  expect(past.period).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  expect(m.refresh).not.toHaveBeenCalled();
});
