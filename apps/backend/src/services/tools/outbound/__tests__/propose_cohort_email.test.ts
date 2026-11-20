import { describe, it, expect, vi } from "vitest";

import { bulkProposedNote, makeProposeCohortEmailTool } from "../propose_cohort_email";
import { makeListEmailListsTool } from "../list_email_lists";
import { ExpectedToolError } from "@/services/tools/types";
import type { CohortRecord } from "@/services/comms/bulk-outbound/cohort";
import type { ListSummary } from "@/services/comms/bulk-outbound/lists";
import { BULK_REFUSAL_SENTENCES, type BulkRefusalCode } from "@/services/comms/bulk-outbound/readiness";

const LIST_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

function ctx(opts: { tenant_id?: string; withEmit?: boolean } = {}) {
  const emit = vi.fn(async (_cls: string, _body: unknown) => "dec-bulk-1");
  return {
    c: {
      tenant_id: opts.tenant_id ?? "t1",
      log: () => {},
      ...(opts.withEmit === false ? {} : { emit_decision: emit }),
    } as never,
    emit,
  };
}

function list(over: Partial<ListSummary> = {}): ListSummary {
  return {
    id: LIST_ID,
    name: "Newsletter",
    created_at: "2026-10-07T00:00:00Z",
    latest: { id: VERSION_ID, source_kind: "csv", source_label: "email", contact_count: 3, created_at: "2026-10-07T00:00:00Z", consented: true },
    active: { id: VERSION_ID, source_kind: "csv", contact_count: 3, sendable: 3, unsubscribed_or_bounced: 0 },
    needs_consent: false,
    ...over,
  };
}

const READY = { ok: true as const, sender: { domain: "acme.com", from_address: "hello@acme.com", from_name: null }, postal_address: "1 Main St" };
const refusal = (code: BulkRefusalCode) => ({ ok: false as const, code, sentence: BULK_REFUSAL_SENTENCES[code] });

function tool(opts: {
  records?: CohortRecord[];
  lists?: ListSummary[];
  sender?: typeof READY | ReturnType<typeof refusal>;
  replyTo?: () => Promise<string | null>;
} = {}) {
  const source = vi.fn((_l: { listId: string; versionId: string }) => ({
    async fetchCandidates() {
      return opts.records ?? [
        { email: "a@x.com", opt_in_marketing: true },
        { email: "b@x.com", opt_in_marketing: true },
        { email: "c@x.com", opt_in_marketing: true },
      ];
    },
  }));
  const t = makeProposeCohortEmailTool({
    source,
    checkSender: async () => opts.sender ?? READY,
    lists: async () => opts.lists ?? [list()],
    replyTo: opts.replyTo ?? (async () => "founder@acme.com"),
  });
  return { t, source };
}

const goodInput = { list_name: "newsletter", subject: "We miss you", body_text: "Come finish setting up your listing." };

describe("outbound__propose_cohort_email", () => {
  it("takes plain text only: a model-written HTML body is not accepted", () => {
    const { t } = tool();
    const parsed = t.input_schema.parse({ ...goodInput, body_html: "<a href='https://evil.example'>x</a>" }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("body_html");
  });

  it("has no recipient field: a list name is all the agent can give", () => {
    const { t } = tool();
    const parsed = t.input_schema.parse({ ...goodInput, recipients: ["x@evil.com"], to: "x@evil.com" }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("recipients");
    expect(parsed).not.toHaveProperty("to");
  });

  it("emits ONE bulk_outbound.send sealing the list, its version, the From address and a 5-address sample", async () => {
    const { t, source } = tool();
    const { c, emit } = ctx();
    const out = await t.execute(c, goodInput);
    expect(emit).toHaveBeenCalledTimes(1);
    const [cls, body] = emit.mock.calls[0];
    expect(cls).toBe("bulk_outbound.send");
    expect(body).toEqual({
      list_id: LIST_ID,
      list_version_id: VERSION_ID,
      list_name: "Newsletter",
      from_address: "hello@acme.com",
      reply_to: "founder@acme.com",
      template: { subject: "We miss you", body_text: "Come finish setting up your listing." },
      est_recipient_count: 3,
      list_source: "csv",
      sample_recipients: ["a@x.com", "b@x.com", "c@x.com"],
    });
    expect(source).toHaveBeenCalledWith({ listId: LIST_ID, versionId: VERSION_ID });
    expect(out).toMatchObject({ decision_id: "dec-bulk-1", est_recipient_count: 3, sends_on_approval: true, from_address: "hello@acme.com" });
    expect(out.note).toBe(bulkProposedNote(3, "Newsletter", "hello@acme.com"));
    expect(out.note).toMatch(/Nothing has been sent/);
  });

  it("a database-sourced list puts masked sample addresses on the card; a CSV list does not", async () => {
    const db = tool({ lists: [list({ active: { id: VERSION_ID, source_kind: "database", contact_count: 3, sendable: 3, unsubscribed_or_bounced: 0 } })] });
    const { c, emit } = ctx();
    await db.t.execute(c, goodInput);
    const body = emit.mock.calls[0][1] as { sample_recipients: string[]; list_source: string };
    expect(body.list_source).toBe("database");
    expect(body.sample_recipients).toEqual(["a•••@x.com", "b•••@x.com", "c•••@x.com"]);
    expect(JSON.stringify(body)).not.toMatch(/"a@x\.com"/);
  });

  it("still accepts the older selector.segment, read as a list name", async () => {
    const { t } = tool();
    const { c, emit } = ctx();
    await t.execute(c, { selector: { segment: "Newsletter" }, subject: "s", body_text: "b" });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["bulk_outbound_disabled", /switched off for this workspace/],
    ["bulk_sending_paused", /^Zavi's own sender is stopped for every workspace/],
    ["bulk_sender_not_configured", /^Bulk email is not set up yet\./],
    ["sending_domain_not_verified", /sending domain is not verified/],
    ["postal_address_missing", /postal address/],
  ] as Array<[BulkRefusalCode, RegExp]>)("refuses with %s and proposes nothing", async (code, sentence) => {
    const { t, source } = tool({ sender: refusal(code) });
    const { c, emit } = ctx();
    const err = (await t.execute(c, goodInput).catch((e: Error) => e)) as ExpectedToolError;
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe(code);
    expect(err.message).toMatch(sentence);
    expect(emit).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
  });

  it("the switched-off refusal never suggests a setting would make bulk email send", async () => {
    const { t } = tool({ sender: refusal("bulk_outbound_disabled") });
    const { c } = ctx();
    const err = await t.execute(c, goodInput).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/enable|settings/i);
  });

  it("an unknown list is refused, naming the lists that exist", async () => {
    const { t } = tool({ lists: [list({ name: "Customers" })] });
    const { c, emit } = ctx();
    await expect(t.execute(c, goodInput)).rejects.toMatchObject({
      code: "list_not_found",
      message: 'No contact list with that name. Lists in this workspace: "Customers".',
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("an owner lookup that fails while drafting files no card, instead of sealing no reply address on it", async () => {
    const { t } = tool({
      replyTo: async () => {
        throw new Error("owner lookup failed");
      },
    });
    const { c, emit } = ctx();
    await expect(t.execute(c, goodInput)).rejects.toMatchObject({ code: "bulk_check_failed", message: expect.stringMatching(/where replies to this email go/) });
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses a list whose import was never confirmed", async () => {
    const { t } = tool({ lists: [list({ active: null, needs_consent: true })] });
    const { c, emit } = ctx();
    await expect(t.execute(c, goodInput)).rejects.toMatchObject({ code: "list_not_consented" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses while a NEWER import waits for its tick, even though an older version was confirmed", async () => {
    const { t, source } = tool({ lists: [list({ needs_consent: true })] });
    const { c, emit } = ctx();
    await expect(t.execute(c, goodInput)).rejects.toMatchObject({ code: "list_not_consented" });
    expect(source).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses an empty list and a list where everyone is unsubscribed or bounced", async () => {
    const a = tool({ lists: [list({ active: { id: VERSION_ID, source_kind: "csv", contact_count: 2, sendable: 0, unsubscribed_or_bounced: 2 } })] });
    await expect(a.t.execute(ctx().c, goodInput)).rejects.toMatchObject({ code: "list_empty" });
    const b = tool({ records: [] });
    await expect(b.t.execute(ctx().c, goodInput)).rejects.toMatchObject({ code: "list_empty" });
  });

  it("a version with no consent recorded yields nobody, whatever the summary said", async () => {
    const { t } = tool({ records: [{ email: "a@x.com" }, { email: "b@x.com" }] });
    const { c, emit } = ctx();
    await expect(t.execute(c, goodInput)).rejects.toMatchObject({ code: "list_empty" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("caps at 1,000 people and says so on the card", async () => {
    const records = Array.from({ length: 1001 }, (_, i) => ({ email: `p${String(i).padStart(4, "0")}@x.com`, opt_in_marketing: true }));
    const { t } = tool({ records, lists: [list({ active: { id: VERSION_ID, source_kind: "csv", contact_count: 1001, sendable: 1001, unsubscribed_or_bounced: 0 } })] });
    const { c, emit } = ctx();
    const out = await t.execute(c, goodInput);
    expect(out.est_recipient_count).toBe(1000);
    expect((emit.mock.calls[0][1] as { capped_at?: number }).capped_at).toBe(1000);
    expect((emit.mock.calls[0][1] as { sample_recipients: string[] }).sample_recipients).toHaveLength(5);
  });

  it("tells the card how many people will be skipped", async () => {
    const { t } = tool({ lists: [list({ active: { id: VERSION_ID, source_kind: "csv", contact_count: 3, sendable: 2, unsubscribed_or_bounced: 1 } })] });
    const { c, emit } = ctx();
    const out = await t.execute(c, goodInput);
    expect(out.will_be_skipped).toBe(1);
    expect((emit.mock.calls[0][1] as { will_be_skipped?: number }).will_be_skipped).toBe(1);
  });

  it("the description says approval sends, and that recipients cannot be invented", () => {
    const { t } = tool();
    expect(t.description).toMatch(/SENDS\s+the email to everyone on the list/);
    expect(t.description).toMatch(/never supply or invent recipients/);
    expect(t.description).not.toMatch(/sends nothing, so|NOT switched on/);
  });

  it("refuses outside a managed run", async () => {
    const { t } = tool();
    await expect(t.execute(ctx({ withEmit: false }).c, goodInput)).rejects.toMatchObject({ code: "emit_unavailable" });
  });
});

describe("outbound__list_email_lists", () => {
  it("returns names and counts, never an address, and says what is missing", async () => {
    const t = makeListEmailListsTool({
      checkSender: async () => refusal("sending_domain_not_verified"),
      lists: async () => [list(), list({ id: "x", name: "Leads", active: null, needs_consent: true })],
      testLists: async () => new Set<string>(),
    });
    const out = await t.execute(ctx().c, {});
    expect(out.from_address).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/bulk_email_ready/);
    expect(out.missing).toEqual([BULK_REFUSAL_SENTENCES.sending_domain_not_verified]);
    expect(out.lists).toEqual([
      { id: LIST_ID, name: "Newsletter", people: 3, can_be_emailed: 3, unsubscribed_or_bounced: 0, ready_to_send: true, marked_test: false, not_ready_because: null },
      expect.objectContaining({ name: "Leads", ready_to_send: false, can_be_emailed: 0 }),
    ]);
    expect(JSON.stringify(out)).not.toMatch(/@x\.com/);
    expect(t.effect).toBe("read");
  });
});
