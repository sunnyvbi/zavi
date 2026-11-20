import { beforeEach, describe, expect, it, vi } from "vitest";

const sg = vi.hoisted(() => ({ account: null as null | { api_key: string; key_digest: string }, needsPermissions: false }));
vi.mock("@/services/connectors/email-campaign/sendgrid-account", () => ({
  resolveSendgridAccount: async () => sg.account,
  sendgridKeyNeedsPermissions: async () => sg.needsPermissions,
}));
vi.mock("@/services/tenant-client", () => ({ staffCrossTenantClient: () => ({}), tenantRpc: async () => ({}), tenantClient: () => ({}), asTenantId: (t: string) => t }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));

import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { BRIGHTLOOP_KEY, fakeSendgrid, type FakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";
import { liveCheckDeps, runEmailResultsPass, type CheckDeps, type ClaimedTask, type Completion, type ProviderAccess } from "../check";
import { firstNumbersText, listSentEmailsPage, rowFromResult } from "../view";

const T = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-20T12:00:00Z");
const TITLE = "Zavi card c1";

const task = (over: Partial<ClaimedTask> = {}): ClaimedTask => ({
  task_id: "task-1", lease_token: "lease", tenant_id: T, source: "provider", stage: "h1", state: "pending", attempts: 0, group_key: "g", give_up_at: "2026-10-30T00:00:00Z",
  result_id: "r1", rail: "channel_actions", card_id: "c1", route: "sendgrid", provider_ref: "ss-1", account_ref: { kind: "sendgrid_key", key_digest: "old" }, campaign_title: TITLE, campaign_slug: null,
  started_at: "2026-10-20T10:00:00Z", finished_at: "2026-10-20T10:00:00Z", ga_property_id: null, ga_timezone: null, ...over,
});

async function pass(providerAccess: CheckDeps["providerAccess"], t: ClaimedTask = task()): Promise<Completion> {
  const done: Completion[] = [];
  await runEmailResultsPass({
    claim: async () => [t],
    complete: async (_t, c) => { done.push(c); },
    providerAccess,
    bulkCounts: async () => null, gaCreds: async () => null, gaReport: async () => ({}), missing: async () => [], start: async () => ({ started: false }),
    holdRepair: async () => undefined, backlog: async () => ({ due: 0, oldest_due_at: null, newly_stuck: [] }), purgeEventIds: async () => 0, alertStuck: async () => undefined,
    log: async () => undefined, now: () => NOW,
  } as CheckDeps);
  return done[0];
}

function sendgridWith(title: string, numbers = true): FakeSendgrid {
  const f = fakeSendgrid();
  f.sends.push({ id: "ss-1", name: title } as FakeSendgrid["sends"][number]);
  if (numbers) f.stats["ss-1"] = { requests: 5, delivered: 4, unique_opens: 2, unique_clicks: 1, unsubscribes: 0 };
  return f;
}

const access = (f: FakeSendgrid, key: string, sameCredential: boolean): ProviderAccess => ({ kind: "ok", call: sendgridHttpCall(key, f.fetch), sameCredential, cacheKey: "sendgrid:k" });

describe("a SendGrid 1-hour read after the key changed", () => {
  it("reads through the connected key when the sealed key differs and the Single Send is ours", async () => {
    const f = sendgridWith(TITLE);
    const c = await pass(async () => access(f, BRIGHTLOOP_KEY, false));
    expect(c.outcome).toBe("done");
    expect(c.result).toMatchObject({ recipients: 5, delivered: 4, opens: 2, clicks: 1 });
  });

  it("the send's own key since deleted in SendGrid, still saved here: 401 retries, not a disconnect", async () => {
    const f = sendgridWith(TITLE);
    const c = await pass(async () => access(f, "SG.deletedKey", true));
    expect(c.outcome).toBe("retry");
    expect(c.note).toBeUndefined();
  });

  it("a new key that SendGrid refuses during the proof read retries, not a disconnect", async () => {
    const f = sendgridWith(TITLE);
    const c = await pass(async () => access(f, "SG.deletedKey", false));
    expect(c.outcome).toBe("retry");
  });

  it("a key on another SendGrid account really is a different account", async () => {
    const f = fakeSendgrid();
    const c = await pass(async () => access(f, BRIGHTLOOP_KEY, false));
    expect(c).toMatchObject({ outcome: "disconnected", error: "different account" });
  });

  it("a saved key short of campaign permissions is not a disconnect: the task retries and can still recover", async () => {
    sg.account = null;
    sg.needsPermissions = true;
    const deps = await liveCheckDeps();
    const c = await pass(deps.providerAccess);
    expect(c.outcome).toBe("retry");
    expect(c.error).toMatch(/missing campaign permissions/);
  });

  it("no saved key at all is still a proven disconnect", async () => {
    sg.account = null;
    sg.needsPermissions = false;
    const deps = await liveCheckDeps();
    expect((await pass(deps.providerAccess)).outcome).toBe("disconnected");
  });
});

const record = (over: Record<string, unknown> = {}) =>
  ({
    rail: "channel_actions", card_id: "c1", route: "sendgrid", subject: "Hi", list_id: "L", list_name: "Everyone", campaign_slug: null, shared_tag: false, sent_count: 40, total_count: 40,
    started_at: "2026-10-20T11:30:00Z", finished_at: "2026-10-20T11:30:00Z", win_line: {}, h1: {}, d7: {}, d7_published_at: null, verdict: null, note: null, ...over,
  }) as Parameters<typeof rowFromResult>[0];

describe("the first hour after a send", () => {
  beforeEach(() => {
    sg.account = null;
    sg.needsPermissions = false;
  });

  it("says when the numbers arrive, in the workspace's zone, and never shows the accepted count as emailed", () => {
    const r = rowFromResult(record(), Date.parse("2026-10-20T12:00:00Z"), "America/New_York");
    expect(r.stage).toBe("h1_due");
    expect(r.people.sent).toBeNull();
    for (const c of [r.delivered, r.opens, r.clicks, r.unsubscribes]) expect(c).toEqual({ value: null, why: "First numbers around 8:30 AM" });
  });

  it("past the due time it says Reading now, at the exact second", () => {
    const due = Date.parse("2026-10-20T12:30:00Z");
    expect(firstNumbersText("2026-10-20T11:30:00Z", due - 1000, "UTC")).toBe("First numbers around 12:30 PM");
    expect(firstNumbersText("2026-10-20T11:30:00Z", due, "UTC")).toBe("Reading now");
    expect(rowFromResult(record(), due + 5 * 3_600_000).opens.why).toBe("Reading now");
  });

  it("once the 1-hour read is in, the wait line is gone", () => {
    const r = rowFromResult(record({ h1: { recipients: 5, delivered: 4, opens: 1, clicks: null, provider_status: "ok" } }), Date.parse("2026-10-20T13:00:00Z"));
    expect(r.stage).toBe("h1");
    expect(r.clicks.why).toBe("SendGrid does not report this");
    expect(r.people.sent).toBe(5);
  });

  it("Zavi's own sender keeps its click-tracking note while it waits", () => {
    const r = rowFromResult(record({ route: "zavi_list", rail: "decisions" }), Date.parse("2026-10-20T12:00:00Z"));
    expect(r.clicks.why).toMatch(/Click tracking is off/);
    expect(r.opens.why).toBe("First numbers around 12:30 PM");
  });
});

describe("every row carries the workspace's zone", () => {
  it("a finished send and one still going both do", async () => {
    const going = { decision_id: "d1", status: "sending", hold_reason: null, sent: 1, total: 2, created_at: "2026-10-20T11:00:00Z", subject: "Hi", list_id: null, list_name: null };
    const page = await listSentEmailsPage("t1", 10, { results: async () => [record()], inFlight: async () => [going], holds: async () => [], zone: async () => "Asia/Tokyo" });
    expect(page.emails.map((e) => e.timezone)).toEqual(["Asia/Tokyo", "Asia/Tokyo"]);
  });
});
