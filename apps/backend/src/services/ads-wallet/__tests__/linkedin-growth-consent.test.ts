import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  role: vi.fn(),
  autorun: vi.fn(),
  budget: vi.fn(),
  summary: vi.fn(),
  launch: vi.fn(),
  consentRows: [] as Array<{ data: unknown; error: unknown }>,
  consentReads: 0,
  writes: [] as string[],
}));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: m.role }));
vi.mock("@/services/growth/unattended-policy", () => ({ readChannelAutorun: m.autorun }));
vi.mock("@/services/decisions/ad-budget", async (original) => ({
  ...(await original<typeof import("@/services/decisions/ad-budget")>()),
  readActiveAdBudget: m.budget,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => ({
    from: (table: string) => {
      if (table !== "ads_wallet_consents") throw new Error(`unexpected table ${table}`);
      const q = {
        select: () => q,
        maybeSingle: async () => {
          m.consentReads++;
          return m.consentRows.length > 1 ? m.consentRows.shift()! : m.consentRows[0]!;
        },
      };
      return q;
    },
  }),
}));
vi.mock("../linkedin-launch", async (original) => ({
  ...(await original<typeof import("../linkedin-launch")>()),
  linkedinLaunchSummary: m.summary,
  launchLinkedinCampaign: m.launch,
}));
import { executeLinkedinGrowthLaunch, LINKEDIN_AUTOPILOT_CONSENT_REQUIRED } from "../linkedin-growth";
import { SHARED_WALLET_CONSENT_VERSION } from "../consent";
import { adsFx } from "../fx";

const body = {
  campaign_binding_id: "22222222-2222-4222-8222-222222222222",
  name: "Own billing pilot",
  rationale: "Test the verified campaign",
  snapshot: "a".repeat(64),
  total_budget_cents: 50000,
  total_budget_usd: 500,
  currency: "USD",
  end_time: Date.now() + 3 * 86400000,
  origin: "agent",
};
const autopilot = () => ({ id: "11111111-1111-4111-8111-111111111111", tenant_id: "tenant", body, approved_by: "owner-1", approved_by_source: "cgo" });
const consented = { data: { version: SHARED_WALLET_CONSENT_VERSION, revoked_at: null }, error: null };

beforeEach(async () => {
  vi.clearAllMocks();
  m.consentRows = [consented];
  m.consentReads = 0;
  m.writes = [];
  m.autorun.mockResolvedValue(true);
  m.budget.mockResolvedValue({ monthly_usd: 1000 });
  m.role.mockResolvedValue("owner");
  m.summary.mockResolvedValue({ currency: "USD", snapshot: body.snapshot, fx: await adsFx("USD"), funding_source: "own" });
  m.launch.mockImplementation(async (_t: string, _b: string, _v: unknown, beforeWrite: () => Promise<void>) => {
    await beforeWrite();
    m.writes.push("totalBudget+runSchedule");
    await beforeWrite();
    m.writes.push("status:ACTIVE");
    return { status: "active" };
  });
});

it.each([
  ["never given", { data: null, error: null }],
  ["withdrawn", { data: { version: SHARED_WALLET_CONSENT_VERSION, revoked_at: "2026-10-20T00:00:00Z" }, error: null }],
  ["given for an older wording", { data: { version: "shared_ads_wallet_v0", revoked_at: null }, error: null }],
])("Autopilot never launches an own-billing LinkedIn campaign when wallet permission was %s, and says what to do", async (_label, row) => {
  m.consentRows = [row];
  const r = await executeLinkedinGrowthLaunch(autopilot());
  expect(r).toEqual({ ok: false, code: "linkedin_ads_launch_refused", error: LINKEDIN_AUTOPILOT_CONSENT_REQUIRED });
  expect(m.launch).not.toHaveBeenCalled();
  expect(m.summary).not.toHaveBeenCalled();
  expect(m.writes).toEqual([]);
});

it("fails closed when the permission cannot be read", async () => {
  m.consentRows = [{ data: null, error: { message: "timeout" } }];
  const r = await executeLinkedinGrowthLaunch(autopilot());
  expect(r).toEqual({ ok: false, code: "linkedin_ads_launch_refused", error: "Shared wallet permission could not be checked." });
  expect(m.launch).not.toHaveBeenCalled();
  expect(m.writes).toEqual([]);
});

it("stops before the go-live write when permission is withdrawn mid-launch", async () => {
  m.consentRows = [consented, consented, { data: null, error: null }];
  const r = await executeLinkedinGrowthLaunch(autopilot());
  expect(r).toEqual({ ok: false, code: "linkedin_ads_launch_refused", error: LINKEDIN_AUTOPILOT_CONSENT_REQUIRED });
  expect(m.writes).toEqual(["totalBudget+runSchedule"]);
  expect(m.consentReads).toBe(3);
});

it("launches under Autopilot once permission is in place, checking it before every write", async () => {
  const r = await executeLinkedinGrowthLaunch(autopilot());
  expect(r).toEqual({ ok: true, notice: expect.any(String) });
  expect(m.writes).toEqual(["totalBudget+runSchedule", "status:ACTIVE"]);
  expect(m.consentReads).toBe(3);
});

it("an owner's own approval of an own-billing launch is the yes and needs no wallet permission", async () => {
  m.consentRows = [{ data: null, error: null }];
  const r = await executeLinkedinGrowthLaunch({ ...autopilot(), approved_by_source: "email" });
  expect(r.ok).toBe(true);
  expect(m.consentReads).toBe(0);
  expect(m.role).toHaveBeenCalledWith("owner-1", "tenant");
});
