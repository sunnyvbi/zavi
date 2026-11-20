import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  runGenericMock: vi.fn(),
  logEventMock: vi.fn(async (_input: { code?: string }) => {}),
  neOverride: null as null | ((args: { reply: string }) => unknown),
}));
vi.mock("../negative-existence-grounding-verifier", async (orig) => {
  const real = await orig<typeof import("../negative-existence-grounding-verifier")>();
  return {
    ...real,
    verifyNegativeExistence: (args: Parameters<typeof real.verifyNegativeExistence>[0]) =>
      mocks.neOverride ? mocks.neOverride(args) : real.verifyNegativeExistence(args),
  };
});
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: mocks.fromMock, rpc: mocks.rpcMock }),
  serverClientFromBearer: () => ({}),
}));
vi.mock("@/services/logging/logEvent", async (orig) => ({
  ...(await orig<typeof import("@/services/logging/logEvent")>()),
  logEvent: mocks.logEventMock,
}));
vi.mock("../visibility", () => ({
  getEffectiveVisibility: async () => ({ visible: true, reason: "default_enabled" }),
}));
vi.mock("../generic-dispatcher", () => ({ runGeneric: mocks.runGenericMock }));
vi.mock("@/agents/index", () => ({ postProcessors: {} }));
vi.mock("../deepagent", () => ({ LangChainDeepAgentEngine: class {} }));
vi.mock("../registry", async (orig) => ({
  ...(await orig<typeof import("../registry")>()),
  getDispatcher: () => null,
}));

import { runChat } from "../chat-dispatcher";
import { runDispatch } from "../runner";
import { composeHandoffBody } from "../handoff-result";
import { selectReplyTextFromRow } from "../terminal-reply-text";
import { deriveOutcome } from "../outcome-model";
import { STATUS_PHRASES } from "../run-status-projection";
import { findInternalJargon } from "../internal-jargon";
import { buildOpenPrNotice } from "../../../../workers/functions/dispatch-notice";
import { buildSlackHandoffChildText } from "../../../../workers/functions/slack-triage-reply";
import { whatsappReplyText } from "../../../../workers/functions/whatsapp-triage-reply";
import { handoffChildReplyText, isHandoffChildPayload } from "../handoff-result";
import {
  applyAutonomousGrounding,
  replaceUnreadPaymentClaims,
  PAYMENT_RECORD_UNREAD_PHRASE,
} from "../autonomous-grounding";
import { describeVoOutcome } from "../../launch-video/vo";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentContext } from "../types";
import type { ToolCallTrace } from "@/services/tools/types";

const { fromMock, rpcMock, runGenericMock, logEventMock } = mocks;

const BANNED: RegExp[] = [/⚠/, /Correction/, /Unverified/, /didn['’]t run the tests/i];

function expectNoBanner(text: string | undefined) {
  expect(text).toBeDefined();
  for (const re of BANNED) expect(text).not.toMatch(re);
}

function trace(name: string, output = "{}"): ToolCallTrace {
  return { name, status: "ok", input_preview: "{}", output_preview: output, ms: 1 };
}

const OP_CLAIM = "Handed off to the engineer. Two PRs are being opened.";
const HANDOFF_OK = [trace("mcp__server__praxis__handoff")];

const ENG_TESTS_PASS = "I fixed the checkout total and the tests pass.";
const ENG_TESTS_PASS_PARSED = {
  pr_url: "https://github.com/acme/shop/pull/812",
  verify: { status: "not_run" },
};

const JARGON_DELIVERABLE =
  "I can't ship these PRs from this run — the sandbox is on the wrong repo. " +
  "Evidence (`git remote -v` in the sandbox): the checked-out repo is " +
  "`Praxis-build/acme-6ec4d609`, not the customer repo. Fix: re-dispatch with " +
  "`repo_hint: acme/shop`. No envelope emitted — this run has nothing to ship.";

function makeCtx(slug: string, trigger: "chat" | "slack"): AgentContext {
  return {
    agent: { slug, metadata_praxis: { requires_sandbox: false } },
    tenant_id: "tenant-A",
    tenantConfig: {},
    memory: {},
    anthropic: {},
    runId: "run-1",
    trigger,
    scanRecentRuns: vi.fn(),
    emitDecision: vi.fn(),
    emitProgress: vi.fn(),
  } as never;
}

function stubChain(rows: unknown) {
  const result = Promise.resolve({ data: rows, error: null });
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "lt", "gte", "filter", "in", "order", "like", "contains"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => result);
  chain.maybeSingle = vi.fn(() => result);
  chain.limit = vi.fn(() => result);
  chain.then = (res: (v: unknown) => unknown) => result.then(res);
  return chain;
}

function primeChat(slug: string) {
  fromMock.mockImplementation(() => stubChain([]));
  fromMock.mockImplementationOnce(() => stubChain(null));
  fromMock.mockImplementationOnce(() => stubChain({ tenant_id: "tenant-A", agent_slug: slug, id: "t1" }));
  fromMock.mockImplementationOnce(() =>
    stubChain({ id: "u1", thread_id: "t1", sender_role: "user", body: "can you take care of this?" }),
  );
}

type Turn = {
  text: string;
  toolCalls?: ToolCallTrace[];
  parsed?: Record<string, unknown> | null;
  sideEffect?: { kind: "shipped" | "refused" | "none" };
  customerSummary?: string;
};

function queueModel(t: Turn) {
  runGenericMock.mockResolvedValue({
    output_text: t.text,
    parsed: t.parsed ?? null,
    parse_ok: true,
    raw_response_text: t.text,
    prompt_snapshot: "",
    usage: { input_tokens: 1, output_tokens: 1 },
    tool_calls: t.toolCalls ?? [],
    ...(t.sideEffect ? { side_effect: t.sideEffect } : {}),
    ...(t.customerSummary ? { customer_summary: t.customerSummary } : {}),
  });
}

async function chatBubble(slug: string, t: Turn): Promise<string | undefined> {
  primeChat(slug);
  queueModel(t);
  await runChat(makeCtx(slug, "chat"), { thread_id: "t1", user_message_id: "u1" });
  const call = rpcMock.mock.calls.find((c) => c[0] === "record_agent_chat_reply");
  return call?.[1]?.p_body as string | undefined;
}

async function storedReply(slug: string, t: Turn): Promise<string> {
  fromMock.mockImplementation(() => stubChain([]));
  queueModel(t);
  const r = await runDispatch(makeCtx(slug, "slack"), {});
  return r.output_text;
}

const SEAMS = [
  ["web chat bubble", chatBubble],
  ["stored reply (Slack / WhatsApp / email)", storedReply],
] as const;

function loggedCodes(): string[] {
  return logEventMock.mock.calls.map((c) => String((c[0] as { code?: string }).code));
}

beforeEach(() => {
  mocks.neOverride = null;
  fromMock.mockReset();
  rpcMock.mockReset();
  runGenericMock.mockReset();
  logEventMock.mockClear();
  rpcMock.mockResolvedValue({ data: "msg-id", error: null });
  fromMock.mockImplementation(() => stubChain([]));
});

describe.each(SEAMS)("%s — incident fixtures", (_name, deliver) => {
  it("operator claim WITH a real mcp__server__praxis__handoff → untouched, no banner", async () => {
    const out = await deliver("operator", { text: OP_CLAIM, toolCalls: HANDOFF_OK });
    expect(out).toBe(OP_CLAIM);
    expectNoBanner(out);
  });

  it("the same claim with ZERO handoffs → claim sentences removed, server phrase, no banner", async () => {
    const out = await deliver("operator", { text: OP_CLAIM });
    expect(out).toBe(STATUS_PHRASES.no_change);
    expectNoBanner(out);
    expect(loggedCodes()).toContain("side_effect_claim.sentence_removed");
  });

  it("a claim inside a longer reply → only the claim sentence goes", async () => {
    const out = await deliver("operator", {
      text: "The checkout total is off by the tax line. Handed off to the engineer.",
    });
    expect(out).toBe("The checkout total is off by the tax line.");
  });

  it("engineer says 'tests pass' with no passing verify → telemetry only, no banner", async () => {
    const out = await deliver("engineer", {
      text: ENG_TESTS_PASS,
      parsed: ENG_TESTS_PASS_PARSED,
      sideEffect: { kind: "shipped" },
    });
    expect(out).toBe(ENG_TESTS_PASS);
    expectNoBanner(out);
    expect(loggedCodes()).toContain("engineer_verify_corrected");
  });
});

describe.each(SEAMS)("%s — false positives stay byte-identical", (_name, deliver) => {
  it("a true 'I opened PR #812' with a real receipt", async () => {
    const text = "I opened PR #812 with the fix.";
    const out = await deliver("engineer", {
      text,
      parsed: { pr_url: "https://github.com/acme/shop/pull/812", verify: { status: "passed" } },
      sideEffect: { kind: "shipped" },
    });
    expect(out).toBe(text);
  });

  it("a founder-quoted ⚠ inside a fenced code block", async () => {
    const text =
      "You pasted this:\n\n```\n⚠ build failed: heap out of memory\n```\n\n" +
      "That means the build ran out of memory. Raise the memory limit and build again.";
    const out = await deliver("operator", { text });
    expect(out).toBe(text);
  });

  it("'I'll send it when you approve' (a future step, not a claim)", async () => {
    const text = "I'll send it when you approve.";
    expect(await deliver("operator", { text })).toBe(text);
  });

  it("'Your team sent 12 emails last week' (the customer's own action)", async () => {
    const text = "Your team sent 12 emails last week.";
    expect(await deliver("operator", { text })).toBe(text);
  });

  it("a correct number read from a tool this run", async () => {
    const text = "You have 42 active hosts right now.";
    const out = await deliver("operator", {
      text,
      toolCalls: [trace("operator_db__query", '{"rows":[{"active_hosts":42}]}')],
    });
    expect(out).toBe(text);
  });
});

const INFLIGHT_TRUE_PR =
  "The only open PR on the Android repo right now is an unrelated one: [#340 — Checkout: show store credit applied automatically](https://github.com/acme/android/pull/340).";
const INFLIGHT_CLAIM =
  "Not up yet — the engineer was just dispatched this turn and likely hasn't opened the PR yet. " +
  INFLIGHT_TRUE_PR +
  "\n\nThe QA test PR will post back here in this thread once the engineer finishes — usually a minute or two. I'll have the link for you then.";
const LIST_PRS = [trace("ToolSearch"), trace("mcp__server__github__list_open_prs")];

describe.each(SEAMS)("%s — in-flight hand-off claim with nothing in flight", (_name, deliver) => {
  it("removes the in-flight sentences; the true PR sentence stays byte-identical", async () => {
    const out = await deliver("operator", { text: INFLIGHT_CLAIM, toolCalls: LIST_PRS });
    expect(out).toBe(INFLIGHT_TRUE_PR);
    expectNoBanner(out);
  });
});

describe.each(SEAMS)("%s — direct engineer question carrying internal terms", (_name, deliver) => {
  it("the repo question keeps its prose; repo_hint and the build repo are gone", async () => {
    const text =
      "`repo_hint` came in as `acme/ios`, which is the iOS app repo. You also have a live page on `Praxis-build/acme-6ec4d609`.\n\nWhich repo should I use?";
    const out = await deliver("engineer", { text, sideEffect: { kind: "refused" } });
    expect(out).toBe(
      "This chat was set to `acme/ios`, which is the iOS app repo. You also have a live page on the site Zavi built for you.\n\nWhich repo should I use?",
    );
    expectNoBanner(out);
  });
});

describe("web chat — a running engineer child backs a progress claim, not a this-turn one", () => {
  it("keeps the progress sentences and drops the this-turn dispatch sentence", async () => {
    const THREAD = "a2d80040-6dc6-4274-a3ba-a73d765bf980";
    fromMock.mockImplementation((table: string) =>
      table === "agent_runs"
        ? stubChain([{ id: "child-1", agent_slug: "engineer", status: "running" }])
        : stubChain([]),
    );
    fromMock.mockImplementationOnce(() => stubChain(null));
    fromMock.mockImplementationOnce(() =>
      stubChain({ tenant_id: "tenant-A", agent_slug: "operator", id: THREAD }),
    );
    fromMock.mockImplementationOnce(() =>
      stubChain({ id: "u1", thread_id: THREAD, sender_role: "user", body: "is the PR up?" }),
    );
    queueModel({ text: INFLIGHT_CLAIM, toolCalls: LIST_PRS });
    await runChat(makeCtx("operator", "chat"), { thread_id: THREAD, user_message_id: "u1" });
    const call = rpcMock.mock.calls.find((c) => c[0] === "record_agent_chat_reply");
    expect(call?.[1]?.p_body).toBe(
      INFLIGHT_TRUE_PR +
        "\n\nThe QA test PR will post back here in this thread once the engineer finishes — usually a minute or two. I'll have the link for you then.",
    );
  });
});

describe("handoff seams — engineer refused with a jargon deliverable", () => {
  const refused = deriveOutcome({
    status: "success",
    outputText: JARGON_DELIVERABLE,
    sideEffect: { kind: "refused", reason: "refused_envelope" },
  });
  const wrongRepo = deriveOutcome({
    status: "success",
    outputText: JARGON_DELIVERABLE,
    sideEffect: { kind: "refused", reason: "refused_envelope", reason_code: "wrong_repo" },
  });
  const run = (outcome: typeof refused, payload: Record<string, unknown>) => ({
    status: "success",
    output_text: JARGON_DELIVERABLE,
    error: null,
    parse_error: null,
    agent_slug: "engineer",
    outcome,
    payload,
    parsed: null,
  });

  const bodies = (outcome: typeof refused) => [
    composeHandoffBody({
      tenant_id: "tenant-A",
      run_id: "run-1",
      operator_thread_id: "t1",
      from_agent_slug: "engineer",
      status: "success",
      output_text: JARGON_DELIVERABLE,
      outcome,
    }),
    buildSlackHandoffChildText(run(outcome, { slack_handoff_child: true }) as never, "run-1"),
    whatsappReplyText(run(outcome, { whatsapp_handoff_child: true }) as never, "run-1"),
    handoffChildReplyText(run(outcome, { handoff_child: true }), "run-1"),
  ];

  it("email / Teams / Telegram / Discord children are recognised as handoff children", () => {
    expect(isHandoffChildPayload({ handoff_child: true })).toBe(true);
    expect(isHandoffChildPayload({ source: "email" })).toBe(false);
    expect(isHandoffChildPayload(null)).toBe(false);
  });

  it("no reason code → the server phrase, no internal terms, no banner", () => {
    for (const body of bodies(refused)) {
      expect(body).toBe(STATUS_PHRASES.no_change);
      expect(findInternalJargon(body)).toEqual([]);
      expectNoBanner(body);
    }
  });

  it("wrong_repo → the repo question, no internal terms, no banner", () => {
    for (const body of bodies(wrongRepo)) {
      expect(body).toBe(STATUS_PHRASES.wrong_repo);
      expect(findInternalJargon(body)).toEqual([]);
      expectNoBanner(body);
    }
  });

  it("an outcome claim with no receipt is telemetry, not a banner", () => {
    const body = composeHandoffBody({
      tenant_id: "tenant-A",
      run_id: "run-1",
      operator_thread_id: "t1",
      from_agent_slug: "growth-lead",
      status: "success",
      output_text: "Shipped the new landing page and deployed it.",
    });
    expectNoBanner(body);
    expect(loggedCodes()).toContain("receipt_unverified");
  });
});

describe("row-based reply — a run that did not finish", () => {
  it("parse_failed with a PR claim → the 'couldn't' status line leads, no banner", () => {
    const r = selectReplyTextFromRow({
      status: "parse_failed",
      output_text: "Added the favicon options. Preview-only PR against `development`.",
      error: null,
      parse_error: "head_branch must start with engineer/",
      agent_slug: "engineer",
    });
    expect(r.markdown.startsWith(STATUS_PHRASES.couldnt)).toBe(true);
    expectNoBanner(r.markdown);
    expect(r.markdown).not.toMatch(/engineer did not finish/);
  });

  it("a plan-only run gets no heads-up banner", () => {
    const r = selectReplyTextFromRow({
      status: "success",
      output_text: "Here is the referral plan.",
      error: null,
      parse_error: null,
      agent_slug: "growth-lead",
      outcome: { deliverable: "Here is the referral plan.", liveness_tier: "plan_only" },
    });
    expect(r.markdown).toBe("Here is the referral plan.");
  });
});

describe("PR notice — test status lines", () => {
  const pr = [{ base: "main", ok: true, pr_url: "https://github.com/acme/shop/pull/812", pr_number: 812 }];
  const opts = { repo: "acme/shop", title: "Fix total", head_branch: "engineer/fix-total" };

  it.each(["couldnt_run", "failed", "not_run"] as const)("%s → plain status line, no banner", (status) => {
    const msg = buildOpenPrNotice(pr, {
      ...opts,
      verify: { status, reason: "sandbox exited before run_tests" },
    });
    expectNoBanner(msg);
    expect(findInternalJargon(msg.replace(/https?:\/\/\S+/g, ""))).toEqual([]);
  });
});

const PAYMENT_TOOL = [
  trace("operator_db__query", '{"rows":[{"trip_id":15677,"pendingPaymentId":"pp_abc123456"}]}'),
];
const PAYMENT_SPECULATION =
  "Your trip is confirmed. The charge is likely an authorization hold that drops off in 3-7 days.";

describe("unread payment record — the speculation is replaced, not bannered", () => {
  it("web chat: the mechanics sentence goes, the plain next step stands", async () => {
    const out = await chatBubble("support-lead", { text: PAYMENT_SPECULATION, toolCalls: PAYMENT_TOOL });
    expect(out).toBe(`Your trip is confirmed.\n\n${PAYMENT_RECORD_UNREAD_PHRASE}`);
    expectNoBanner(out);
  });

  it("web chat false positive: the record WAS read by its id → byte-identical", async () => {
    const out = await chatBubble("support-lead", {
      text: PAYMENT_SPECULATION,
      toolCalls: [
        ...PAYMENT_TOOL,
        { ...trace("operator_db__query", '{"rows":[{"status":"failed"}]}'), input_preview: '{"id":"pp_abc123456"}' },
      ],
    });
    expect(out).toBe(PAYMENT_SPECULATION);
  });

  it("two held ids, one read: a true sentence about the READ record is byte-identical", async () => {
    const text = "Your authorization hold on this payment will drop off on Friday.";
    const tools = [
      trace("operator_db__query", '{"rows":[{"paymentIntentId":"pi_A12345","refundId":"re_B12345"}]}'),
      { ...trace("operator_db__query", '{"rows":[{"status":"requires_capture"}]}'), input_preview: '{"id":"pi_A12345"}' },
    ];
    expect(await chatBubble("support-lead", { text, toolCalls: tools })).toBe(text);
    const g = applyAutonomousGrounding({ text, toolCalls: tools, agentSlug: "support-lead" });
    expect(g.linked_record_unread).toBe(false);
  });

  it("web chat: the STORED output_text carries the same correction as the bubble", async () => {
    primeChat("support-lead");
    queueModel({ text: PAYMENT_SPECULATION, toolCalls: PAYMENT_TOOL });
    const r = await runChat(makeCtx("support-lead", "chat"), { thread_id: "t1", user_message_id: "u1" });
    expect(r.output_text).toBe(`Your trip is confirmed.\n\n${PAYMENT_RECORD_UNREAD_PHRASE}`);
  });

  it("autonomous seam (Slack / email / WhatsApp): the flag drives the same replacement", () => {
    const g = applyAutonomousGrounding({
      text: PAYMENT_SPECULATION,
      toolCalls: PAYMENT_TOOL,
      agentSlug: "support-lead",
    });
    expect(g.linked_record_unread).toBe(true);
    expect(replaceUnreadPaymentClaims(PAYMENT_SPECULATION)).toBe(
      `Your trip is confirmed.\n\n${PAYMENT_RECORD_UNREAD_PHRASE}`,
    );
    expect(replaceUnreadPaymentClaims("It will be charged closer to the trip.")).toBe(
      PAYMENT_RECORD_UNREAD_PHRASE,
    );
  });

  it("autonomous false positive: a non-payment agent is never flagged", () => {
    const g = applyAutonomousGrounding({
      text: PAYMENT_SPECULATION,
      toolCalls: PAYMENT_TOOL,
      agentSlug: "growth-lead",
    });
    expect(g.linked_record_unread).toBe(false);
  });
});

describe.each(SEAMS)("%s — unbacked send claims", (_name, deliver) => {
  it("'I sent the Slack message' with zero send tools → removed", async () => {
    const out = await deliver("growth-lead", {
      text: "The launch post is ready. I sent the Slack message to the team.",
    });
    expect(out).toBe("The launch post is ready.");
    expectNoBanner(out);
  });

  it("only the claim → the plain server phrase", async () => {
    const out = await deliver("growth-lead", { text: "I sent the email." });
    expect(out).toBe(STATUS_PHRASES.no_change);
  });

  it("false positive: a real slack__post_message → byte-identical", async () => {
    const text = "The launch post is ready. I sent the Slack message to the team.";
    const out = await deliver("growth-lead", {
      text,
      toolCalls: [trace("mcp__slack__post_message", '{"ok":true,"ts":"1.2"}')],
    });
    expect(out).toBe(text);
  });

  it("false positive: a future step → byte-identical", async () => {
    const text = "The draft is ready. I'll send the Slack message once you approve it.";
    expect(await deliver("growth-lead", { text })).toBe(text);
  });

  it("false positive: the customer's own send → byte-identical", async () => {
    const text = "You sent the email to the team on Monday, and 3 people replied.";
    expect(await deliver("growth-lead", { text })).toBe(text);
  });

  it("false positive: quoted text → byte-identical", async () => {
    const text = 'Your note said "I sent the invoice." The invoice is not in the ledger yet.';
    expect(await deliver("growth-lead", { text })).toBe(text);
  });
});

describe("operator hand-off repo picker — the pick resumes the pending task", () => {
  const PICKER = JSON.stringify({
    ok: true,
    needs_repo_pick: true,
    message: "I need a repo to work in. Pick one: acme/shop, acme/site",
    meta: {
      awaiting_repo_pick: true,
      repos: ["acme/shop", "acme/site"],
      pending_task_description: "Fix the checkout total",
    },
  });

  it("the picker meta is persisted on the operator's reply", async () => {
    await chatBubble("operator", {
      text: "Which repo should I use: acme/shop or acme/site?",
      toolCalls: [trace("mcp__server__praxis__handoff", JSON.stringify([{ type: "text", text: PICKER }]))],
    });
    const call = rpcMock.mock.calls.find((c) => c[0] === "record_agent_chat_reply");
    expect(call?.[1]?.p_meta).toMatchObject({
      awaiting_repo_pick: true,
      repos: ["acme/shop", "acme/site"],
      pending_task_description: "Fix the checkout total",
    });
  });

  it("the next turn naming a listed repo resumes the pending task on that repo", async () => {
    const updates: unknown[] = [];
    fromMock.mockImplementation(() => stubChain([]));
    fromMock.mockImplementationOnce(() => stubChain(null));
    fromMock.mockImplementationOnce(() => stubChain({ tenant_id: "tenant-A", agent_slug: "operator", id: "t1" }));
    fromMock.mockImplementationOnce(() =>
      stubChain({ id: "u2", thread_id: "t1", sender_role: "user", body: "acme/site", created_at: "2026-09-22" }),
    );
    fromMock.mockImplementationOnce(() =>
      stubChain([
        {
          meta: {
            awaiting_repo_pick: true,
            repos: ["acme/shop", "acme/site"],
            pending_task_description: "Fix the checkout total",
          },
          agent_run_id: "run-0",
        },
      ]),
    );
    fromMock.mockImplementationOnce(() => {
      const c = stubChain(null) as Record<string, unknown>;
      c.update = vi.fn((row: unknown) => {
        updates.push(row);
        return c;
      });
      return c;
    });
    queueModel({ text: "On it." });
    await runChat(makeCtx("operator", "chat"), { thread_id: "t1", user_message_id: "u2" });
    expect(updates).toContainEqual({ repo_full_name: "acme/site" });
    const payload = runGenericMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.repo_hint).toBe("acme/site");
    expect(payload.task_description).toBe("Fix the checkout total");
  });
});

describe("other customer writes carry no warning glyph", () => {
  it("launch-video silent notices state the fact without ⚠ / Heads up", () => {
    for (const ttsBlocked of [null, "credential_rejected"] as const) {
      const d = describeVoOutcome({ authoredVoBeats: 3, voicedBeats: 0, ttsBlocked: ttsBlocked as never });
      expect(d.notice).toMatch(/no voiceover/i);
      expectNoBanner(d.notice ?? undefined);
      expect(d.notice).not.toMatch(/Heads up/i);
    }
  });

  it("the Slack ship-red approval response has no ⚠", () => {
    const src = readFileSync(join(__dirname, "../../../routes/webhooks/slack-interactions.ts"), "utf8");
    const m = src.match(/updateSlackMessage\(\s*payload\.response_url,\s*"([^"]*broke a test[^"]*)"/);
    expect(m?.[1]).toBeDefined();
    expectNoBanner(m?.[1]);
  });
});

describe("negative-existence correction reaches customer_summary", () => {
  const FALSE_ABSENCE = "There is no `respondToCarReview` endpoint.";
  function proveExists(): void {
    mocks.neOverride = ({ reply }) => ({
      hedged: true,
      text: reply,
      without_false_claims: reply.replace(FALSE_ABSENCE, "").trim() || "I found it in your repo.",
      flags: {
        has_claim: true,
        claims_checked: 1,
        corrected_symbols: ["respondToCarReview"],
        false_claim_symbols: ["respondToCarReview"],
        false_claims: [{ kind: "endpoint", symbol: "respondToCarReview" }],
      },
    });
  }

  it("runner seam: a summary carrying a disproved claim is dropped whole (the projection falls back to the corrected deliverable)", async () => {
    proveExists();
    fromMock.mockImplementation(() => stubChain([]));
    queueModel({ text: `${FALSE_ABSENCE} I can add the handler next.`, customerSummary: FALSE_ABSENCE });
    const only = await runDispatch(makeCtx("engineer", "slack"), {});
    expect(only.customer_summary).toBeUndefined();

    queueModel({
      text: `${FALSE_ABSENCE} I can add the handler next.`,
      customerSummary: `${FALSE_ABSENCE} The review form posts to the reviews API.`,
    });
    const mixed = await runDispatch(makeCtx("engineer", "slack"), {});
    expect(mixed.customer_summary).toBeUndefined();
  });

  it("chat seam: the same correction on customer_summary", async () => {
    proveExists();
    primeChat("engineer");
    queueModel({
      text: `${FALSE_ABSENCE} I can add the handler next.`,
      customerSummary: `${FALSE_ABSENCE} The review form posts to the reviews API.`,
    });
    const r = await runChat(makeCtx("engineer", "chat"), { thread_id: "t1", user_message_id: "u1" });
    expect(r.customer_summary).toBeUndefined();
  });
});

describe("Slack's earlier turns get the same action-claim pass", () => {
  it("a proposal-only run: the turn saying 'I raised it' is corrected, the plain turn stays", async () => {
    fromMock.mockImplementation(() => stubChain([]));
    const card = trace(
      "meta_ads__propose_budget_change",
      JSON.stringify({ decision_id: "d1", decision_class: "meta_ads.update_ad_set_budget_review" }),
    );
    runGenericMock.mockResolvedValue({
      output_text: "Check the card when you can.",
      parsed: null,
      parse_ok: true,
      raw_response_text: "Check the card when you can.",
      prompt_snapshot: "",
      usage: { input_tokens: 1, output_tokens: 1 },
      tool_calls: [card],
      assistant_turns: ["Your best ad set is Weekend promo. I raised its budget to $144 a day.", "Check the card when you can."],
    });
    const r = await runDispatch(makeCtx("cgo", "slack"), {});
    expect(r.assistant_turns).toEqual([
      "Your best ad set is Weekend promo. I sent this change to you for approval.",
      "Check the card when you can.",
    ]);
  });
});

