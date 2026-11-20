import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({
  value: [] as unknown[],
  filters: [] as Array<[string, unknown]>,
  bounds: [] as Array<[string, unknown]>,
  tenants: [] as string[],
  decisions: [] as Array<{ id: string; tenant_id: string; decision_class: string; emitted_at: string; body?: Record<string, string> }>,
  decisionReads: [] as Array<{ tenant: string; match: Array<[string, string]>; after: unknown }>,
  ledger: [] as Array<Record<string, unknown>>,
  charges: [] as Array<Record<string, unknown>>,
  ledgerError: null as { message: string } | null,
  moneyReads: [] as Array<{ tenant: string; table: string; filters: Array<[string, unknown]> }>,
}));
const canRead = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (t: string) => {
    rows.tenants.push(t);
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        rows.filters.push([k, v]);
        return q;
      },
      gte: (k: string, v: unknown) => {
        rows.bounds.push([k, v]);
        return q;
      },
      order: () => q,
      limit: async () => ({ data: rows.value, error: null }),
    };
    const read = { match: [] as Array<[string, string]>, classes: null as string[] | null, after: "" };
    const field = (r: (typeof rows.decisions)[number], k: string) => (k.startsWith("body->>") ? r.body?.[k.slice(7)] : (r as Record<string, unknown>)[k]);
    const d = {
      select: () => d,
      eq: (k: string, v: string) => {
        read.match.push([k, v]);
        return d;
      },
      in: (k: string, v: string[]) => {
        if (k === "decision_class") read.classes = v;
        return d;
      },
      gt: (k: string, v: string) => {
        if (k === "emitted_at") read.after = v;
        return d;
      },
      limit: async (n: number) => {
        rows.decisionReads.push({ tenant: t, match: read.match, after: read.after });
        const hit = rows.decisions.filter((r) => r.tenant_id === t && (!read.classes || read.classes.includes(r.decision_class)) && read.match.every(([k, v]) => field(r, k) === v) && Date.parse(r.emitted_at) > Date.parse(read.after));
        return { data: hit.slice(0, n).map((r) => ({ id: r.id })), error: null };
      },
    };
    const money = (table: string) => {
      const read = { tenant: t, table, filters: [] as Array<[string, unknown]> };
      rows.moneyReads.push(read);
      const m = {
        select: () => m,
        in: (k: string, v: unknown) => {
          read.filters.push([k, v]);
          return m;
        },
        eq: async (k: string, v: unknown) => {
          read.filters.push([k, v]);
          const all = table === "tenant_credit_ledger" ? rows.ledger : rows.charges;
          if (table === "tenant_credit_ledger" && rows.ledgerError) return { data: null, error: rows.ledgerError };
          return { data: all.filter((r) => r.tenant_id === t && r.run_id === v), error: null };
        },
      };
      return m;
    };
    return {
      from: (table: string) =>
        table === "agent_runs" ? q : table === "decisions" ? d : table === "tenant_credit_ledger" || table === "tool_charges" ? money(table) : null,
    };
  },
}));
vi.mock("@/services/agents/runner", () => ({ canCurrentUserReadRun: canRead }));

import { creditsUsedSentence, missReasonFor, readTopActionMiss } from "@/services/channels/top-action-miss";

const NOW = Date.parse("2026-10-23T10:05:00Z");
const LIST = "6b7a1c2e-1111-4222-8333-444455556666";
const PAYLOAD = {
  channel_slug: "email_marketing",
  top_action: { key: "new_email", by: "u1", inputs: { route: "zavi_list", list_id: LIST, brief: "Announce the spring sale" } },
};
const MODEL_TEXT = "I decided the list was too small, so I held the email back.";
const run = (over: Record<string, unknown> = {}) => ({
  id: "1caaac04-1111-4000-8000-000000000000",
  status: "success",
  output_text: MODEL_TEXT,
  payload: PAYLOAD,
  tool_calls: [{ name: "email__propose_campaign", status: "tool_error", code: "bulk_sender_not_configured" }],
  finished_at: "2026-10-23T10:00:51Z",
  ...over,
});

beforeEach(() => {
  rows.value = [];
  rows.filters = [];
  rows.bounds = [];
  rows.tenants = [];
  rows.decisions = [];
  rows.decisionReads = [];
  rows.ledger = [];
  rows.charges = [];
  rows.ledgerError = null;
  rows.moneyReads = [];
  canRead.mockClear();
  canRead.mockResolvedValue(true);
});

describe("the reason a Write it run filed no email", () => {
  it("is the tool's structured refusal, worded by Zavi, read from this tenant's latest new_email run on this channel", async () => {
    rows.value = [run()];
    const miss = await readTopActionMiss("t1", "u1", "email_marketing", NOW);
    expect(miss).toEqual({ run_id: run().id, key: "new_email", noun: "this email", reason: "Bulk email is not set up yet.", at: run().finished_at });
    expect(JSON.stringify(miss)).not.toContain(MODEL_TEXT);
    expect(rows.tenants).toEqual(["t1"]);
    expect(rows.filters).toEqual([
      ["channel_slug", "email_marketing"],
      ["payload->top_action->>key", "new_email"],
    ]);
    expect(canRead).toHaveBeenCalledWith("u1", run().id);
  });

  it("reads only runs enqueued in the window plus an hour, so the tenant_id, enqueued_at index bounds the scan", async () => {
    rows.value = [run()];
    await readTopActionMiss("t1", "u1", "email_marketing", NOW);
    expect(rows.bounds).toEqual([["enqueued_at", "2026-10-22T09:05:00.000Z"]]);
  });

  it("is nothing when the run filed its card, is still running, is a day old, or the member may not read it", async () => {
    rows.value = [run({ tool_calls: [{ name: "mcp__server__email__propose_campaign", status: "ok" }] })];
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toBeNull();
    rows.value = [run({ status: "running", finished_at: null })];
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toBeNull();
    rows.value = [run({ finished_at: "2026-10-22T09:00:00Z" })];
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toBeNull();
    rows.value = [run()];
    canRead.mockResolvedValueOnce(false);
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toBeNull();
  });

  it("is read only on a channel whose action reports it", async () => {
    rows.value = [run()];
    expect(await readTopActionMiss("t1", "u1", "x_organic", NOW)).toBeNull();
    expect(await readTopActionMiss("t1", "u1", "__proto__", NOW)).toBeNull();
    expect(rows.filters).toEqual([]);
  });

  it("words each final refusal for the founder, and says something honest and generic when no tool refused", () => {
    const tc = (calls: unknown[]) => missReasonFor(PAYLOAD, calls);
    expect(tc([{ name: "mcp__server__email__propose_campaign", status: "tool_error", code: "list_not_consented" }])).toMatch(/^Nobody has confirmed/);
    expect(tc([{ name: "email__propose_campaign", status: "tool_error", code: "email_test_list" }])).toBe("That list is marked as a test list, so Zavi never sends a real email to it.");
    const cap = tc([{ name: "email__propose_campaign", status: "tool_error", code: "email_card_cap_reached" }]);
    expect(cap).toBe("Zavi already filed the most emails it may put up for approval in one day. Try again tomorrow.");
    expect(cap).not.toMatch(/approve|reject|waiting/i);
    const lists = { name: "outbound__list_email_lists", status: "ok", output_preview: JSON.stringify({ lists: [], bulk_email_ready: false }) };
    expect(tc([lists])).toMatch(/^Zavi's own sender or this list is not ready/);
    expect(tc([{ name: "email__propose_campaign", status: "tool_error", code: "list_archived" }, { name: "email__propose_campaign", status: "tool_error", code: "bulk_sending_paused" }])).toBe(
      "Zavi's own sender is stopped for every workspace right now, so no email can go out from it. Try again once it is running.",
    );
    expect(tc([{ name: "email__propose_campaign", status: "tool_error", code: "email_wrong_list" }])).toBe("it finished without an email to show you.");
    expect(tc([])).toBe("it finished without an email to show you.");
    expect(missReasonFor({ nope: true }, [{ name: "email__propose_campaign", status: "tool_error", code: "list_archived" }])).toBe("it finished without an email to show you.");
    expect(missReasonFor(PAYLOAD, "not an array")).toBe("it finished without an email to show you.");
  });

  it("must catch: the sender-stopped banner carries the sentence once, not the label and then the sentence, with the credits sentence after it", async () => {
    const paused = [{ name: "email__propose_campaign", status: "tool_error", code: "bulk_sending_paused" }];
    const reason = missReasonFor(PAYLOAD, paused);
    expect(reason).not.toMatch(/Zavi sender stopped/);
    expect(reason.match(/stopped/g)).toHaveLength(1);
    expect(reason).toMatch(/^Zavi's own sender is stopped for every workspace right now/);
  });

  it("ignores the model's closing text even when it reads like a reason", async () => {
    rows.value = [run({ tool_calls: [] })];
    const miss = await readTopActionMiss("t1", "u1", "email_marketing", NOW);
    expect(miss?.reason).toBe("it finished without an email to show you.");
  });

  it("is nothing once an email card for the same list is filed on the decisions rail after the run finished, and stays for one filed before, in another tenant, or for another list", async () => {
    rows.value = [run()];
    const OTHER = "9f9f9f9f-2222-4333-8444-555566667777";
    rows.decisions = [
      { id: "d-before", tenant_id: "t1", decision_class: "bulk_outbound.send", emitted_at: "2026-10-23T10:00:00Z", body: { list_id: LIST } },
      { id: "d-other-tenant", tenant_id: "t2", decision_class: "bulk_outbound.send", emitted_at: "2026-10-23T10:03:00Z", body: { list_id: LIST } },
      { id: "d-not-email", tenant_id: "t1", decision_class: "meta_ads.launch", emitted_at: "2026-10-23T10:03:00Z", body: { list_id: LIST } },
      { id: "d-autopilot-other-list", tenant_id: "t1", decision_class: "bulk_outbound.send", emitted_at: "2026-10-23T10:03:00Z", body: { list_id: OTHER } },
      { id: "d-vendor-same-id", tenant_id: "t1", decision_class: "email_campaign.create_and_send", emitted_at: "2026-10-23T10:03:00Z", body: { tool: "mailchimp", audience_id: LIST } },
    ];
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toMatchObject({ run_id: run().id });
    expect(rows.decisionReads).toEqual([
      {
        tenant: "t1",
        match: [
          ["decision_class", "bulk_outbound.send"],
          ["body->>list_id", LIST],
        ],
        after: run().finished_at,
      },
    ]);
    rows.decisions.push({ id: "d-pasted", tenant_id: "t1", decision_class: "bulk_outbound.send", emitted_at: "2026-10-23T10:02:00Z", body: { list_id: LIST } });
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toBeNull();
  });

  it("must catch: a Zavi list named in upper case is cleared by the later card, which stores the list id in lower case", async () => {
    const upper = { ...PAYLOAD, top_action: { ...PAYLOAD.top_action, inputs: { ...PAYLOAD.top_action.inputs, list_id: LIST.toUpperCase() } } };
    rows.value = [run({ payload: upper })];
    rows.decisions = [{ id: "d-card", tenant_id: "t1", decision_class: "bulk_outbound.send", emitted_at: "2026-10-23T10:02:00Z", body: { list_id: LIST } }];
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toBeNull();
    expect(rows.decisionReads[0].match).toEqual([
      ["decision_class", "bulk_outbound.send"],
      ["body->>list_id", LIST],
    ]);
  });

  it("keeps a vendor audience id exactly as given", async () => {
    const vendor = { ...PAYLOAD, top_action: { ...PAYLOAD.top_action, inputs: { route: "mailchimp", list_id: "Aud-1", brief: "Announce the spring sale" } } };
    rows.value = [run({ payload: vendor })];
    rows.decisions = [{ id: "d-lower", tenant_id: "t1", decision_class: "email_campaign.create_and_send", emitted_at: "2026-10-23T10:02:00Z", body: { tool: "mailchimp", audience_id: "aud-1" } }];
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toMatchObject({ run_id: run().id });
  });

  it("for a vendor list, is cleared only by a later card for that vendor and audience", async () => {
    const vendor = { ...PAYLOAD, top_action: { ...PAYLOAD.top_action, inputs: { route: "mailchimp", list_id: "aud-1", brief: "Announce the spring sale" } } };
    rows.value = [run({ payload: vendor })];
    rows.decisions = [
      { id: "d-zavi-list", tenant_id: "t1", decision_class: "bulk_outbound.send", emitted_at: "2026-10-23T10:02:00Z", body: { list_id: "aud-1" } },
      { id: "d-other-vendor", tenant_id: "t1", decision_class: "email_campaign.create_and_send", emitted_at: "2026-10-23T10:02:00Z", body: { tool: "klaviyo", audience_id: "aud-1" } },
      { id: "d-other-audience", tenant_id: "t1", decision_class: "email_campaign.create_and_send", emitted_at: "2026-10-23T10:02:00Z", body: { tool: "mailchimp", audience_id: "aud-2" } },
    ];
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toMatchObject({ run_id: run().id });
    rows.decisions.push({ id: "d-chat", tenant_id: "t1", decision_class: "email_campaign.create_and_send", emitted_at: "2026-10-23T10:01:00Z", body: { tool: "mailchimp", audience_id: "aud-1" } });
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toBeNull();
  });

  it("reports a Write it run that failed, errored, timed out or was stopped, in plain words, and still not one that is waiting or running", async () => {
    for (const status of ["failed", "error", "timed_out", "dispatch_error", "parse_failed"]) {
      rows.value = [run({ status, tool_calls: [] })];
      expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toEqual({
        run_id: run().id,
        key: "new_email",
        noun: "this email",
        reason: "it stopped before it finished. Try again.",
        at: run().finished_at,
      });
    }
    rows.value = [run({ status: "cancelled", tool_calls: [] })];
    expect((await readTopActionMiss("t1", "u1", "email_marketing", NOW))?.reason).toBe("it stopped before it finished. Try again.");
    for (const status of ["blocked", "queued", "running"]) {
      rows.value = [run({ status })];
      expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toBeNull();
    }
  });

  it("reads no decisions when there is no miss to clear", async () => {
    rows.value = [run({ tool_calls: [{ name: "email__propose_campaign", status: "ok" }] })];
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toBeNull();
    expect(rows.decisionReads).toEqual([]);
  });

  it("must catch: tells the founder the credits a no-email Write it attempt actually used, read from this tenant's ledger for this run", async () => {
    const id = run().id;
    rows.value = [run()];
    rows.ledger = [
      { tenant_id: "t1", run_id: id, kind: "reserve", amount: 460, attempt: 1 },
      { tenant_id: "t1", run_id: id, kind: "settle", amount: 40, attempt: 1, debited: 40, debited_daily: 0 },
      { tenant_id: "t2", run_id: id, kind: "settle", amount: 460, attempt: 1, debited: 460, debited_daily: 0 },
      { tenant_id: "t1", run_id: "other-run", kind: "settle", amount: 460, attempt: 1, debited: 460, debited_daily: 0 },
    ];
    const miss = await readTopActionMiss("t1", "u1", "email_marketing", NOW);
    expect(miss?.reason).toBe("Bulk email is not set up yet. This attempt used 40 credits.");
    expect(miss?.reason).not.toMatch(/460/);
    expect(rows.moneyReads.map((r) => [r.tenant, r.table, r.filters.find(([k]) => k === "run_id")?.[1]])).toEqual([
      ["t1", "tenant_credit_ledger", id],
      ["t1", "tool_charges", id],
    ]);
  });

  it("nets a late tool-check refund out of the credits it reports, and says none when the hold was refunded", async () => {
    const id = run().id;
    rows.value = [run()];
    rows.ledger = [
      { tenant_id: "t1", run_id: id, kind: "reserve", amount: 460, attempt: 1 },
      { tenant_id: "t1", run_id: id, kind: "settle", amount: 41, attempt: 1, debited: 41, debited_daily: 0 },
    ];
    rows.charges = [{ tenant_id: "t1", run_id: id, refunded_daily: 0, refunded_included: 40, refunded_purchased: 0 }];
    expect((await readTopActionMiss("t1", "u1", "email_marketing", NOW))?.reason).toBe("Bulk email is not set up yet. This attempt used 1 credit.");
    rows.charges = [];
    rows.ledger = [
      { tenant_id: "t1", run_id: id, kind: "reserve", amount: 460, attempt: 1 },
      { tenant_id: "t1", run_id: id, kind: "refund", amount: 460, attempt: 1 },
    ];
    expect((await readTopActionMiss("t1", "u1", "email_marketing", NOW))?.reason).toBe("Bulk email is not set up yet. This attempt used no credits.");
  });

  it("says nothing about credits while the hold is still open, or when the ledger cannot be read, rather than guessing", async () => {
    const id = run().id;
    rows.value = [run()];
    rows.ledger = [{ tenant_id: "t1", run_id: id, kind: "reserve", amount: 460, attempt: 1 }];
    expect((await readTopActionMiss("t1", "u1", "email_marketing", NOW))?.reason).toBe("Bulk email is not set up yet.");
    rows.ledgerError = { message: "boom" };
    expect((await readTopActionMiss("t1", "u1", "email_marketing", NOW))?.reason).toBe("Bulk email is not set up yet.");
  });

  it("must catch: leaves the credits sentence out for a tenant whose credits are not enforced, while a refunded hold still says no credits", async () => {
    const id = run().id;
    rows.value = [run()];
    rows.ledger = [{ tenant_id: "t2", run_id: id, kind: "settle", amount: 40, attempt: 1, debited: 40, debited_daily: 0 }];
    const miss = await readTopActionMiss("t1", "u1", "email_marketing", NOW);
    expect(miss?.reason).toBe("Bulk email is not set up yet.");
    expect(miss?.reason).not.toMatch(/credit/i);
    expect(rows.moneyReads.map((r) => [r.tenant, r.table])).toEqual([
      ["t1", "tenant_credit_ledger"],
      ["t1", "tool_charges"],
    ]);
    rows.ledger = [
      { tenant_id: "t1", run_id: id, kind: "reserve", amount: 460, attempt: 1 },
      { tenant_id: "t1", run_id: id, kind: "refund", amount: 460, attempt: 1 },
    ];
    expect((await readTopActionMiss("t1", "u1", "email_marketing", NOW))?.reason).toBe("Bulk email is not set up yet. This attempt used no credits.");
  });

  it("reads no credits when there is no miss to report", async () => {
    rows.value = [run({ tool_calls: [{ name: "email__propose_campaign", status: "ok" }] })];
    expect(await readTopActionMiss("t1", "u1", "email_marketing", NOW)).toBeNull();
    expect(rows.moneyReads).toEqual([]);
  });

  it("words the credits sentence in plain numbers", () => {
    expect(creditsUsedSentence(0)).toBe("This attempt used no credits.");
    expect(creditsUsedSentence(1)).toBe("This attempt used 1 credit.");
    expect(creditsUsedSentence(1200)).toBe("This attempt used 1,200 credits.");
  });
});
