import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  error: vi.fn(),
  tenant: "tenant-a",
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  reads: [] as Array<{ tenant: string; table: string; eqs: Array<[string, unknown]>; columns?: string }>,
  linkedin: vi.fn(),
  live: vi.fn(),
}));
vi.mock("../wallet-auth", () => ({ walletAuth: m.auth, walletError: m.error }));
vi.mock("@/services/ads-wallet/bindings", () => ({ getCampaignBinding: vi.fn() }));
vi.mock("@/services/ads-wallet/linkedin-launch", () => ({
  linkedinLaunchSummary: m.linkedin,
  linkedinLaunchObservedCents: m.linkedin,
  linkedinLaunchOwnHoldUsd: m.linkedin,
  launchLinkedinCampaign: m.linkedin,
}));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({ requestLinkedinPause: m.linkedin, linkedinCampaign: m.live }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      const read = { tenant, table, eqs: [] as Array<[string, unknown]>, columns: undefined as string | undefined };
      m.reads.push(read);
      const filters: Array<(r: Record<string, unknown>) => boolean> = [(r) => r.tenant_id === undefined || r.tenant_id === tenant];
      const chain: Record<string, unknown> = {};
      chain.select = (columns?: string) => ((read.columns = columns), chain);
      chain.order = () => chain;
      chain.range = () => chain;
      chain.eq = (k: string, v: unknown) => {
        read.eqs.push([k, v]);
        filters.push((r) => r[k] === v);
        return chain;
      };
      chain.in = (k: string, v: unknown[]) => {
        filters.push((r) => v.includes(r[k] as never));
        return chain;
      };
      chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve({ data: (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }).then(ok, bad);
      chain.maybeSingle = () => Promise.resolve({ data: (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null });
      return chain;
    },
  }),
}));
import { adsBoundCampaigns } from "../campaigns";
const req = (platform: string) => ({ query: { platform } }) as unknown as Request;
const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response & { json: ReturnType<typeof vi.fn> };
};
const bind = (id: string, pcid: string, tenant = "tenant-a", platform = "linkedin") => ({ id, platform, provider_campaign_id: pcid, account_binding_id: "a", funding_source: "wallet", tenant_id: tenant });
const life = (id: string, o: Record<string, unknown> = {}, tenant = "tenant-a") => ({ campaign_binding_id: id, tenant_id: tenant, created_paused: true, activation_attempted_at: null, stop_requested_at: null, stop_confirmed_at: null, provider_creative_ids: ["1"], ...o });
const op = (id: string, status: string, updated_at: string, tenant = "tenant-a") => ({ campaign_binding_id: id, tenant_id: tenant, kind: "activate", status, updated_at });
const statuses = async (platform = "linkedin") => {
  const r = res();
  await adsBoundCampaigns(req(platform), r);
  expect(m.error).not.toHaveBeenCalled();
  const body = r.json.mock.calls[0]![0] as { campaigns: Array<{ id: string; status?: string }> };
  return Object.fromEntries(body.campaigns.map((c) => [c.id, "status" in c ? c.status : "absent"]));
};
const fetchSpy = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  m.reads.length = 0;
  m.live.mockResolvedValue(null);
  m.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "u" });
  vi.stubGlobal("fetch", fetchSpy);
  m.tables = {
    ads_campaign_binding_details: [bind("paused", "1"), bind("active", "2"), bind("relaunched", "3"), bind("uncertain", "4"), bind("fresh", "5"), bind("unconfirmed", "6"), bind("foreign", "9", "tenant-b")],
    ads_account_binding_details: [{ id: "a", tenant_id: "tenant-a", platform: "linkedin", provider_account_id: null, funding_source: "wallet" }],
    ads_account_selections: [],
    ads_account_binding_status: [],
    channel_actions: [],
    ads_campaign_lifecycle: [
      life("paused", { activation_attempted_at: "2026-10-01T00:00:00Z", stop_requested_at: "2026-10-02T00:00:00Z", stop_confirmed_at: "2026-10-02T00:01:00Z" }),
      life("active", { activation_attempted_at: "2026-10-01T00:00:00Z" }),
      life("relaunched", { activation_attempted_at: "2026-10-03T00:00:00Z", stop_requested_at: null, stop_confirmed_at: "2026-10-02T00:01:00Z" }),
      life("uncertain", { activation_attempted_at: "2026-10-01T00:00:00Z" }),
      life("fresh"),
      life("unconfirmed", { activation_attempted_at: "2026-10-01T00:00:00Z", stop_requested_at: "2026-10-02T00:00:00Z" }),
      life("foreign", { stop_requested_at: "2026-10-02T00:00:00Z", stop_confirmed_at: "2026-10-02T00:01:00Z" }, "tenant-b"),
    ],
    ads_campaign_operations: [
      op("paused", "succeeded", "2026-10-01T00:00:10Z"),
      op("active", "succeeded", "2026-10-01T00:00:10Z"),
      op("relaunched", "succeeded", "2026-10-01T00:00:10Z"),
      op("relaunched", "succeeded", "2026-10-03T00:00:10Z"),
      op("uncertain", "uncertain", "2026-10-01T00:00:10Z"),
      op("unconfirmed", "succeeded", "2026-10-01T00:00:10Z"),
      op("foreign", "succeeded", "2026-10-01T00:00:10Z", "tenant-b"),
    ],
  };
});
it("derives Paused/Live from stored state, omits what is unclear, and never reads another tenant or calls LinkedIn", async () => {
  expect(await statuses()).toEqual({
    paused: "PAUSED",
    active: "ACTIVE",
    relaunched: "ACTIVE",
    uncertain: "absent",
    fresh: "PAUSED",
    unconfirmed: "absent",
  });
  const stateReads = m.reads.filter((r) => r.table === "ads_campaign_lifecycle" || r.table === "ads_campaign_operations");
  expect(stateReads.length).toBeGreaterThanOrEqual(2);
  for (const r of m.reads) expect(r.tenant).toBe("tenant-a");
  for (const r of stateReads) expect(r.eqs).toContainEqual(["tenant_id", "tenant-a"]);
  expect(m.linkedin).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});
it("Flow 32: a campaign whose launch is unconfirmed or still in flight is flagged launch_pending so a second launch can be blocked; settled ones are not", async () => {
  m.tables.ads_campaign_operations.push(op("fresh", "pending", "2026-10-04T00:00:00Z"));
  m.tables.ads_campaign_operations.push(op("paused", "refused", "2026-10-04T00:00:00Z"));
  const r = res();
  await adsBoundCampaigns(req("linkedin"), r);
  expect(m.error).not.toHaveBeenCalled();
  const rows = (r.json.mock.calls[0]![0] as { campaigns: Array<{ id: string; launch_pending?: unknown }> }).campaigns;
  expect(Object.fromEntries(rows.map((c) => [c.id, c.launch_pending ?? "absent"]))).toEqual({
    paused: "absent",
    active: "absent",
    relaunched: "absent",
    uncertain: true,
    fresh: true,
    unconfirmed: "absent",
  });
  expect(m.linkedin).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});
it("Flow 16: a stop LinkedIn has not confirmed yet is flagged pause_pending until it is confirmed or a newer launch supersedes it", async () => {
  m.tables.ads_campaign_binding_details.push(bind("restopped", "7"), bind("reactivated", "8"));
  m.tables.ads_campaign_lifecycle.push(
    life("restopped", { activation_attempted_at: "2026-10-01T00:00:00Z", stop_requested_at: "2026-10-04T00:00:00Z", stop_confirmed_at: "2026-10-02T00:01:00Z" }),
    life("reactivated", { activation_attempted_at: "2026-10-01T00:00:00Z", stop_requested_at: "2026-10-02T00:00:00Z" }),
  );
  m.tables.ads_campaign_operations.push(op("restopped", "succeeded", "2026-10-01T00:00:10Z"), op("reactivated", "succeeded", "2026-10-03T00:00:00Z"));
  const r = res();
  await adsBoundCampaigns(req("linkedin"), r);
  expect(m.error).not.toHaveBeenCalled();
  const rows = (r.json.mock.calls[0]![0] as { campaigns: Array<{ id: string; pause_pending?: unknown; status?: unknown }> }).campaigns;
  expect(Object.fromEntries(rows.map((c) => [c.id, c.pause_pending ?? "absent"]))).toEqual({
    paused: "absent",
    active: "absent",
    relaunched: "absent",
    uncertain: "absent",
    fresh: "absent",
    unconfirmed: true,
    restopped: true,
    reactivated: "absent",
  });
  expect(rows.find((c) => c.id === "unconfirmed")?.status).toBeUndefined();
  expect(m.linkedin).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});
it("reads campaign state in a fixed number of queries however many campaigns are listed", async () => {
  const many = Array.from({ length: 40 }, (_, i) => bind(`c${i}`, `${100 + i}`));
  m.tables.ads_campaign_binding_details = many;
  m.tables.ads_campaign_lifecycle = many.map((c) => life(c.id));
  m.tables.ads_campaign_operations = [];
  const out = await statuses();
  expect(Object.values(out).every((v) => v === "PAUSED")).toBe(true);
  expect(m.reads.filter((r) => r.table === "ads_campaign_lifecycle" || r.table === "ads_campaign_operations")).toHaveLength(2);
  expect(fetchSpy).not.toHaveBeenCalled();
});
it("a stop confirmed before a later successful activate does not mark it paused", async () => {
  m.tables.ads_campaign_operations.push(op("paused", "succeeded", "2026-10-05T00:00:00Z"));
  expect((await statuses()).paused).toBe("absent");
});
it("a refused activate leaves a launched-then-never-attempted campaign without a guess", async () => {
  m.tables.ads_campaign_lifecycle = [life("fresh", { activation_attempted_at: "2026-10-01T00:00:00Z" })];
  m.tables.ads_campaign_operations = [op("fresh", "refused", "2026-10-01T00:00:10Z")];
  expect((await statuses()).fresh).toBe("absent");
});
it("leaves other platforms unchanged and reads no state tables", async () => {
  m.tables.ads_campaign_binding_details = [bind("x", "7", "tenant-a", "chatgpt")];
  expect(await statuses("chatgpt")).toEqual({ x: "absent" });
  expect(m.reads.map((r) => r.table)).toEqual(["ads_campaign_binding_details"]);
});
it("omits status when an activated campaign has no operation record", async () => {
  m.tables.ads_campaign_operations = undefined as never;
  const out = await statuses();
  expect(Object.values(out).every((v) => v === "PAUSED" || v === "absent")).toBe(true);
  expect(out.active).toBe("absent");
});
describe("a campaign LinkedIn no longer has", () => {
  const marker = (id: string, status = "succeeded") => ({ campaign_binding_id: id, tenant_id: "tenant-a", kind: "finalize", status, updated_at: "2026-10-03T00:00:00Z" });
  const one = (ops: Array<Record<string, unknown>>) => {
    m.tables.ads_campaign_binding_details = [bind("c", "7")];
    m.tables.ads_campaign_lifecycle = [life("c", { activation_attempted_at: "2026-10-01T00:00:00Z", stop_requested_at: "2026-10-02T00:00:00Z", stop_confirmed_at: "2026-10-02T00:01:00Z" })];
    m.tables.ads_campaign_operations = ops;
  };
  it("reads Ended after a refresh, not Paused with Review launch, in the same two state reads", async () => {
    one([op("c", "succeeded", "2026-10-01T00:00:10Z"), marker("c")]);
    expect((await statuses()).c).toBe("ENDED");
    expect(m.reads.filter((r) => r.table === "ads_campaign_lifecycle" || r.table === "ads_campaign_operations")).toHaveLength(2);
  });
  it("a cleared record reads Paused again, so a campaign LinkedIn answered for can be relaunched", async () => {
    one([op("c", "succeeded", "2026-10-01T00:00:10Z"), marker("c", "refused")]);
    expect((await statuses()).c).toBe("PAUSED");
  });
  it("a first 404 still being checked is not Ended, and its stop reads as unknown", async () => {
    one([op("c", "succeeded", "2026-10-01T00:00:10Z"), { campaign_binding_id: "c", tenant_id: "tenant-a", kind: "pause", status: "refused", updated_at: "2026-10-03T00:00:00Z" }]);
    m.tables.ads_campaign_lifecycle[0].stop_confirmed_at = null;
    expect((await statuses()).c).toBe("absent");
  });
  it("a launch still unresolved outranks an old record", async () => {
    one([op("c", "uncertain", "2026-10-05T00:00:10Z"), marker("c")]);
    expect((await statuses()).c).toBe("absent");
  });
  it("another tenant's record never marks this tenant's campaign", async () => {
    one([op("c", "succeeded", "2026-10-01T00:00:10Z"), { ...marker("c"), tenant_id: "tenant-b" }]);
    expect((await statuses()).c).toBe("PAUSED");
  });
});
describe("a stop on a campaign whose end date has passed", () => {
  const END = Date.parse("2026-10-10T00:00:00.000Z");
  const one = (stop: string, end: unknown) => {
    m.tables.ads_campaign_binding_details = [bind("c", "7")];
    m.tables.ads_campaign_lifecycle = [life("c", { activation_attempted_at: "2026-10-01T00:00:00Z", stop_requested_at: stop, stop_confirmed_at: new Date(Date.parse(stop) + 1000).toISOString() })];
    m.tables.ads_campaign_operations = [{ ...op("c", "succeeded", "2026-10-01T00:00:10Z"), end_time: end }];
  };
  it.each([
    ["after the end date", "2026-10-11T00:00:00.000Z", "ENDED"],
    ["exactly at the end date", "2026-10-10T00:00:00.000Z", "ENDED"],
    ["one millisecond before the end date", "2026-10-09T23:59:59.999Z", "PAUSED"],
  ])("requested %s reads as it was: pressing Pause on an Ended row stays Ended", async (_label, stop, want) => {
    one(stop, String(END));
    expect((await statuses()).c).toBe(want);
  });
  it.each([[undefined], [null], ["not-a-time"]])("an end_time of %s stays Paused rather than a guessed Ended", async (end) => {
    one("2026-10-11T00:00:00.000Z", end);
    expect((await statuses()).c).toBe("PAUSED");
  });
  it("the latest activate's end date decides: a relaunch with a later end, stopped before it, is Paused", async () => {
    one("2026-10-20T00:00:00.000Z", String(END));
    m.tables.ads_campaign_operations.push({ ...op("c", "succeeded", "2026-10-15T00:00:00Z"), end_time: String(Date.parse("2026-11-01T00:00:00Z")) });
    expect((await statuses()).c).toBe("PAUSED");
  });
});
describe("a launched campaign's end date", () => {
  const NOW = Date.parse("2026-10-20T12:00:00.000Z");
  const opEnd = (id: string, updated_at: string, end_time: unknown, status = "succeeded") => ({ ...op(id, status, updated_at), end_time });
  const oneCampaign = (ops: Array<Record<string, unknown>>, lifecycle: Record<string, unknown> = {}) => {
    m.tables.ads_campaign_binding_details = [bind("c", "7")];
    m.tables.ads_campaign_lifecycle = [life("c", { activation_attempted_at: "2026-10-01T00:00:00Z", ...lifecycle })];
    m.tables.ads_campaign_operations = ops;
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it.each([
    ["one millisecond before now", "ENDED", NOW - 1],
    ["exactly now, as the pause path counts it", "ENDED", NOW],
    ["one millisecond after now", "ACTIVE", NOW + 1],
  ])("an activate op whose end_time is %s reads %s, with no LinkedIn call", async (_label, want, end) => {
    oneCampaign([opEnd("c", "2026-10-01T00:00:10Z", String(end))]);
    expect((await statuses()).c).toBe(want);
    expect(m.linkedin).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("reads the end date from the operation's own payload", async () => {
    oneCampaign([opEnd("c", "2026-10-01T00:00:10Z", String(NOW - 1))]);
    await statuses();
    expect(m.reads.find((r) => r.table === "ads_campaign_operations")!.columns).toContain("end_time:payload->>end_time");
  });
  it("the latest activate decides, whichever order the rows come back in: a relaunch with a later end is live again", async () => {
    oneCampaign([opEnd("c", "2026-10-15T00:00:00Z", String(NOW + 86400000)), opEnd("c", "2026-10-01T00:00:00Z", String(NOW - 86400000))]);
    expect((await statuses()).c).toBe("ACTIVE");
    oneCampaign([opEnd("c", "2026-10-01T00:00:00Z", String(NOW - 86400000)), opEnd("c", "2026-10-15T00:00:00Z", String(NOW + 86400000))]);
    expect((await statuses()).c).toBe("ACTIVE");
  });
  it("an earlier long flight does not keep a later, already finished activate live", async () => {
    oneCampaign([opEnd("c", "2026-10-01T00:00:00Z", String(NOW + 86400000)), opEnd("c", "2026-10-15T00:00:00Z", String(NOW - 1000))]);
    expect((await statuses()).c).toBe("ENDED");
  });
  it.each([[undefined], [null], ["not-a-time"]])("an end_time of %s stays Live rather than a guessed Ended", async (end) => {
    oneCampaign([opEnd("c", "2026-10-01T00:00:10Z", end)]);
    expect((await statuses()).c).toBe("ACTIVE");
  });
  it("a passed end date never claims Ended for an unconfirmed launch or an unconfirmed stop", async () => {
    oneCampaign([opEnd("c", "2026-10-01T00:00:10Z", String(NOW - 1), "uncertain")]);
    expect((await statuses()).c).toBe("absent");
    oneCampaign([opEnd("c", "2026-10-01T00:00:10Z", String(NOW - 1))], { stop_requested_at: "2026-10-02T00:00:00Z" });
    expect((await statuses()).c).toBe("absent");
  });
  it("a confirmed pause stays Paused after its end date, so the founder can still relaunch it", async () => {
    oneCampaign([opEnd("c", "2026-10-01T00:00:10Z", String(NOW - 1))], { stop_requested_at: "2026-10-02T00:00:00Z", stop_confirmed_at: "2026-10-02T00:01:00Z" });
    expect((await statuses()).c).toBe("PAUSED");
  });
});
describe("a campaign that ended at LinkedIn before its end date", () => {
  const FUTURE = String(Date.parse("2099-01-01T00:00:00.000Z"));
  const stoppedRow = (id: string) => {
    m.tables.ads_campaign_lifecycle.push(life(id, { activation_attempted_at: "2026-10-01T00:00:00Z", stop_requested_at: "2026-10-05T00:00:00Z", stop_confirmed_at: "2026-10-05T00:00:01Z" }));
    m.tables.ads_campaign_operations.push({ ...op(id, "succeeded", "2026-10-01T00:00:10Z"), end_time: FUTURE });
  };
  beforeEach(() => {
    m.tables.ads_campaign_binding_details = [bind("c", "7")];
    m.tables.ads_campaign_lifecycle = [];
    m.tables.ads_campaign_operations = [];
    stoppedRow("c");
  });
  it.each(["COMPLETED", "CANCELED", "ARCHIVED", "PENDING_DELETION", "REMOVED"])("%s still reads Ended after a refresh, with no end date passed", async (status) => {
    m.live.mockResolvedValue({ campaign: { status } });
    expect((await statuses()).c).toBe("ENDED");
    expect(m.live).toHaveBeenCalledWith("tenant-a", "c");
  });
  it("a campaign LinkedIn still has paused stays Paused, so it can be relaunched", async () => {
    m.live.mockResolvedValue({ campaign: { status: "PAUSED" } });
    expect((await statuses()).c).toBe("PAUSED");
  });
  it.each([
    ["serving", { status: "ACTIVE", servingStatuses: ["RUNNABLE"] }, "ACTIVE"],
    ["with no serving list", { status: "ACTIVE" }, "ACTIVE"],
    ["held for something else", { status: "ACTIVE", servingStatuses: ["BILLING_HOLD"] }, "ACTIVE"],
    ["out of its total budget", { status: "ACTIVE", servingStatuses: ["CAMPAIGN_TOTAL_BUDGET_HOLD"] }, "OUT_OF_BUDGET"],
    ["with its end date still ahead", { status: "ACTIVE", runSchedule: { end: Date.parse("2099-01-01T00:00:00Z") } }, "ACTIVE"],
  ])("a confirmed pause undone in Campaign Manager reads as LinkedIn has it: %s", async (_label, campaign, expected) => {
    m.live.mockResolvedValue({ campaign });
    expect((await statuses()).c).toBe(expected);
  });
  it("a confirmed pause on a campaign Zavi never launched, turned on in Campaign Manager, is not shown paused", async () => {
    m.tables.ads_campaign_lifecycle = [life("c", { stop_requested_at: "2026-10-05T00:00:00Z", stop_confirmed_at: "2026-10-05T00:00:01Z" })];
    m.tables.ads_campaign_operations = [];
    m.live.mockResolvedValue({ campaign: { status: "ACTIVE" } });
    expect((await statuses()).c).toBe("ACTIVE");
  });
  it("ACTIVE at LinkedIn after its own end date cannot serve, so the stored Paused stands and it can be relaunched", async () => {
    m.live.mockResolvedValue({ campaign: { status: "ACTIVE", runSchedule: { end: Date.now() - 1000 } } });
    expect((await statuses()).c).toBe("PAUSED");
  });
  it("an ACTIVE read for one campaign leaves another stopped campaign's failed read Paused", async () => {
    m.tables.ads_campaign_binding_details = [bind("c", "7"), bind("d", "8")];
    stoppedRow("d");
    m.live.mockImplementation(async (_t: string, id: string) => {
      if (id === "c") return { campaign: { status: "ACTIVE" } };
      throw new Error("down");
    });
    const s = await statuses();
    expect([s.c, s.d]).toEqual(["ACTIVE", "PAUSED"]);
  });
  it("a LinkedIn read that fails keeps Paused and the list still loads", async () => {
    m.live.mockRejectedValue(new Error("down"));
    expect((await statuses()).c).toBe("PAUSED");
    expect(m.error).not.toHaveBeenCalled();
  });
  it("a campaign that never launched spends no LinkedIn read", async () => {
    m.tables.ads_campaign_lifecycle = [life("c")];
    m.tables.ads_campaign_operations = [];
    await statuses();
    expect(m.live).not.toHaveBeenCalled();
  });
  it("a long list cannot fan out past the read cap", async () => {
    m.tables.ads_campaign_binding_details = Array.from({ length: 30 }, (_, i) => bind(`c${i}`, String(1000 + i)));
    m.tables.ads_campaign_lifecycle = [];
    m.tables.ads_campaign_operations = [];
    for (let i = 0; i < 30; i++) stoppedRow(`c${i}`);
    await statuses();
    expect(m.live.mock.calls.length).toBe(20);
  });
});
describe("a campaign Zavi launched that LinkedIn has stopped since", () => {
  const FUTURE = String(Date.parse("2099-01-01T00:00:00.000Z"));
  const liveRow = (id: string) => {
    m.tables.ads_campaign_lifecycle.push(life(id, { activation_attempted_at: "2026-10-01T00:00:00Z" }));
    m.tables.ads_campaign_operations.push({ ...op(id, "succeeded", "2026-10-01T00:00:10Z"), end_time: FUTURE });
  };
  beforeEach(() => {
    m.tables.ads_campaign_binding_details = [bind("c", "7")];
    m.tables.ads_campaign_lifecycle = [];
    m.tables.ads_campaign_operations = [];
    liveRow("c");
  });
  it.each([
    ["paused in Campaign Manager", { status: "PAUSED" }, "PAUSED"],
    ["put back to draft", { status: "DRAFT" }, "PAUSED"],
    ["completed early", { status: "COMPLETED" }, "ENDED"],
    ["out of its total budget", { status: "ACTIVE", servingStatuses: ["CAMPAIGN_TOTAL_BUDGET_HOLD"] }, "OUT_OF_BUDGET"],
    ["out of its group's budget", { status: "ACTIVE", servingStatuses: ["CAMPAIGN_GROUP_TOTAL_BUDGET_HOLD", "STOPPED"] }, "OUT_OF_BUDGET"],
    ["running", { status: "ACTIVE", servingStatuses: ["RUNNABLE"] }, "ACTIVE"],
    ["running with no serving list", { status: "ACTIVE" }, "ACTIVE"],
    ["held for something else", { status: "ACTIVE", servingStatuses: ["BILLING_HOLD"] }, "ACTIVE"],
  ])("%s, before its end date, reads as LinkedIn has it", async (_label, campaign, expected) => {
    m.live.mockResolvedValue({ campaign });
    expect((await statuses()).c).toBe(expected);
  });
  it("a failed LinkedIn read keeps the stored state and the list still loads", async () => {
    m.live.mockRejectedValue(new Error("down"));
    expect((await statuses()).c).toBe("ACTIVE");
    expect(m.error).not.toHaveBeenCalled();
  });
  it("a campaign whose stored end date has passed spends no read", async () => {
    m.tables.ads_campaign_operations = [{ ...op("c", "succeeded", "2026-10-01T00:00:10Z"), end_time: "1000" }];
    expect((await statuses()).c).toBe("ENDED");
    expect(m.live).not.toHaveBeenCalled();
  });
  it("a budget hold on a stopped campaign does not turn its Paused into Out of budget", async () => {
    m.tables.ads_campaign_lifecycle = [life("c", { activation_attempted_at: "2026-10-01T00:00:00Z", stop_requested_at: "2026-10-05T00:00:00Z", stop_confirmed_at: "2026-10-05T00:00:01Z" })];
    m.live.mockResolvedValue({ campaign: { status: "PAUSED", servingStatuses: ["CAMPAIGN_TOTAL_BUDGET_HOLD"] } });
    expect((await statuses()).c).toBe("PAUSED");
  });
  it("live and stopped campaigns share one cap of 20 reads, newest first", async () => {
    m.tables.ads_campaign_binding_details = Array.from({ length: 30 }, (_, i) => bind(`c${i}`, String(1000 + i)));
    m.tables.ads_campaign_bindings = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, created_at: new Date(Date.UTC(2026, 9, 1, i)).toISOString() }));
    m.tables.ads_campaign_lifecycle = [];
    m.tables.ads_campaign_operations = [];
    for (let i = 0; i < 30; i++) liveRow(`c${i}`);
    await statuses();
    expect(m.live.mock.calls.map((c) => c[1]).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `c${29 - i}`).sort());
  });
  it("makes no LinkedIn read when the change stamp cannot be read, because that read would not be cached", async () => {
    m.tables.ads_campaign_lifecycle = Array.from({ length: 1000 }, (_, i) => life(i ? `x${i}` : "c", { activation_attempted_at: "2026-10-01T00:00:00Z" }));
    expect((await statuses()).c).toBe("ACTIVE");
    expect(m.live).not.toHaveBeenCalled();
  });
});
describe("newest campaign first", () => {
  it("sorts by when the binding was made, tenant scoped, and keeps every row", async () => {
    m.tables.ads_campaign_binding_details = [bind("old", "1"), bind("new", "2"), bind("mid", "3")];
    m.tables.ads_campaign_bindings = [{ id: "old", created_at: "2026-10-01T00:00:00Z" }, { id: "new", created_at: "2026-10-20T00:00:00Z" }, { id: "mid", created_at: "2026-10-10T00:00:00Z" }, { id: "x", tenant_id: "tenant-b", created_at: "2099-01-01T00:00:00Z" }];
    const r = res();
    await adsBoundCampaigns(req("linkedin"), r);
    expect(r.json.mock.calls[0][0].campaigns.map((c: { id: string }) => c.id)).toEqual(["new", "mid", "old"]);
  });
  it("sends each campaign's created time, even when the list holds only one", async () => {
    m.tables.ads_campaign_binding_details = [bind("only", "1")];
    m.tables.ads_campaign_bindings = [{ id: "only", created_at: "2026-10-01T00:00:00Z" }];
    const r = res();
    await adsBoundCampaigns(req("linkedin"), r);
    expect(r.json.mock.calls[0][0].campaigns[0].created_at).toBe("2026-10-01T00:00:00Z");
  });
  it("the 500-row inventory check still refuses a list it cannot see whole", async () => {
    m.tables.ads_campaign_binding_details = Array.from({ length: 500 }, (_, i) => bind(`b${i}`, String(i)));
    const r = res();
    await adsBoundCampaigns(req("linkedin"), r);
    expect(r.json).not.toHaveBeenCalled();
    expect(m.error).toHaveBeenCalled();
  });
});
describe("campaigns on an own LinkedIn account the workspace stopped or replaced", () => {
  const own = (id: string, extra: Record<string, unknown> = {}) => ({ id, tenant_id: "tenant-a", platform: "linkedin", provider_account_id: `acct-${id}`, funding_source: "provider", credential_tenant_id: null, ...extra });
  const camp = (id: string, account: string, funding = "provider") => ({ id, platform: "linkedin", provider_campaign_id: `p-${id}`, account_binding_id: account, funding_source: funding, tenant_id: "tenant-a" });
  const listing = async () => {
    const r = res();
    await adsBoundCampaigns(req("linkedin"), r);
    expect(m.error).not.toHaveBeenCalled();
    return Object.fromEntries((r.json.mock.calls[0]![0] as { campaigns: Array<{ id: string; pause_only?: boolean }> }).campaigns.map((c) => [c.id, c.pause_only ?? false]));
  };
  beforeEach(() => {
    m.tables.ads_account_binding_details = [
      { id: "a", tenant_id: "tenant-a", platform: "linkedin", provider_account_id: null, funding_source: "wallet" },
      own("old"),
      own("new"),
      own("borrowed", { credential_tenant_id: "tenant-b" }),
      own("theirs", { tenant_id: "tenant-b" }),
    ];
    m.tables.ads_campaign_binding_details = [camp("on-old", "old"), camp("on-old-ended", "old"), camp("on-new", "new"), camp("on-wallet", "a", "wallet"), camp("on-borrowed", "borrowed"), { ...camp("on-theirs", "theirs"), tenant_id: "tenant-b" }];
    m.tables.ads_campaign_lifecycle = [life("on-old"), life("on-old-ended", { activation_attempted_at: "2026-10-01T00:00:00Z", stop_requested_at: "2026-10-02T00:00:00Z", stop_confirmed_at: "2026-10-02T00:01:00Z" }), life("on-new"), life("on-wallet"), life("on-borrowed")];
    m.tables.ads_campaign_operations = [op("on-old-ended", "succeeded", "2026-10-01T00:00:10Z"), { campaign_binding_id: "on-old-ended", tenant_id: "tenant-a", kind: "finalize", status: "succeeded", updated_at: "2026-10-03T00:00:00Z" }];
  });
  it("keeps a replaced account's live campaigns listed as pause-only, drops its ended ones, and leaves the new account, wallet and borrowed accounts alone", async () => {
    m.tables.ads_account_selections = [{ platform: "linkedin", account_binding_id: "new", tenant_id: "tenant-a" }];
    expect(await listing()).toEqual({ "on-old": true, "on-new": false, "on-wallet": false });
  });
  it("keeps a stopped account's campaigns listed as pause-only when it is still the selected account", async () => {
    m.tables.ads_account_selections = [{ platform: "linkedin", account_binding_id: "old", tenant_id: "tenant-a" }];
    m.tables.ads_account_binding_status = [{ account_binding_id: "old", disabled_at: "2026-10-05T00:00:00Z" }];
    expect(await listing()).toEqual({ "on-old": true, "on-new": true, "on-wallet": false });
  });
});
