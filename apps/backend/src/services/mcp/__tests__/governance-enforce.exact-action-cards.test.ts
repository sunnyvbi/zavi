
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/settings", () => ({ getStringSetting: async () => "enforce" }));
const h = vi.hoisted(() => {
  const state = {
    autonomy: "approval",
    runRow: { trigger: "cron", payload: {} as Record<string, unknown> },
    held: null as null | Record<string, unknown>,
    heldError: false,
  };
  const rowClient = () => ({
    rpc: async () => ({ data: state.autonomy, error: null }),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.runRow, error: null }) }) }) }),
  });
  return { state, rowClient };
});
vi.mock("@/services/supabase", () => ({ serviceClient: h.rowClient }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...((await orig()) as object),
  tenantClient: () => h.rowClient(),
}));
vi.mock("@/services/agents/run-stop", () => ({ isRunStopRequested: async () => false }));
vi.mock("@/services/agents/kill-switch", () => ({ isAgentKilled: async () => false }));
vi.mock("../streamable-client", () => ({ advertisedReadToolNames: () => undefined }));
vi.mock("@/services/tools/stripe/held-funds", () => ({
  findHeldFundByRef: async (_t: string, ref: string) => {
    if (h.state.heldError) throw new Error("db down");
    return ref === h.state.held?.client_reference ? h.state.held : null;
  },
}));
vi.mock("@/services/provisioning/provisioned-repo-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/provisioning/provisioned-repo-gate")>()),
  assertProvisionedRepoTarget: async () => ({ ok: false, reason: "customer-repo" }),
}));

import { governActionOrBlock } from "../governance-enforce";
import { TOOL_DECISION_CLASS } from "../governance-verdict";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const ctx = { tenant_id: TENANT, run_id: "11111111-1111-4111-8111-111111111111", agent_slug: "support-lead" };
const code = (g: Awaited<ReturnType<typeof governActionOrBlock>>) => {
  if (!g.block) return null;
  const r = JSON.parse((g.result as { content: string }).content) as { error?: string; message?: string };
  return { code: r.error, error: r.message };
};

beforeEach(() => {
  h.state.autonomy = "approval";
  h.state.runRow = { trigger: "cron", payload: {} };
  h.state.held = null;
  h.state.heldError = false;
});

describe("email: the card is the exact message", () => {
  const email = { to: "jane@acme.test", subject: "Your refund", body_text: "Hi Jane, your refund is on its way." };

  it("queues a send_email card carrying to, subject and body, and says it has not run", async () => {
    const emit = vi.fn(async () => "dec-1");
    const g = await governActionOrBlock({ ...ctx, emit_decision: emit }, "email", "send", email);
    expect(g.block).toBe(true);
    expect(code(g)?.code).toBe("pending_approval");
    expect(emit).toHaveBeenCalledWith("send_email", expect.objectContaining(email));
  });

  it("must not refuse legitimate emails (plus addresses, unicode, long bodies, optional fields)", async () => {
    const ok = [
      { to: "jane+billing@acme.co.uk", subject: "Re: order #123", body_text: "Grüße, Jürgen" },
      { to: "a@b.io", subject: "x".repeat(200), body_text: "y".repeat(2_400) },
      { to: "ops@acme.test", subject: "Weekly", body_text: "See below", reply_to: "founder@acme.test" },
    ];
    for (const e of ok) {
      const emit = vi.fn(async () => "dec-1");
      const g = await governActionOrBlock({ ...ctx, emit_decision: emit }, "email", "send", e);
      expect(code(g)?.code, e.to).toBe("pending_approval");
      expect(emit).toHaveBeenCalledWith("send_email", expect.objectContaining(e));
    }
  });

  it("an HTML body is dropped: the card and the send are the text the founder sees", async () => {
    const emit = vi.fn(async (_c: string, _b: unknown) => "dec-1");
    await governActionOrBlock({ ...ctx, emit_decision: emit }, "email", "send", { ...email, body_html: "<p>Pay to account 999</p>" });
    expect(emit.mock.calls[0][1]).not.toHaveProperty("body_html");
  });

  it("a message longer than Slack can show in full is refused, with the reason", async () => {
    const emit = vi.fn(async () => "dec-1");
    const g = await governActionOrBlock({ ...ctx, emit_decision: emit }, "email", "send", { ...email, body_text: "y".repeat(2_401) });
    expect(code(g)?.code).toBe("invalid_action");
    expect(code(g)?.error).toMatch(/at most 2400 characters so the founder can read all of it/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("an email-triggered run cannot card a reply to its own sender (that reply is automatic)", async () => {
    h.state.runRow = { trigger: "email", payload: { email: { from: "Jane@Acme.test" } } };
    const emit = vi.fn(async () => "dec-1");
    const g = await governActionOrBlock({ ...ctx, emit_decision: emit }, "email", "send", email);
    expect(code(g)?.code).toBe("reply_is_automatic");
    expect(emit).not.toHaveBeenCalled();
    const g2 = await governActionOrBlock({ ...ctx, emit_decision: emit }, "email", "send", { ...email, to: "ops@acme.test" });
    expect(code(g2)?.code).toBe("pending_approval");
  });

  it("an incomplete email is refused with the reason, and no card is queued", async () => {
    const emit = vi.fn(async () => "dec-1");
    const g = await governActionOrBlock({ ...ctx, emit_decision: emit }, "email", "send", { to: "not-an-address", subject: "" });
    expect(code(g)?.code).toBe("invalid_action");
    expect(code(g)?.error).toMatch(/to must be a valid email address/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a secret smuggled into the body is scrubbed before the card is built", async () => {
    const emit = vi.fn(async (_c: string, _b: unknown) => "dec-1");
    await governActionOrBlock({ ...ctx, emit_decision: emit }, "email", "send", {
      ...email,
      body_text: "key: sk_live_51H8aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef",
    });
    expect(String((emit.mock.calls[0][1] as { body_text?: string }).body_text)).not.toContain("sk_live_51H8aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef");
  });
});

async function cardFor(server: string, tool: string, args: unknown) {
  const emit = vi.fn(async (_c: string, _b: unknown) => "dec-1");
  const g = await governActionOrBlock({ ...ctx, emit_decision: emit }, server, tool, args);
  const c = code(g);
  if (c?.code !== "pending_approval") return { refused: c, cls: null, body: null };
  const [cls, body] = emit.mock.calls[0];
  return { refused: null, cls, body: body as Record<string, unknown> };
}

describe("every governed tool files its exact action", () => {
  it("Jira and Linear: the card is the issue or comment, under the tool's class", async () => {
    const jira = await cardFor("jira", "create_issue", { project_key: "OPS", summary: "Refund stuck", description_markdown: "Details" });
    expect(jira.cls).toBe("create_jira_issue");
    expect(jira.body).toMatchObject({ project_key: "OPS", issue_type: "Task", summary: "Refund stuck", description_markdown: "Details", governed_by: "chokepoint" });
    expect((await cardFor("linear", "add_comment", { issue_id: "LIN-1", body_markdown: "Done" })).body).toMatchObject({ issue_id: "LIN-1", body_markdown: "Done" });
    expect((await cardFor("jira", "add_comment", { issue_key: "OPS-1" })).refused?.code).toBe("invalid_action");
  });

  it("a charge is the exact amount, fee and reference, sealed for the web card", async () => {
    const r = await cardFor("stripe", "create_payment", { amount: 1999, application_fee_amount: 100, client_reference: "order-7", receipt_email: "a@b.co" });
    expect(r.cls).toBe("stripe.create_payment");
    expect(r.body).toMatchObject({ amount: 1999, currency: "usd", application_fee_amount: 100, client_reference: "order-7", receipt_email: "a@b.co" });
    expect(r.body?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await cardFor("stripe", "create_payment", { amount: 100, application_fee_amount: 100, client_reference: "x" })).refused?.error).toMatch(/fee must be less than the amount/);
    expect((await cardFor("stripe", "create_payment", { amount: 500_001, client_reference: "x" })).refused?.code).toBe("invalid_action");
  });

  it("a payout shows what will move, read from the held collection", async () => {
    h.state.held = { id: "hf-1", client_reference: "order-7", status: "held", currency: "usd", amount_minor: 10_000, reserve_held_minor: 1_000, platform_fee_minor: 500 };
    const r = await cardFor("stripe", "remit_to_tenant", { client_reference: "order-7" });
    expect(r.cls).toBe("stripe.remit_to_tenant");
    expect(r.body).toMatchObject({ held_fund_id: "hf-1", gross_minor: 10_000, reserve_minor: 1_000, fee_minor: 500, net_minor: 8_500, currency: "usd" });
    expect(r.body?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a payout with nothing held, or an unreadable ledger, is refused", async () => {
    expect((await cardFor("stripe", "remit_to_tenant", { client_reference: "nope" })).refused?.error).toMatch(/no held collection ready/);
    h.state.held = { id: "hf-1", client_reference: "r", status: "remitted", currency: "usd", amount_minor: 1, reserve_held_minor: 0, platform_fee_minor: 0 };
    expect((await cardFor("stripe", "remit_to_tenant", { client_reference: "r" })).refused?.error).toMatch(/it is remitted/);
    h.state.heldError = true;
    expect((await cardFor("stripe", "remit_to_tenant", { client_reference: "r" })).refused?.error).toMatch(/Could not read the held collection/);
  });

  it("dispute evidence is a draft by default; a final submit files under its owner/admin-only class", async () => {
    const draft = await cardFor("stripe", "submit_dispute_evidence", { dispute_id: "du_123", evidence: { receipt: "Paid", uncategorized_text: "" } });
    expect(draft.cls).toBe("dispute-response.submit-evidence");
    expect(draft.body).toMatchObject({ evidence_packet: { dispute_id: "du_123", evidence_fields: { receipt: "Paid" } }, submit_final: false });
    const final = await cardFor("stripe", "submit_dispute_evidence", { dispute_id: "du_123", evidence: { receipt: "Paid" }, submit: true });
    expect(final.cls).toBe("dispute-response.final-submit-evidence");
    expect(final.body?.submit_final).toBe(true);
  });

  it("dispute evidence carrying customer PII is refused, not trimmed", async () => {
    const r = await cardFor("stripe", "submit_dispute_evidence", { dispute_id: "du_1", evidence: { receipt: "x", customer_email_address: "c@d.co" } });
    expect(r.refused?.error).toMatch(/cannot be sent from a direct call: customer_email_address/);
  });

  it("a pull request is the proposal the PR dispatcher validates, under an approval-only class", async () => {
    const files = [{ path: "a.ts", action: "modify", content: "x\ny" }];
    const r = await cardFor("github", "open_pr", { owner: "acme", repo: "web", base_branch: "main", head_branch: "engineer/fix", title: "Fix", files });
    expect(r.cls).toBe("github.open_pr_direct");
    expect(r.body).toMatchObject({ repo: "acme/web", base_branch: "main", head_branch: "engineer/fix", title: "Fix", files });
    expect((await cardFor("github", "open_pr", { owner: "acme", repo: "web", base_branch: "main", head_branch: "feature/x", title: "Fix", files })).refused?.error).toMatch(/engineer\//);
    const push = await cardFor("github", "push_to_main", { owner: "acme", repo: "web", title: "Ship", files });
    expect(push.cls).toBe("github.open_pr_direct");
    expect(push.body).toMatchObject({ push_to_main: true, base_branch: "main" });
    expect(String(push.body?.head_branch)).toMatch(/^engineer\//);
  });

  it("a merge is its own approval-only class", async () => {
    const r = await cardFor("github", "squash_merge", { owner: "acme", repo: "web", pull_number: 12, commit_title: "Fix" });
    expect(r.cls).toBe("github.merge_pr_direct");
    expect(r.body).toMatchObject({ owner: "acme", repo: "web", pull_number: 12, commit_title: "Fix" });
  });

  it("Slack set to approval is still refused with a reason", async () => {
    expect((await cardFor("slack", "post_message", { channel: "C1", text: "hi" })).refused?.code).toBe("typed_card_required");
  });

  it("no card anywhere carries only the tool name", async () => {
    const emit = vi.fn(async (_c: string, _b: unknown) => "dec-1");
    for (const key of Object.keys(TOOL_DECISION_CLASS)) {
      const [server, ...rest] = key.split("__");
      await governActionOrBlock({ ...ctx, emit_decision: emit }, server, rest.join("__"), {});
    }
    for (const [, body] of emit.mock.calls) {
      expect(Object.keys(body as Record<string, unknown>).filter((k) => !["server_id", "tool_name", "governed_by"].includes(k)).length).toBeGreaterThan(0);
    }
  });
});

describe("unchanged paths", () => {
  it("an auto class still runs inline (no card, no refusal)", async () => {
    h.state.autonomy = "auto";
    const emit = vi.fn(async () => "dec-1");
    const g = await governActionOrBlock({ ...ctx, emit_decision: emit }, "slack", "post_message", { channel: "C1", text: "hi" });
    expect(g.block).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

});
