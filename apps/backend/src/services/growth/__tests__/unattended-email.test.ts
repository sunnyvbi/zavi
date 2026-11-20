import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as null | { message: string },
  filters: [] as Array<[string, unknown, unknown?]>,
  rpc: [] as Array<[string, string, Record<string, unknown>]>,
  ledger: null as string | null,
  rpcError: null as null | { message: string },
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (tenant: string, name: string, args: Record<string, unknown>) => {
    db.rpc.push([tenant, name, args]);
    return db.rpcError ? { data: null, error: db.rpcError } : { data: db.ledger, error: null };
  },
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      db.filters.push(["from", table, tenant]);
      for (const k of ["select", "eq", "in", "or"]) q[k] = (a: unknown, b: unknown) => (db.filters.push([k, a, b]), q);
      q.limit = async () => ({ data: db.error ? null : db.rows, error: db.error });
      return q;
    },
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import {
  AUTOPILOT_MAX_RECIPIENTS,
  authorizeUnattendedEmail,
  emailAudienceKey,
  evaluateUnattendedEmail,
  heldEmailAsk,
  loadCgoEmailSendRecently,
  type UnattendedEmailDeps,
  type UnattendedEmailFacts,
} from "../unattended-email";

const ok: UnattendedEmailFacts = { autopilot_on: true, channel_autorun_on: true, audience_count: 800, cgo_sent_to_audience_within_7d: false };
const NOW = new Date("2026-10-07T12:00:00Z");
const payload = (over: Record<string, unknown> = {}) => ({ tool: "mailchimp", connected_account_id: "ca-1", audience_id: "L1", ...over });
const KEY = "mailchimp:L1";
const histRow = (over: Record<string, unknown> = {}) => ({ id: "other", exec_payload: payload(), exec_status: "executed", exec_progress: { campaign_id: "c", stage: "sent" }, ...over });

beforeEach(() => {
  db.rows = [];
  db.error = null;
  db.filters = [];
  db.rpc = [];
  db.ledger = null;
  db.rpcError = null;
});

describe("evaluateUnattendedEmail", () => {
  it("allows 800 people with Autopilot and the channel switch on and no recent send", () => {
    expect(evaluateUnattendedEmail(ok)).toEqual({ verdict: "allow", reasons: [] });
  });

  it("exactly 1,000 people is allowed; 1,001 is not", () => {
    expect(evaluateUnattendedEmail({ ...ok, audience_count: AUTOPILOT_MAX_RECIPIENTS }).verdict).toBe("allow");
    expect(evaluateUnattendedEmail({ ...ok, audience_count: AUTOPILOT_MAX_RECIPIENTS + 1 })).toEqual({ verdict: "ask_founder", reasons: ["audience_over_limit"] });
  });

  const held: Array<[string, Partial<UnattendedEmailFacts>, string]> = [
    ["Autopilot off", { autopilot_on: false }, "autopilot_off"],
    ["the channel is not set to run on its own", { channel_autorun_on: false }, "channel_autorun_off"],
    ["a cgo send to the same list in the last 7 days", { cgo_sent_to_audience_within_7d: true }, "sent_to_list_recently"],
    ["Autopilot setting unreadable", { autopilot_on: null }, "autopilot_unreadable"],
    ["channel switch unreadable", { channel_autorun_on: null }, "channel_autorun_unreadable"],
    ["list size unreadable", { audience_count: null }, "audience_count_unreadable"],
    ["send history unreadable", { cgo_sent_to_audience_within_7d: null }, "send_history_unreadable"],
  ];
  for (const [name, fact, reason] of held) {
    it(`${name}: the founder decides`, () => {
      expect(evaluateUnattendedEmail({ ...ok, ...fact })).toEqual({ verdict: "ask_founder", reasons: [reason] });
    });
  }

  it("the founder is told why in plain words", () => {
    expect(heldEmailAsk(["audience_over_limit"])).toBe("Autopilot did not send this on its own: it would go to more than 1,000 people. Nothing was sent. Send it yourself if you agree.");
    expect(heldEmailAsk(["sent_to_list_recently"])).toContain("this list already got an email in the last 7 days");
    expect(heldEmailAsk(["send_history_unreadable"])).toContain("could not check its limits");
  });
});

describe("the list key", () => {
  it("is the tool and the list, never the connection (a reconnect keeps the same list)", () => {
    expect(emailAudienceKey(payload())).toBe(KEY);
    expect(emailAudienceKey(payload({ connected_account_id: "ca-after-reconnect" }))).toBe(KEY);
    expect(emailAudienceKey(payload({ tool: "klaviyo" }))).toBe("klaviyo:L1");
    expect(emailAudienceKey({ tool: "mailchimp" })).toBeNull();
    expect(emailAudienceKey(null)).toBeNull();
  });
});

describe("loadCgoEmailSendRecently (the send ledger, H1)", () => {
  it("asks the ledger for this tenant's list, excluding the card being judged", async () => {
    await loadCgoEmailSendRecently("tenant-a", KEY, "self", NOW);
    expect(db.rpc).toEqual([["tenant-a", "email_list_sent_recently", { p_key: KEY, p_except_rail: "channel_actions", p_except_id: "self" }]]);
  });

  it("must catch: ANY send to the list counts (a founder's tap too), not only Autopilot's", async () => {
    db.ledger = "2026-10-06T12:00:00Z";
    expect(await loadCgoEmailSendRecently("t", KEY, "self", NOW)).toBe(true);
    db.ledger = null;
    expect(await loadCgoEmailSendRecently("t", KEY, "self", NOW)).toBe(false);
  });

  it("throws when the ledger cannot be read (the caller asks the founder)", async () => {
    db.rpcError = { message: "boom" };
    await expect(loadCgoEmailSendRecently("t", KEY, "self", NOW)).rejects.toThrow("email_list_sent_recently failed");
  });
});

describe("authorizeUnattendedEmail", () => {
  const action = { action_id: "self", exec_class: "email_campaign.create_and_send", payload: payload(), audience_count: 800 };
  const deps = (over: Partial<UnattendedEmailDeps> = {}): Partial<UnattendedEmailDeps> => ({
    autopilotOn: async () => true,
    channelAutorunOn: async () => true,
    sentRecently: async () => false,
    now: () => NOW,
    ...over,
  });

  it("allows when every fact reads clean", async () => {
    expect(await authorizeUnattendedEmail("t", action, { where: "door", deps: deps() })).toEqual({ verdict: "allow", reasons: [] });
  });

  it("holds when the list has 1,001 people now", async () => {
    expect((await authorizeUnattendedEmail("t", { ...action, audience_count: 1001 }, { where: "executor", deps: deps() })).reasons).toEqual(["audience_over_limit"]);
  });

  it("holds when cgo sent to this list 3 days ago", async () => {
    const sentRecently = vi.fn(async () => true);
    const v = await authorizeUnattendedEmail("t", action, { where: "door", deps: deps({ sentRecently }) });
    expect(v).toEqual({ verdict: "ask_founder", reasons: ["sent_to_list_recently"] });
    expect(sentRecently).toHaveBeenCalledWith("t", KEY, "self", NOW);
  });

  it("holds when a fact read throws: never allow on a guess", async () => {
    const boom = async (): Promise<boolean> => {
      throw new Error("db down");
    };
    expect((await authorizeUnattendedEmail("t", action, { where: "door", deps: deps({ autopilotOn: boom }) })).reasons).toEqual(["autopilot_unreadable"]);
    expect((await authorizeUnattendedEmail("t", action, { where: "door", deps: deps({ channelAutorunOn: boom }) })).reasons).toEqual(["channel_autorun_unreadable"]);
    expect((await authorizeUnattendedEmail("t", action, { where: "door", deps: deps({ sentRecently: boom }) })).reasons).toEqual(["send_history_unreadable"]);
  });

  it("holds when the ledger cannot be read", async () => {
    db.rpcError = { message: "down" };
    const v = await authorizeUnattendedEmail("t", action, { where: "door", deps: deps({ sentRecently: loadCgoEmailSendRecently }) });
    expect(v).toEqual({ verdict: "ask_founder", reasons: ["send_history_unreadable"] });
  });

  it("holds with Autopilot off, and with the channel switch off", async () => {
    expect((await authorizeUnattendedEmail("t", action, { where: "door", deps: deps({ autopilotOn: async () => false }) })).reasons).toEqual(["autopilot_off"]);
    expect((await authorizeUnattendedEmail("t", action, { where: "door", deps: deps({ channelAutorunOn: async () => false }) })).reasons).toEqual(["channel_autorun_off"]);
  });

  it("holds a class that is not an email send, and a payload that names no list", async () => {
    expect((await authorizeUnattendedEmail("t", { ...action, exec_class: "meta_ads.set_status" }, { where: "door", deps: deps() })).verdict).toBe("ask_founder");
    expect((await authorizeUnattendedEmail("t", { ...action, payload: {} }, { where: "door", deps: deps() })).verdict).toBe("ask_founder");
  });
});
