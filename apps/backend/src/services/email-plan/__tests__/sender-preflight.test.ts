import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sender: { ok: true } as { ok: true } | { ok: false; code: string; sentence: string },
  senderCalls: 0,
  capRows: 0,
  item: null as null | { route: string; list_id: string; status: string; card_id: string | null },
  summaries: [] as Array<{ id: string; name: string; active: { sendable: number } | null; needs_consent: boolean }>,
  connected: new Set<string>(),
}));

vi.mock("@/services/comms/bulk-outbound/readiness", async (orig) => {
  const real = await orig<typeof import("@/services/comms/bulk-outbound/readiness")>();
  return {
    ...real,
    checkBulkSender: async () => {
      h.senderCalls += 1;
      return h.sender;
    },
  };
});
vi.mock("@/services/tenant-client", () => {
  const client = () => {
    const q: Record<string, unknown> = {};
    let table = "";
    q.from = (t: string) => {
      table = t;
      return q;
    };
    for (const k of ["select", "eq", "gt", "order"]) q[k] = () => q;
    q.limit = async () => (table === "email_card_reservations" ? { data: Array.from({ length: h.capRows }, (_, i) => ({ id: `r${i}` })), error: null } : { data: [], error: null });
    q.maybeSingle = async () => (table === "email_planned_sends" ? { data: h.item, error: null } : { data: null, error: null });
    return q;
  };
  return {
    asTenantId: (t: string) => t,
    tenantClient: client,
    tenantRpc: async () => {
      throw new Error("unexpected live rpc");
    },
    staffCrossTenantClient: client,
  };
});
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/../workers/client", () => ({ inngest: { send: async () => undefined } }));
vi.mock("@/../workers/functions/cron-match", () => ({ nextLocalCronFire: () => null }));
vi.mock("@/services/analytics/tenant-timezone", () => ({ resolveReportingTimezone: async () => ({ tz: "UTC", source: "default" }) }));
vi.mock("@/services/growth/channel-autorun", () => ({ readAutopilotState: async () => ({ enabled: true }) }));
vi.mock("@/services/email-cards/pause", () => ({ emailSendPaused: async () => false }));
vi.mock("@/services/email-cards/variants", async (orig) => ({
  ...(await orig<typeof import("@/services/email-cards/variants")>()),
  readTestListKeys: async () => new Set<string>(),
}));
vi.mock("@/services/comms/bulk-outbound/lists", () => ({ listSummaries: async () => h.summaries }));
vi.mock("@/services/connectors/email-campaign/account", () => ({
  resolveEmailTool: async (_t: string, tool: string) => {
    if (!h.connected.has(tool)) throw new Error("not connected");
    return { tool };
  },
  accountCall: () => null,
}));
vi.mock("@/services/email-test-lists/lists", () => ({
  liveToolCaller: async () => null,
  readToolLists: async () => ({ status: "complete", lists: [{ id: "m1", name: "Customers", member_count: 10 }], error: null }),
}));

import { runDraft, type PassDeps, type PlanJob } from "../pass";
import { livePlanPassDeps, weeklyBlock } from "../live";
import { livePlanList } from "../plan";
import { draftBlocker } from "../draft-blocker";

const T = "tenant-northwind";
const ITEM = "11111111-1111-4111-8111-111111111111";
const LIST = "AAAAAAAA-0000-4000-8000-000000000001";
const STOPPED = { ok: false as const, code: "bulk_sending_paused", sentence: "Zavi's own sender is stopped for every workspace right now." };
const HOLD = { ok: false as const, code: "bulk_abuse_hold", sentence: "Bulk email is paused for this workspace because too many people marked a recent email as spam or it bounced." };

const job: PlanJob = { id: "job-draft", tenant_id: T, item_id: ITEM, kind: "draft", job_key: `draft:${ITEM}:v3`, lease_token: "lease-1", attempts: 1 };

const BEGUN = { ok: true, attempt: 1, version: 3, route: "zavi_list", list_id: LIST, list_name: "Customers", planned_at: "2026-10-21T16:00:00Z", planned_tz: "UTC", angle: "Spring sale" };

async function harness(rpcs: Record<string, unknown> = {}) {
  const live = await livePlanPassDeps();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const startRun = vi.fn(async () => ({ ok: true, run_id: "run-1" }));
  const deps: PassDeps = {
    ...live,
    rpc: (async (_t: string, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name in rpcs) return rpcs[name];
      if (name === "begin_email_plan_draft") return BEGUN;
      return { ok: true };
    }) as PassDeps["rpc"],
    startRun,
    lastDraftRun: async () => null,
    log: () => {},
  };
  return { deps, calls, startRun, names: () => calls.map((c) => c.name) };
}

beforeEach(() => {
  h.sender = { ok: true };
  h.senderCalls = 0;
  h.capRows = 0;
  h.item = { route: "zavi_list", list_id: LIST, status: "planned", card_id: null };
  h.summaries = [];
  h.connected = new Set();
});

describe("a planned draft does not start a paid run when Zavi's own sender cannot send", () => {
  it("global stop: no begin (no attempt spent), no run, no credits; it comes back later", async () => {
    h.sender = STOPPED;
    const x = await harness();
    expect(await runDraft(job, x.deps)).toBe("retry");
    expect(x.names()).not.toContain("begin_email_plan_draft");
    expect(x.names()).not.toContain("block_email_plan_draft");
    expect(x.startRun).toHaveBeenCalledTimes(0);
    expect(h.senderCalls).toBe(1);
  });

  it("the same draft runs once the global stop lifts", async () => {
    h.sender = STOPPED;
    const x = await harness();
    expect(await runDraft(job, x.deps)).toBe("retry");
    h.sender = { ok: true };
    expect(await runDraft(job, x.deps)).toBe("poll");
    expect(x.names().filter((n) => n === "begin_email_plan_draft")).toHaveLength(1);
    expect(x.startRun).toHaveBeenCalledTimes(1);
  });

  it("abuse hold: the item is blocked with the sender's reason and no run starts", async () => {
    h.sender = HOLD;
    const x = await harness({ block_email_plan_draft: { ok: true, blocked: true } });
    expect(await runDraft(job, x.deps)).toBe("done");
    expect(x.names()).toEqual(["block_email_plan_draft"]);
    expect(x.calls[0].args).toEqual({ p_id: ITEM, p_job_id: "job-draft", p_lease_token: "lease-1", p_version: 3, p_code: "bulk_abuse_hold" });
    expect(x.startRun).toHaveBeenCalledTimes(0);
  });

  it("abuse hold before any attempt (the block RPC declines): no begin, no run, and the job waits", async () => {
    h.sender = HOLD;
    const x = await harness({ block_email_plan_draft: { ok: true, blocked: false, status: "planned" } });
    expect(await runDraft(job, x.deps)).toBe("retry");
    expect(x.names()).toEqual(["block_email_plan_draft"]);
    expect(x.startRun).toHaveBeenCalledTimes(0);
  });

  it.each(["bulk_outbound_disabled", "sending_domain_not_verified", "postal_address_missing", "bulk_abuse_hold"])(
    "%s on the first try: the draft runs once the sender is fixed",
    async (code) => {
      h.sender = { ok: false, code, sentence: "x" };
      const x = await harness({ block_email_plan_draft: { ok: true, blocked: false, status: "planned" } });
      expect(await runDraft(job, x.deps)).toBe("retry");
      expect(x.startRun).toHaveBeenCalledTimes(0);
      h.sender = { ok: true };
      expect(await runDraft(job, x.deps)).toBe("poll");
      expect(x.names()).toEqual(["block_email_plan_draft", "begin_email_plan_draft"]);
      expect(x.startRun).toHaveBeenCalledTimes(1);
    },
  );

  it("a superseded job whose block is declined closes without a run", async () => {
    h.sender = HOLD;
    const x = await harness({ block_email_plan_draft: { ok: true, blocked: false, reason: "superseded" } });
    expect(await runDraft(job, x.deps)).toBe("done");
    expect(x.names()).toEqual(["block_email_plan_draft"]);
    expect(x.startRun).toHaveBeenCalledTimes(0);
  });

  it("a block declined because the item moved on closes without a run", async () => {
    h.sender = HOLD;
    const x = await harness({ block_email_plan_draft: { ok: true, blocked: false, status: "skipped" } });
    expect(await runDraft(job, x.deps)).toBe("done");
    expect(x.startRun).toHaveBeenCalledTimes(0);
  });

  it("a block RPC that fails closes without a run", async () => {
    h.sender = HOLD;
    const x = await harness({ block_email_plan_draft: { ok: false } });
    expect(await runDraft(job, x.deps)).toBe("done");
    expect(x.startRun).toHaveBeenCalledTimes(0);
  });

  it.each(["bulk_outbound_disabled", "sending_domain_not_verified", "postal_address_missing", "postal_address_placeholder"])("%s blocks without a run", async (code) => {
    h.sender = { ok: false, code, sentence: "x" };
    const x = await harness({ block_email_plan_draft: { ok: true, blocked: true } });
    expect(await runDraft(job, x.deps)).toBe("done");
    expect(x.calls.map((c) => c.args.p_code)).toEqual([code]);
    expect(x.startRun).toHaveBeenCalledTimes(0);
  });

  it("card cap full: retry without spending an attempt, on any route", async () => {
    h.capRows = 20;
    h.item = { route: "mailchimp", list_id: "m1", status: "planned", card_id: null };
    const x = await harness();
    expect(await runDraft(job, x.deps)).toBe("retry");
    expect(x.names()).toEqual([]);
    expect(x.startRun).toHaveBeenCalledTimes(0);
  });

  it("a Mailchimp draft still runs while Zavi's own sender is stopped, without asking the sender", async () => {
    h.sender = STOPPED;
    h.item = { route: "mailchimp", list_id: "m1", status: "planned", card_id: null };
    const x = await harness({ begin_email_plan_draft: { ...BEGUN, route: "mailchimp", list_id: "m1" } });
    expect(await runDraft(job, x.deps)).toBe("poll");
    expect(x.names()).toEqual(["begin_email_plan_draft"]);
    expect(x.startRun).toHaveBeenCalledTimes(1);
    expect(h.senderCalls).toBe(0);
  });

  it("an item that already has a card is left to begin (it skips it) without a sender check", async () => {
    h.sender = STOPPED;
    h.item = { route: "zavi_list", list_id: LIST, status: "ready", card_id: "c1" };
    const x = await harness({ begin_email_plan_draft: { ok: true, attempt: null, status: "ready" } });
    expect(await runDraft(job, x.deps)).toBe("done");
    expect(h.senderCalls).toBe(0);
    expect(x.startRun).toHaveBeenCalledTimes(0);
  });
});

describe("the weekly plan run and planning check the sender", () => {
  const good = { id: LIST, name: "Customers", active: { sendable: 40 }, needs_consent: false };

  it("weeklyBlock under a global stop with only a Zavi list is not null", async () => {
    h.summaries = [good];
    h.sender = STOPPED;
    expect(await weeklyBlock(T)).toBe("sender_unavailable");
    expect(await weeklyBlock(T, { connectedToolIsEnough: true })).toBe("sender_unavailable");
  });

  it("weeklyBlock under an abuse hold is not null", async () => {
    h.summaries = [good];
    h.sender = HOLD;
    expect(await weeklyBlock(T)).not.toBeNull();
  });

  it("weeklyBlock is null when the sender is ready", async () => {
    h.summaries = [good];
    expect(await weeklyBlock(T)).toBeNull();
  });

  it("a connected tool keeps the weekly run going while Zavi's own sender is stopped", async () => {
    h.summaries = [good];
    h.sender = STOPPED;
    h.connected = new Set(["mailchimp"]);
    expect(await weeklyBlock(T)).toBeNull();
  });

  it("planning to a Zavi list under an abuse hold is refused with the hold's sentence", async () => {
    h.summaries = [good];
    h.sender = HOLD;
    expect(await livePlanList(T, "zavi_list", LIST)).toEqual({ ok: false, code: "bulk_abuse_hold", sentence: HOLD.sentence });
  });

  it("planning under a global stop is allowed (planning spends nothing; the draft waits)", async () => {
    h.summaries = [good];
    h.sender = STOPPED;
    expect(await livePlanList(T, "zavi_list", LIST)).toEqual({ ok: true, name: "Customers" });
  });
});

describe("a draft run refused by the global stop is not a permanent blocker", () => {
  const refused = (code: string) => ({ name: "mcp__server__email__propose_campaign", status: "tool_error", code, output_preview: `{"error":"${code}"}` });
  const run = (code: string) => ({ status: "success", finished_at: "2026-10-20T16:00:00Z", payload: { email_plan: { route: "zavi_list", list_id: LIST } }, tool_calls: [refused(code)] });

  it("bulk_sending_paused leaves the item to retry, an abuse hold still blocks", () => {
    expect(draftBlocker(run("bulk_sending_paused"))).toBeNull();
    expect(draftBlocker(run("bulk_abuse_hold"))).toBe("bulk_abuse_hold");
    expect(draftBlocker(run("email_card_cap_reached"))).toBeNull();
  });
});
