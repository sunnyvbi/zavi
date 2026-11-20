import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  role: vi.fn(),
  autorun: vi.fn(),
  budget: vi.fn(),
  consent: vi.fn(),
  summary: vi.fn(),
  launch: vi.fn(),
  opStatus: null as string | null,
  opError: false,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => {
    const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ error: m.opError ? { message: "read failed" } : null, data: m.opStatus ? { status: m.opStatus } : null }) };
    return { from: () => q };
  },
}));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: m.role }));
vi.mock("@/services/growth/unattended-policy", () => ({
  readChannelAutorun: m.autorun,
}));
vi.mock("@/services/decisions/ad-budget", async (original) => ({
  ...(await original<typeof import("@/services/decisions/ad-budget")>()),
  readActiveAdBudget: m.budget,
}));
vi.mock("../consent", () => ({ requireSharedWalletConsent: m.consent }));
vi.mock("../linkedin-launch", async (original) => ({
  ...(await original<typeof import("../linkedin-launch")>()),
  linkedinLaunchSummary: m.summary,
  launchLinkedinCampaign: m.launch,
}));
import { executeLinkedinGrowthLaunch, LINKEDIN_LAUNCH_CARD_CHANGED, LINKEDIN_LAUNCH_NOT_REOPENED_CODE, LINKEDIN_LAUNCH_NOT_STARTED, LINKEDIN_LAUNCH_ZAVI_REFUSED_CODE, LINKEDIN_AUTOPILOT_UNREAD } from "../linkedin-growth";
import { classifyExecFailure, verdictFor } from "@/services/channels/exec-failure";
import { ExpectedToolError } from "@/services/tools/types";
const binding = "22222222-2222-4222-8222-222222222222",
  id = "11111111-1111-4111-8111-111111111111";
const body = {
  campaign_binding_id: binding,
  name: "Pilot",
  rationale: "Test the verified campaign",
  snapshot: "a".repeat(64),
  total_budget_cents: 600000,
  total_budget_usd: 6000,
  currency: "USD",
  end_time: Date.now() + 86400000,
  origin: "agent",
};
const decision = () => ({
  id,
  tenant_id: "tenant",
  body,
  approved_by: "founder",
  approved_by_source: null as string | null,
});
beforeEach(() => {
  vi.resetAllMocks();
  m.opStatus = null;
  m.opError = false;
  m.role.mockResolvedValue("owner");
  m.autorun.mockResolvedValue(true);
  m.budget.mockResolvedValue({ id: "budget" });
  m.summary.mockResolvedValue({
    currency: "USD",
    fx: { currency: "USD", units_per_usd: 1, as_of: null, source: "USD" },
    snapshot: body.snapshot,
    stop_requested_at: null,
  });
  m.launch.mockResolvedValue({ status: "active" });
});
it.each(["owner", "admin"])(
  "executes the exact bound launch for an approved %s",
  async (role) => {
    m.role.mockResolvedValue(role);
    expect((await executeLinkedinGrowthLaunch(decision())).ok).toBe(true);
    expect(m.launch).toHaveBeenCalledWith(
      "tenant",
      binding,
      expect.objectContaining({ request_id: id, total_budget_cents: 600000 }),
      expect.any(Function),
      { approved_by: "founder", approved_by_source: null, body, approved_total_usd: 6000 },
    );
  },
);
it.each(["member", null])(
  "refuses a demoted or removed approver (%s)",
  async (role) => {
    m.role.mockResolvedValue(role);
    expect((await executeLinkedinGrowthLaunch(decision())).ok).toBe(false);
    expect(m.launch).not.toHaveBeenCalled();
  },
);
it("requires an approver for the click path", async () => {
  expect(
    (await executeLinkedinGrowthLaunch({ ...decision(), approved_by: null }))
      .ok,
  ).toBe(false);
  expect(m.launch).not.toHaveBeenCalled();
});
it("allows paid Autopilot and passes a live revocation guard to each write", async () => {
  m.launch.mockImplementation(async (_t, _b, _v, guard) => {
    await guard();
    m.autorun.mockResolvedValue(false);
    await guard();
    return { status: "active" };
  });
  expect(
    (
      await executeLinkedinGrowthLaunch({
        ...decision(),
        approved_by_source: "cgo",
      })
    ).ok,
  ).toBe(false);
  expect(m.consent).toHaveBeenCalled();
  expect(m.role).not.toHaveBeenCalled();
});
it.each(["consent", "budget", "autorun", "pause", "snapshot"])(
  "holds Autopilot when %s is unavailable or changed",
  async (gate) => {
    if (gate === "consent") m.consent.mockRejectedValue(new Error("withdrawn"));
    if (gate === "budget") m.budget.mockResolvedValue(null);
    if (gate === "autorun") m.autorun.mockResolvedValue(false);
    if (gate === "pause")
      m.summary.mockResolvedValue({
        currency: "USD",
        snapshot: body.snapshot,
        stop_requested_at: "2026-10-13",
      });
    if (gate === "snapshot")
      m.summary.mockResolvedValue({
        currency: "USD",
        snapshot: "b".repeat(64),
      });
    expect(
      (
        await executeLinkedinGrowthLaunch({
          ...decision(),
          approved_by_source: "cgo",
        })
      ).ok,
    ).toBe(false);
    expect(m.launch).not.toHaveBeenCalled();
  },
);

it("refuses a proposal whose displayed converted cap does not match its provider cap", async () => {
  expect(
    (
      await executeLinkedinGrowthLaunch({
        ...decision(),
        body: { ...body, total_budget_usd: 1 },
      })
    ).ok,
  ).toBe(false);
  expect(m.launch).not.toHaveBeenCalled();
});

const INTERNAL_WORDS = /rollout|inventory|reconcil|operation|binding|tenant|replay|recovery|reservation|D3/i;
it("an already claimed launch tells the founder plainly not to approve it again", async () => {
  m.launch.mockResolvedValue({ status: "already_requested" });
  const r = await executeLinkedinGrowthLaunch(decision());
  expect(r).toEqual({ ok: false, code: "exec_outcome_unknown", error: "Zavi already used this launch request, so it will not send it to LinkedIn again. Check the campaign in LinkedIn Campaign Manager in a few minutes. If it is not running, review the launch again." });
  expect(r.error).not.toMatch(INTERNAL_WORDS);
  expect(m.launch).toHaveBeenCalledTimes(1);
});
it("a crash with no launch request on file says nothing was sent or held, and invites a retry", async () => {
  m.launch.mockRejectedValue(new Error("Launch could not be confirmed"));
  const r = await executeLinkedinGrowthLaunch(decision());
  expect(r).toEqual({ ok: false, code: LINKEDIN_LAUNCH_ZAVI_REFUSED_CODE, error: LINKEDIN_LAUNCH_NOT_STARTED });
  expect(r.error).not.toMatch(INTERNAL_WORDS);
  expect(r.error).not.toMatch(/stays held|Check the campaign/);
});
it("a crash before the launch even starts never claims a budget is being held", async () => {
  m.summary.mockRejectedValue(new TypeError("fetch failed"));
  const r = await executeLinkedinGrowthLaunch(decision());
  expect(r).toEqual({ ok: false, code: LINKEDIN_LAUNCH_ZAVI_REFUSED_CODE, error: LINKEDIN_LAUNCH_NOT_STARTED });
  expect(m.launch).not.toHaveBeenCalled();
});
it("a crash when Zavi cannot read the request does not promise that nothing was sent", async () => {
  m.launch.mockRejectedValue(new Error("boom"));
  m.opError = true;
  const r = await executeLinkedinGrowthLaunch(decision());
  expect(r.ok).toBe(false);
  expect(r.error).toContain("could not confirm whether this launch reached LinkedIn");
  expect(r.error).toContain("Any budget set aside for it stays held");
  expect(r.error).not.toMatch(/Nothing was sent/);
  expect(r).toMatchObject({ code: "exec_outcome_unknown" });
});
it("a launch whose outcome is unknown and whose receipt cannot be read shows no Try again", async () => {
  m.launch.mockRejectedValue(new ExpectedToolError("ads_launch_conflict", "may have reached LinkedIn", { outcome_unknown: true }));
  m.opError = true;
  const r = await executeLinkedinGrowthLaunch(decision());
  expect(r).toEqual({ ok: false, code: "exec_outcome_unknown", error: "may have reached LinkedIn" });
});
it("a permanent launch refusal closes the card instead of Try again forever", async () => {
  m.launch.mockRejectedValue(new ExpectedToolError("ads_launch_conflict", "already spent", { card_cannot_run: true }));
  const r = await executeLinkedinGrowthLaunch(decision());
  expect(r).toEqual({ ok: false, code: LINKEDIN_LAUNCH_NOT_REOPENED_CODE, error: "already spent" });
});
it("a crash on a request that really is in flight still says it stays held", async () => {
  m.launch.mockRejectedValue(new Error("boom"));
  m.opStatus = "pending";
  const r = await executeLinkedinGrowthLaunch(decision());
  expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
  expect(r.error).toContain("stays held");
});
it("a card whose campaign changed closes for good: the code Zavi files is one the card shows no Try again for", async () => {
  m.summary.mockResolvedValue({ currency: "USD", fx: null, snapshot: "b".repeat(64), stop_requested_at: null });
  const r = await executeLinkedinGrowthLaunch(decision());
  expect(r).toEqual({ ok: false, code: LINKEDIN_LAUNCH_NOT_REOPENED_CODE, error: LINKEDIN_LAUNCH_CARD_CHANGED });
  expect(classifyExecFailure(r)?.bucket).toBe("blocked_on_us");
  expect(m.launch).not.toHaveBeenCalled();
});
it("a change only the live launch check sees also closes the card", async () => {
  m.launch.mockRejectedValue(new ExpectedToolError("ads_launch_conflict", "The campaign or its ads changed. Review the launch again.", { card_cannot_run: true }));
  const r = await executeLinkedinGrowthLaunch(decision());
  expect(r).toEqual({ ok: false, code: LINKEDIN_LAUNCH_NOT_REOPENED_CODE, error: "The campaign or its ads changed. Review the launch again." });
  expect(classifyExecFailure(r)?.bucket).toBe("blocked_on_us");
});
it("a state that can recover keeps Try again: it files no closing code", async () => {
  m.launch.mockRejectedValue(new ExpectedToolError("ads_launch_conflict", "One or more ads are not ready for launch."));
  const r = await executeLinkedinGrowthLaunch(decision());
  expect(r).toEqual({ ok: false, code: LINKEDIN_LAUNCH_ZAVI_REFUSED_CODE, error: "One or more ads are not ready for launch." });
  expect(classifyExecFailure(r)?.bucket).toBe("temporary");
});
it("a closing error from an attempt already on file does not hide that attempt", async () => {
  m.launch.mockRejectedValue(new ExpectedToolError("ads_launch_conflict", "The campaign or its ads changed. Review the launch again.", { card_cannot_run: true }));
  m.opStatus = "uncertain";
  expect(await executeLinkedinGrowthLaunch(decision())).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
});
it("passes the launch's own founder copy through unchanged", async () => {
  m.launch.mockRejectedValue(new ExpectedToolError("ads_launch_conflict", "Another change to this campaign is still finishing. Try again in a minute."));
  expect(await executeLinkedinGrowthLaunch(decision())).toEqual({ ok: false, code: LINKEDIN_LAUNCH_ZAVI_REFUSED_CODE, error: "Another change to this campaign is still finishing. Try again in a minute." });
});
const gbpBody = { ...body, currency: "GBP", total_budget_cents: 10000, total_budget_usd: 125 };
const gbpSummary = (units_per_usd: number) =>
  m.summary.mockResolvedValue({
    currency: "GBP",
    fx: { currency: "GBP", units_per_usd, as_of: "2026-10-26T00:00:01.000Z", source: "ExchangeRate-API" },
    snapshot: body.snapshot,
    stop_requested_at: null,
  });
it.each([null, "cgo"])("a GBP card approved (%s) after a rate refresh within 2% launches with its approved dollars as the ceiling", async (source) => {
  gbpSummary(0.79);
  const r = await executeLinkedinGrowthLaunch({ ...decision(), approved_by_source: source, body: gbpBody });
  expect(r.ok).toBe(true);
  expect(m.launch).toHaveBeenCalledWith(
    "tenant",
    binding,
    { request_id: id, snapshot: body.snapshot, total_budget_cents: 10000, end_time: body.end_time },
    expect.any(Function),
    { approved_by: "founder", approved_by_source: source, body: gbpBody, approved_total_usd: 125 },
  );
});
it("a GBP card whose rate moved more than 2% is refused in plain words and never reaches the launch", async () => {
  gbpSummary(0.75);
  const r = await executeLinkedinGrowthLaunch({ ...decision(), body: gbpBody });
  expect(r).toEqual({ ok: false, code: LINKEDIN_LAUNCH_NOT_REOPENED_CODE, error: "The exchange rate moved since this launch was approved, so it now comes to $133.34, more than 2% above the $125.00 approved. Nothing was sent to LinkedIn. Review the launch again." });
  expect(r.error).not.toMatch(INTERNAL_WORDS);
  expect(m.launch).not.toHaveBeenCalled();
});
it("a GBP card with a changed native campaign is still refused whatever the rate", async () => {
  m.summary.mockResolvedValue({
    currency: "GBP",
    fx: { currency: "GBP", units_per_usd: 0.8, as_of: null, source: "ExchangeRate-API" },
    snapshot: "b".repeat(64),
    stop_requested_at: null,
  });
  expect(await executeLinkedinGrowthLaunch({ ...decision(), body: gbpBody })).toEqual({ ok: false, code: LINKEDIN_LAUNCH_NOT_REOPENED_CODE, error: LINKEDIN_LAUNCH_CARD_CHANGED });
  expect(m.launch).not.toHaveBeenCalled();
});
it.each([6000.01, 5999.99])("a USD card whose approved dollars differ by a cent (%s) is still refused", async (usd) => {
  expect(await executeLinkedinGrowthLaunch({ ...decision(), body: { ...body, total_budget_usd: usd } })).toEqual({ ok: false, code: LINKEDIN_LAUNCH_NOT_REOPENED_CODE, error: LINKEDIN_LAUNCH_CARD_CHANGED });
  expect(m.launch).not.toHaveBeenCalled();
});
it("a monthly budget refusal keeps its original words on the approval card, so the card can still offer the budget fix", async () => {
  const raw = "cap_refuse: ad_budget_over_month";
  m.launch.mockRejectedValue(new ExpectedToolError("ads_launch_not_sent", "This launch would go over your monthly ad budget. Nothing was sent to LinkedIn. Lower the total budget or raise your monthly ad budget, then try again.", { budget_refusal: raw }));
  expect(await executeLinkedinGrowthLaunch(decision())).toEqual({ ok: false, error: raw });
});
describe("a launch Zavi itself refused", () => {
  const INTERNAL = /cap_refuse|ad_budget_/;
  it.each([
    ["object_busy", "cap_refuse: ad_budget_object_busy: another change to this ad is still in flight; try again shortly"],
    ["over_projection", "cap_refuse: ad_budget_over_projection: this month is on track for $1,200, $200 over your $1,000 cap, so Autopilot adds no spend. Approve it yourself to go ahead; nothing was sent"],
    ["over_projection_with_change", "cap_refuse: ad_budget_over_projection_with_change: This puts you on track, so Autopilot left it for you to approve; nothing was sent"],
    ["platform_unread", "cap_refuse: ad_budget_platform_unread: LinkedIn spend could not be read on the last check. Reconnect it in Settings; nothing was sent"],
    ["unavailable", "cap_refuse: ad_budget_unavailable: the ad budget could not be checked, nothing was sent"],
    ["not_active", "cap_refuse: ad_budget_not_active: the CGO spends only under an active ad budget"],
    ["unknown reason", "cap_refuse: ad_budget_check_failed"],
  ])("%s reaches the card in founder words, never the raw refusal", async (_label, raw) => {
    const words = "Plain words for the founder. Nothing was sent to LinkedIn.";
    m.launch.mockRejectedValue(new ExpectedToolError("ads_launch_conflict", words, { budget_refusal: raw }));
    const r = await executeLinkedinGrowthLaunch(decision());
    expect(r).toEqual({ ok: false, code: LINKEDIN_LAUNCH_ZAVI_REFUSED_CODE, error: words });
    expect(JSON.stringify(r)).not.toMatch(INTERNAL);
    expect(classifyExecFailure(r)).toMatchObject({ bucket: "temporary", fix: null });
  });
  it.each(["cap_refuse: ad_budget_over_month", "cap_refuse: ad_budget_over_daily_limit"])("%s keeps the budget fix link on the card", async (raw) => {
    m.launch.mockRejectedValue(new ExpectedToolError("ads_launch_conflict", "Words.", { budget_refusal: raw }));
    const r = await executeLinkedinGrowthLaunch(decision());
    expect(classifyExecFailure(r)).toMatchObject({ bucket: "needs_founder", fix: "ad_budget" });
    expect(verdictFor(r, "linkedin_ads.launch_campaign")?.note).toBe("Nothing was sent to LinkedIn Ads.");
  });
  it("LinkedIn's own refusal is not relabelled as Zavi's", async () => {
    m.launch.mockRejectedValue(new ExpectedToolError("linkedin_ads_write_refused", "LinkedIn did not accept this total budget."));
    expect(await executeLinkedinGrowthLaunch(decision())).toEqual({ ok: false, error: "LinkedIn did not accept this total budget." });
  });
  it("a card that can never pass closes instead of offering Try again: a moved exchange rate", async () => {
    gbpSummary(0.75);
    const r = await executeLinkedinGrowthLaunch({ ...decision(), body: gbpBody });
    expect(classifyExecFailure(r)?.bucket).toBe("blocked_on_us");
  });
  it("a launch with no approver is Zavi's own refusal and never reaches the launch", async () => {
    const r = await executeLinkedinGrowthLaunch({ ...decision(), approved_by: null, approved_by_source: "email" });
    expect(r).toMatchObject({ ok: false, code: LINKEDIN_LAUNCH_ZAVI_REFUSED_CODE, error: "An owner or admin must approve this launch." });
    expect(m.launch).not.toHaveBeenCalled();
  });
});
describe("Review 34 P4: a brief read error is never read as Autopilot or the budget being turned off", () => {
  const TURNED_OFF = /turned off/;
  it("a one-off Autopilot or budget read error between LinkedIn writes is read again, so the half-launched campaign is not stopped", async () => {
    let guards = 0;
    m.launch.mockImplementation(async (_t, _b, _v, guard) => {
      await guard();
      m.autorun.mockRejectedValueOnce(new Error("autorun read failed: connection reset"));
      await guard();
      guards += 2;
      m.budget.mockRejectedValueOnce(new Error("ad budget read failed: statement timeout"));
      await guard();
      guards += 1;
      return { status: "active" };
    });
    const r = await executeLinkedinGrowthLaunch({ ...decision(), approved_by_source: "cgo" });
    expect(r.ok).toBe(true);
    expect(guards).toBe(3);
    expect(JSON.stringify(r)).not.toMatch(TURNED_OFF);
  });
  it("an Autopilot read that keeps failing says Zavi could not check, never that Autopilot or the budget was turned off, and nothing is launched", async () => {
    m.autorun.mockRejectedValue(new Error("autorun read failed: connection reset"));
    const r = await executeLinkedinGrowthLaunch({ ...decision(), approved_by_source: "cgo" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe(LINKEDIN_AUTOPILOT_UNREAD);
    expect((r as { error: string }).error).not.toMatch(TURNED_OFF);
    expect(m.launch).not.toHaveBeenCalled();
    expect(m.autorun).toHaveBeenCalledTimes(3);
  });
  it("a budget read that keeps failing says Zavi could not check, never that the budget was turned off", async () => {
    m.budget.mockRejectedValue(new Error("ad budget read failed: statement timeout"));
    const r = await executeLinkedinGrowthLaunch({ ...decision(), approved_by_source: "cgo" });
    expect((r as { error: string }).error).toBe(LINKEDIN_AUTOPILOT_UNREAD);
    expect(m.launch).not.toHaveBeenCalled();
  });
  it("non-regression guard: a budget that really is off still refuses with the turned-off words", async () => {
    m.budget.mockResolvedValue(null);
    const r = await executeLinkedinGrowthLaunch({ ...decision(), approved_by_source: "cgo" });
    expect((r as { error: string }).error).toMatch(TURNED_OFF);
    expect(m.launch).not.toHaveBeenCalled();
  });
});
