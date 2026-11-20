import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

import { emailCardHandlers } from "@/routes/email-cards";
import { BULK_OUTBOUND_INTERRUPTED_LINE, BULK_OUTBOUND_NOT_SENT_LINE, bulkNotSentLine } from "../../../../workers/functions/dispatch-notice";
import { BULK_REFUSAL_SENTENCES } from "@/services/comms/bulk-outbound/readiness";
import { OUTCOME_UNKNOWN_SUFFIX } from "@/services/connectors/email-campaign/execute-send";
import { EMAIL_CARD_MESSAGES, founderSendError, SEND_FAILED_FALLBACK, TOOL_SEND_NO_ANSWER, type CardDeps } from "../cards";
import { countAtSendRefusal } from "../variants";
import { WORDS as LIST_DOOR_WORDS } from "@/services/email-plan/list-door";
import { keyRejectedText, toolRefusalText } from "@/services/connectors/email-campaign/provider-errors";
import { planUpgradeMessage } from "@/services/agents/entitlement";

const T = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const MACHINE = /\b[a-z]+(_[a-z0-9]+)+\b|\([a-z_]+\)|\bunknown\b|create_and_send/;

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader() {},
  };
}

function handlers(o: { cls?: string; status?: string; facts?: Record<string, unknown> | null; failure?: string | null }) {
  const deps: Partial<CardDeps> = {
    rpc: (async (_t: string, name: string) => {
      if (name === "email_card_view_state") {
        return {
          ok: true,
          class: o.cls ?? "bulk_outbound.send",
          body: { list_name: "Members", variants: [], chosen_variant: 1, renderer_version: "r1", template_snapshot: {} },
          open: true,
          status: o.status ?? "dispatch_failed",
          role: "owner",
          versions: 1,
          tests: [],
          retryable: false,
          failure_reason: o.failure ?? null,
        };
      }
      if (name === "email_card_send_facts") return o.facts ?? null;
      if (name === "email_planned_for_card") return null;
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    liveCount: async () => 10,
    confirmedEmail: async () => "owner@brightloop.test",
    enqueue: async () => {},
    groupName: async () => null,
  };
  mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-owner" });
  return emailCardHandlers(deps, async () => new Set<string>(), (async () => null) as never);
}

async function viewBody(o: Parameters<typeof handlers>[0], rail = "decisions") {
  const r = res();
  await handlers(o).view({ params: { rail, id: CARD }, body: {} } as never, r as never);
  expect(r.statusCode).toBe(200);
  return r.body as { card: { status: string; failure_reason: string | null; may_have_sent?: boolean } };
}

async function card(o: Parameters<typeof handlers>[0], rail = "decisions") {
  return (await viewBody(o, rail)).card;
}

const failedDecision = (error: string, bulk: Record<string, unknown> | null = null) => ({
  facts: { card: { status: "dispatch_failed", approved: true, error }, bulk, results: null },
});

describe("the words a founder reads on a failed email card are never a machine code", () => {
  it("'I checked my email tool: it was not sent' on a Zavi-list card reads as that sentence, not not_sent_confirmed", async () => {
    const c = await card(failedDecision("not_sent_confirmed"));
    expect(c.status).toBe("not_sent");
    expect(c.failure_reason).toBe("You checked your email tool: it was not sent.");
    expect(c.failure_reason).not.toMatch(MACHINE);
  });

  it.each([
    ["tenant_disabled", "This workspace is switched off, so Zavi did not send this email. Nobody was emailed."],
    ["kill_switch", "The agent that wrote this email is switched off, so Zavi did not send it. Nobody was emailed."],
    ["unknown", SEND_FAILED_FALLBACK],
    ["held_for_founder", SEND_FAILED_FALLBACK],
    ["list_archived", BULK_REFUSAL_SENTENCES.list_archived],
    ["email_paused", EMAIL_CARD_MESSAGES.email_paused],
  ])("a send the dispatcher settled with the bare code %s says it in words", async (code, words) => {
    const c = await card(failedDecision(code));
    expect(c.status).toBe("failed");
    expect(c.failure_reason).toBe(words);
    expect(c.failure_reason).not.toMatch(MACHINE);
  });

  it("a refused bulk send keeps its sentence and drops the (code) the dispatcher appends", async () => {
    const stored = `${bulkNotSentLine(BULK_REFUSAL_SENTENCES.list_archived)} (list_archived)`;
    const c = await card(failedDecision(stored, { status: "failed", hold_reason: null, total: 3, sent: 0, skipped: 0, failed: 3, unknown: 0, hard_bounces: 0, created_at: null, finished_at: null, next_run_at: null }));
    expect(c.status).toBe("failed");
    expect(c.failure_reason).toBe(bulkNotSentLine(BULK_REFUSAL_SENTENCES.list_archived));
    expect(c.failure_reason).not.toMatch(MACHINE);
    const legacy = await card(failedDecision(`${BULK_OUTBOUND_NOT_SENT_LINE} (bulk_outbound_disabled)`));
    expect(legacy.failure_reason).toBe(BULK_OUTBOUND_NOT_SENT_LINE);
  });

  it("an interrupted bulk send whose outcome is unknown says may have gone out, without (bulk_outbound_dispatch_error)", async () => {
    const c = await card(failedDecision(`${BULK_OUTBOUND_INTERRUPTED_LINE} (bulk_outbound_dispatch_error)${OUTCOME_UNKNOWN_SUFFIX}`));
    expect(c.status).toBe("outcome_unknown");
    expect(c.failure_reason).toBe(BULK_OUTBOUND_INTERRUPTED_LINE);
    expect(c.failure_reason).not.toMatch(MACHINE);
  });

  it("a channel send whose body could not be read does not show 'email_campaign.create_and_send body invalid'", async () => {
    const c = await card(
      {
        cls: "email_campaign.create_and_send",
        status: "failed",
        failure: "email_campaign.create_and_send body invalid",
        facts: { card: { status: "pending", exec_status: "failed", approved: true, code: "email_campaign_body_invalid", error: "email_campaign.create_and_send body invalid" }, bulk: null, results: null },
      },
      "channel_actions",
    );
    expect(c.failure_reason).toBe("Zavi could not read this email's draft, so nothing was sent. Ask Zavi to draft it again.");
    expect(c.failure_reason).not.toMatch(MACHINE);
  });

  it.each([
    ["email_campaign.create_and_send body invalid"],
    ["email_campaign.create_and_send body invalid (email_campaign_body_invalid)"],
  ])("a decision send whose body could not be read shows the body-invalid sentence, not %s", async (error) => {
    const c = await card({ cls: "email_campaign.create_and_send", failure: error, ...failedDecision(error) });
    expect(c.status).toBe("failed");
    expect(c.failure_reason).toBe("Zavi could not read this email's draft, so nothing was sent. Ask Zavi to draft it again.");
    expect(c.failure_reason).not.toMatch(/create_and_send|body invalid/);
    expect(c.failure_reason).not.toMatch(MACHINE);
    const bare = await card({ cls: "email_campaign.create_and_send", status: "failed", failure: error, facts: null });
    expect(bare.failure_reason).toBe("Zavi could not read this email's draft, so nothing was sent. Ask Zavi to draft it again.");
  });

  it.each(["held_for_founder", "exec_outcome_unknown"])("a channel send that may have gone out with the bare error %s never tells the founder to ask for a new draft", async (error) => {
    const c = await card(
      {
        cls: "email_campaign.create_and_send",
        status: "failed",
        facts: { card: { status: "pending", exec_status: "failed", approved: true, code: "exec_outcome_unknown", error }, bulk: null, results: null },
      },
      "channel_actions",
    );
    expect(c.status).toBe("failed");
    expect(c.failure_reason).toBe(TOOL_SEND_NO_ANSWER);
    expect(c.failure_reason).not.toBe(SEND_FAILED_FALLBACK);
    expect(c.failure_reason).not.toMatch(MACHINE);
  });

  it.each([
    ["Zavi could not finish this in Mailchimp. Nothing was sent. Approve it again."],
    ['Mailchimp did not accept this email. Mailchimp said: "Your account is suspended." Nothing was sent.'],
    ["Autopilot did not send this on its own: Autopilot is off. Nothing was sent. Send it yourself if you agree."],
    [EMAIL_CARD_MESSAGES.email_paused],
    [BULK_REFUSAL_SENTENCES.list_archived],
  ])("a sentence Zavi wrote for the founder is shown as written: %s", async (sentence) => {
    const c = await card(failedDecision(sentence));
    expect(c.status).toBe("failed");
    expect(c.failure_reason).toBe(sentence);
  });

  const RAW_ERRORS = [
    'duplicate key value violates unique constraint "email_send_reservations_pkey" at /app/apps/backend/dist/x.js:12:7',
    "TypeError: Cannot read properties of undefined (reading 'id') at sendCampaign (/app/node_modules/@mailchimp/x/index.js:44:9)",
    "Mailchimp returned 503",
    "The list was archived.",
    "Mailchimp refused it. Nothing was sent. TypeError: x is undefined at run (/app/apps/backend/dist/send.js:9:1)",
  ];

  it.each(RAW_ERRORS)("a raw error the dispatcher stored never reaches the founder's card verbatim: %s", async (raw) => {
    const c = await card(failedDecision(raw));
    expect(c.status).toBe("failed");
    expect(c.failure_reason).toBe(SEND_FAILED_FALLBACK);
    expect(c.failure_reason).not.toMatch(/duplicate key|TypeError|node_modules|\/app\/|503|archived/);
  });

  it.each(RAW_ERRORS)("a raw error on a channel send or a view-state failure reason maps to the fallback too: %s", async (raw) => {
    const c = await card(
      {
        cls: "email_campaign.create_and_send",
        status: "failed",
        failure: raw,
        facts: { card: { status: "pending", exec_status: "failed", approved: true, code: "exec_failed", error: raw }, bulk: null, results: null },
      },
      "channel_actions",
    );
    expect(c.failure_reason).toBe(SEND_FAILED_FALLBACK);
    const bare = await card({ cls: "email_campaign.create_and_send", status: "failed", failure: raw, facts: null });
    expect(bare.failure_reason).toBe(SEND_FAILED_FALLBACK);
  });

  it("a raw error on a send whose outcome is unknown says it may have gone out, never the raw text or ask for a new draft", async () => {
    const c = await card(failedDecision(`Mailchimp returned 503${OUTCOME_UNKNOWN_SUFFIX}`));
    expect(c.status).toBe("outcome_unknown");
    expect(c.failure_reason).toBe(TOOL_SEND_NO_ANSWER);
  });
});

describe("a stored send error the founder was never meant to read stays in the server log", () => {
  const LONG = `Zavi tried. ${"The provider kept the connection open and then closed it ".repeat(90)}Nothing was sent.`;
  const MC_DROP = "Mailchimp did not accept this email. Nothing was sent.";
  const LEAKS: ReadonlyArray<[string, string, string, string | null]> = [
    ["a Postgres error", 'relation "email_send_reservations" does not exist. Nothing was sent.', "email_send_reservations", null],
    ["a Postgres error with a constraint", 'duplicate key value violates unique constraint "email_sends_pkey". Nobody was emailed.', "email_sends_pkey", null],
    ["a TypeError with a file path", "TypeError: x is undefined at /app/src/services/connectors/email-campaign/execute-send.ts:457:9", "TypeError", null],
    ["a bare tool status", "Mailchimp returned 503", "returned 503", null],
    ["a tool status dressed in a founder clause", "Mailchimp returned 503. Nothing was sent.", "returned 503", null],
    ["a raw error inside a real template slot", "Mailchimp did not accept this: TypeError x is undefined at /app/src/send.ts:9 Nothing was sent.", "TypeError", MC_DROP],
    ["a camelCase identifier inside a real template slot", "Mailchimp did not accept this: campaignId was null. Nothing was sent.", "campaignId", MC_DROP],
    ["an id quoted from the tool", 'Mailchimp did not accept this email. Mailchimp said: "Campaign_id is invalid." Nothing was sent.', "Campaign_id", MC_DROP],
    ["a masked subscriber address", "Mailchimp did not accept this: [an email address] is in a compliance state. Nothing was sent.", "[an email address]", MC_DROP],
    [
      "a SendGrid error with a URL",
      "SendGrid did not accept this: the from address does not match a verified Sender Identity. Visit https://sendgrid.com/docs/for-developers/sending-email/sender-identity/ to see the requirements. Nothing was sent.",
      "https://sendgrid.com",
      "SendGrid did not accept this email. Nothing was sent.",
    ],
    ["a 401 JSON body", 'Klaviyo did not accept this: {"errors":[{"status":401,"detail":"Missing or invalid private key."}]} Nothing was sent.', '"status":401', "Klaviyo did not accept this email. Nothing was sent."],
    ["a sender id from an older build", "SendGrid did not accept this: no sender_id is set for SendGrid. Nothing was sent.", "sender_id", "SendGrid did not accept this email. Nothing was sent."],
    [
      "a JSON refusal from the send call",
      'Mailchimp refused to send this: {"title":"Invalid Resource","detail":"Campaign not ready"}. Nothing was sent. The draft is in Mailchimp; send it from there, or ask Zavi for a new one.',
      "Invalid Resource",
      "Mailchimp refused to send this. Nothing was sent. The draft is in Mailchimp; send it from there, or ask Zavi for a new one.",
    ],
    ["a retry refusal with raw text", "Klaviyo did not accept this retry: ECONNRESET at TLSSocket.onConnectEnd Nothing was sent.", "ECONNRESET", "Klaviyo did not accept this retry. Nothing was sent."],
    ["an HTTP status in a real template slot", "Mailchimp did not accept this: HTTP 500. Nothing was sent.", "HTTP 500", MC_DROP],
    ["a connect error with an IP address", "Mailchimp did not accept this: Error: connect ECONNREFUSED 10.0.12.4:443. Nothing was sent.", "ECONNREFUSED", MC_DROP],
    ["a masked API key", "Mailchimp did not accept this: Invalid API key 3f9a7c-us21. Nothing was sent.", "3f9a7c", MC_DROP],
    ["a masked API key with an ellipsis", "Mailchimp did not accept this: Invalid API key 3f9a\u20267c-us21. Nothing was sent.", "3f9a", MC_DROP],
    ["a bare status code refusal", "Mailchimp refused to send this: Request failed with status code 500. Nothing was sent.", "status code 500", null],
    [
      "a status code refusal in the full refusal sentence",
      "Mailchimp refused to send this: Request failed with status code 500. Nothing was sent. The draft is in Mailchimp; send it from there, or ask Zavi for a new one.",
      "status code 500",
      "Mailchimp refused to send this. Nothing was sent. The draft is in Mailchimp; send it from there, or ask Zavi for a new one.",
    ],
    ["a long token", "Klaviyo did not accept this: token pk_live_abcdef0123 was not found. Nothing was sent.", "pk_live_abcdef0123", "Klaviyo did not accept this email. Nothing was sent."],
    ["a version number", "Klaviyo did not accept this: api revision 2.3.1 is not supported. Nothing was sent.", "2.3.1", "Klaviyo did not accept this email. Nothing was sent."],
    ["an all-caps code", "SendGrid did not accept this: the request was FORBIDDEN. Nothing was sent.", "FORBIDDEN", "SendGrid did not accept this email. Nothing was sent."],
    ["a very long string", LONG, "kept the connection open", null],
  ];

  function railCases(raw: string) {
    return {
      failedDecision: { ...failedDecision(raw), failure: raw },
      unknownDecision: { ...failedDecision(`${raw}${OUTCOME_UNKNOWN_SUFFIX}`), failure: raw },
      failedChannel: {
        cls: "email_campaign.create_and_send",
        status: "failed",
        failure: raw,
        facts: { card: { status: "pending", exec_status: "failed", approved: true, code: "exec_failed", error: raw }, bulk: null, results: null },
      },
      unknownChannel: {
        cls: "email_campaign.create_and_send",
        status: "failed",
        failure: raw,
        facts: { card: { status: "pending", exec_status: "failed", approved: true, code: "exec_outcome_unknown", error: raw }, bulk: null, results: null },
      },
      unknownViewOnly: { cls: "email_campaign.create_and_send", status: "outcome_unknown", failure: raw, facts: null },
      failedViewOnly: { cls: "email_campaign.create_and_send", status: "failed", failure: raw, facts: null },
    };
  }

  it.each(LEAKS)("%s reaches no part of the card payload on any rail or state, and the plain sentence matches the state", async (_name, raw, fragment, drop) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const cases = railCases(raw);
      const expected: Record<keyof typeof cases, { rail: string; status: string; words: string; mayHave: boolean }> = {
        failedDecision: { rail: "decisions", status: "failed", words: drop ?? SEND_FAILED_FALLBACK, mayHave: false },
        unknownDecision: { rail: "decisions", status: "outcome_unknown", words: TOOL_SEND_NO_ANSWER, mayHave: true },
        failedChannel: { rail: "channel_actions", status: "failed", words: drop ?? SEND_FAILED_FALLBACK, mayHave: false },
        unknownChannel: { rail: "channel_actions", status: "failed", words: TOOL_SEND_NO_ANSWER, mayHave: true },
        unknownViewOnly: { rail: "decisions", status: "outcome_unknown", words: TOOL_SEND_NO_ANSWER, mayHave: false },
        failedViewOnly: { rail: "decisions", status: "failed", words: drop ?? SEND_FAILED_FALLBACK, mayHave: false },
      };
      for (const key of Object.keys(cases) as Array<keyof typeof cases>) {
        const want = expected[key];
        const body = await viewBody(cases[key], want.rail);
        const payload = JSON.stringify(body);
        expect(payload, key).not.toContain(fragment);
        expect(payload, key).not.toContain(raw.slice(0, 40));
        expect(body.card.status, key).toBe(want.status);
        expect(body.card.failure_reason, key).toBe(want.words);
        expect(body.card.may_have_sent ?? false, key).toBe(want.mayHave);
        if (want.words === TOOL_SEND_NO_ANSWER) expect(body.card.failure_reason, key).toMatch(/Check the email tool/);
        else if (drop) expect(body.card.failure_reason, key).toMatch(/^(Mailchimp|Klaviyo|SendGrid) [a-z ]+\. Nothing was sent\./);
        else expect(body.card.failure_reason, key).toMatch(/Ask Zavi for a new draft/);
      }
      expect(warn.mock.calls.some((c) => String(c[0]).includes(raw.slice(0, 40)))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("an empty stored error leaves no reason on the card, so the card's own state wording shows", async () => {
    for (const raw of ["", "   "]) {
      const failedChannel = await card(railCases(raw).failedChannel, "channel_actions");
      expect(failedChannel.failure_reason).toBeNull();
      const failedView = await card(railCases(raw).failedViewOnly);
      expect(failedView.failure_reason).toBeNull();
      const unknownChannel = await card(railCases(raw).unknownChannel, "channel_actions");
      expect(unknownChannel.failure_reason).toBe(TOOL_SEND_NO_ANSWER);
      const unknownDecision = await card(railCases(raw).unknownDecision);
      expect(unknownDecision.failure_reason).toBe(TOOL_SEND_NO_ANSWER);
    }
    expect(founderSendError("")).toBeNull();
  });

  it.each([
    ["Klaviyo did not accept this: the campaign has no subject. Nothing was sent."],
    ['The list "Spring members" is no longer in SendGrid. Nothing was sent.'],
    ["This email was not sent. It is still a draft in Mailchimp. Zavi will not send this card again. Send it from Mailchimp, or ask Zavi for a new one."],
    ["Zavi could not confirm whether this email went out. It is no longer in Klaviyo. Zavi will not send this card again. Check it in Klaviyo, or ask Zavi for a new one."],
    ["SendGrid did not confirm whether this email was sent. Zavi will not send it again, so nobody gets it twice. Open SendGrid to see whether it went out."],
  ])("a sentence a real producer writes with a tool name and a plain slot is still shown as written: %s", async (sentence) => {
    expect(founderSendError(sentence)).toBe(sentence);
    expect(founderSendError(`${sentence} (email_tool_refused)`)).toBe(sentence);
  });

  it("a known template with a tool that is not one of ours is not trusted", () => {
    expect(founderSendError("Postgres did not accept this email. Nothing was sent.")).toBe(SEND_FAILED_FALLBACK);
  });
});

describe("editing a version: the refusal is a sentence, not a schema message", () => {
  const content = { subject: "Spring sale", preview_text: "", title: "Hello", paragraphs: ["Come in."], button: { label: "Shop", url: "https://brightloop.test" } };

  async function edit(c: unknown) {
    const r = res();
    await handlers({ status: "proposed", facts: null }).editVariant({ params: { rail: "decisions", id: CARD, n: "1" }, body: { content: c } } as never, r as never);
    return r;
  }

  it("an empty subject reads as the plain 'not complete' sentence, never zod's 'Too small' text", async () => {
    const r = await edit({ ...content, subject: "" });
    expect(r.statusCode).toBe(400);
    expect(r.body.error.message).toBe(EMAIL_CARD_MESSAGES.bad_content);
    expect(r.body.error.message).not.toMatch(/too small|expected|>=|characters/i);
  });

  it("a subject with a line break keeps Zavi's own sentence about it", async () => {
    const r = await edit({ ...content, subject: "Spring\nsale" });
    expect(r.body.error.message).toBe("The subject must be on one line: remove the line break or hidden character from it.");
  });

  it.each([
    ["a 201-character subject", { subject: "s".repeat(201) }, "The subject is too long. Keep it to 200 characters or fewer."],
    ["a 201-character title", { title: "t".repeat(201) }, "The title is too long. Keep it to 200 characters or fewer."],
    ["a 5,001-character second paragraph", { paragraphs: ["Come in.", "p".repeat(5_001)] }, "Paragraph 2 is too long. Keep it to 5,000 characters or fewer."],
    ["a 61-character button label", { button: { label: "b".repeat(61), url: "https://brightloop.test" } }, "The button label is too long. Keep it to 60 characters or fewer."],
    ["21 paragraphs", { paragraphs: Array.from({ length: 21 }, () => "Come in.") }, "There are too many paragraphs. Keep it to 20 or fewer."],
  ])("%s names that field and its limit, not the 'not complete' sentence", async (_name, patch, words) => {
    const r = await edit({ ...content, ...patch });
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe("bad_content");
    expect(r.body.error.message).toBe(words);
    expect(r.body.error.message).not.toBe(EMAIL_CARD_MESSAGES.bad_content);
    expect(r.body.error.message).not.toMatch(/too big|expected|<=|paragraphs\b.*\d+\]|preview_text/i);
    expect(r.body.error.message).not.toMatch(MACHINE);
  });

  it("a subject at exactly its limit is accepted past the content check", async () => {
    const r = await edit({ ...content, subject: "s".repeat(200) });
    expect(r.body?.error?.message).not.toMatch(/too long/);
  });
});

describe("a real sentence a producer writes for the founder is shown as written, never swapped for the generic fallback", () => {
  const NAMES = ["Café Lovers", "VIP 🎉", "VIP_customers", "Newsletter 2025/26", "Members | EU", "Black Friday / Cyber Monday", "iPhone owners", "McDonald's fans"];
  const REAL: ReadonlyArray<[string, string]> = [
    ["the list grew since approval", countAtSendRefusal({ approved: 1000, live: 1204, byAutopilot: false })!],
    ["the planned list grew since approval", countAtSendRefusal({ approved: 800, live: 950, byAutopilot: true, planned: true })!],
    ["the list is over the Autopilot cap", countAtSendRefusal({ approved: 900, live: 1204, byAutopilot: true })!],
    ["a big list grew", countAtSendRefusal({ approved: 120000, live: 1250000, byAutopilot: false })!],
    ...Object.entries(LIST_DOOR_WORDS).map(([code, words]) => [`the list door said ${code}`, words] as [string, string]),
    ["an unverified SendGrid sender", "SendGrid did not accept this: hello@bakery.test is not a verified sender in SendGrid. Nothing was sent."],
    ["two SendGrid senders share an address", "SendGrid did not accept this: more than one verified sender in SendGrid uses hello+news@bakery.co.uk, so Zavi cannot tell which one to send as. Nothing was sent."],
    ["no SendGrid sender", "SendGrid did not accept this: no sender is set for SendGrid. Nothing was sent."],
    ...NAMES.flatMap((n): Array<[string, string]> => [
      [`the count of "${n}" was unreadable`, `Mailchimp did not say how many people are on "${n}" right now, so Zavi did not send. Nothing was sent. Approve it again.`],
      [`the list "${n}" is gone`, `The list "${n}" is no longer in Klaviyo. Nothing was sent.`],
      [`two campaigns are named after "${n}"`, `Mailchimp did not accept this: more than one campaign named "Zavi: ${n} (ab12cd34)" exists there, so Zavi cannot tell which is this one. Nothing was sent.`],
      [`the campaign named after "${n}" goes elsewhere`, `Klaviyo did not accept this: the campaign named "Zavi: ${n} (ab12cd34)" goes to a different list. Nothing was sent.`],
      [`the campaign named after "${n}" is sending`, `Mailchimp did not accept this: the campaign named "Zavi: ${n} (ab12cd34)" is sending there. Nothing was sent.`],
    ]),
    ["a disabled workspace on a channel change", "This workspace is disabled, so Zavi did not apply this change. Nothing in the account changed."],
    ["a workspace check that failed", "Zavi could not confirm this workspace is active, so it did not apply this change. Nothing in the account changed. Approve it again to retry."],
    ["the platform kill switch", "Meta Ads changes are switched off at the platform level right now, so Zavi did not apply this one. Nothing in the account changed. Approve it again once they are back on."],
    ["the platform kill switch with no platform label", "These changes are switched off at the platform level right now, so Zavi did not apply this one. Nothing in the account changed. Approve it again once they are back on."],
    ["a plan upgrade with a price", `${planUpgradeMessage("email-campaigns", "growth")} Nothing in the account changed.`],
    ["a plan upgrade for another agent", `${planUpgradeMessage("tiktok-ads", "pro")} Nothing in the account changed.`],
    ["a plain quote from the tool", toolRefusalText("Mailchimp", "Your account is suspended.")],
    ...(["Mailchimp", "Klaviyo", "SendGrid"] as const).map((l) => [`${l} rejected the key`, keyRejectedText(l)] as [string, string]),
  ];

  it.each(REAL)("%s", async (_name, sentence) => {
    expect(sentence).toMatch(/\.$/);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(founderSendError(sentence)).toBe(sentence);
      expect(founderSendError(`${sentence} (email_tool_refused)`)).toBe(sentence);
      const c = await card(failedDecision(sentence));
      expect(c.failure_reason).toBe(sentence);
      const ch = await card(
        { cls: "email_campaign.create_and_send", status: "failed", failure: sentence, facts: { card: { status: "pending", exec_status: "failed", approved: true, code: "exec_failed", error: sentence }, bulk: null, results: null } },
        "channel_actions",
      );
      expect(ch.failure_reason).toBe(sentence);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("a SendGrid sender address that is not an address at all is not trusted as one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(founderSendError("SendGrid did not accept this: <script>@x.io is not a verified sender in SendGrid. Nothing was sent.")).toBe("SendGrid did not accept this email. Nothing was sent.");
      expect(founderSendError('The list "https://evil.test/x" is no longer in Klaviyo. Nothing was sent.')).toBe("The list is no longer in Klaviyo. Nothing was sent.");
      expect(founderSendError('Mailchimp did not say how many people are on "TypeError at x" right now, so Zavi did not send. Nothing was sent. Approve it again.')).toBe(
        "Mailchimp did not say how many people are on the list right now, so Zavi did not send. Nothing was sent. Approve it again.",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("a slot-dropped sentence on a send that may have gone out still says it may have gone out, never 'Nothing was sent'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const raw = "Mailchimp did not accept this: campaignId was null. Nothing was sent.";
      const ch = await card(
        { cls: "email_campaign.create_and_send", status: "failed", failure: raw, facts: { card: { status: "pending", exec_status: "failed", approved: true, code: "exec_outcome_unknown", error: raw }, bulk: null, results: null } },
        "channel_actions",
      );
      expect(ch.failure_reason).toBe(TOOL_SEND_NO_ANSWER);
      const view = await card({ cls: "email_campaign.create_and_send", status: "outcome_unknown", failure: raw, facts: null });
      expect(view.failure_reason).toBe(TOOL_SEND_NO_ANSWER);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a sentence the database cut at 500 characters still reads as the whole sentence", () => {
  const LONG_KNOWN = [...Object.values(EMAIL_CARD_MESSAGES), keyRejectedText("Klaviyo")].filter((s) => s.length > 500);

  it("the long sentences exist, so this proves something", () => {
    expect(LONG_KNOWN.length).toBeGreaterThanOrEqual(2);
  });

  it.each(LONG_KNOWN.map((s) => [s.slice(0, 60), s]))("%s... cut at 500 shows the whole sentence on every rail", async (_head, sentence) => {
    const cut = sentence.slice(0, 500);
    expect(founderSendError(cut)).toBe(sentence);
    expect((await card(failedDecision(cut))).failure_reason).toBe(sentence);
    expect((await card({ cls: "email_campaign.create_and_send", status: "failed", failure: cut, facts: null })).failure_reason).toBe(sentence);
  });

  it("a refusal cut inside its tool text keeps the refusal, without the cut tool text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const long = `Mailchimp did not accept this: ${"the campaign is missing a required setting and ".repeat(12)}more. Nothing was sent.`.slice(0, 500);
      expect(founderSendError(long)).toBe("Mailchimp did not accept this email. Nothing was sent.");
      const short = "Mailchimp did not accept this: the campaign is missing a required";
      expect(founderSendError(short)).toBe(SEND_FAILED_FALLBACK);
    } finally {
      warn.mockRestore();
    }
  });
});
