import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSideEffectingTool, INTERNAL_SERVERS } from "../tool-effect-classifier";

describe("isSideEffectingTool — declaration-derived, fail-safe to guarded", () => {
  it("guards declared internal writes", () => {
    expect(isSideEffectingTool("slack", "post_message")).toBe(true);
    expect(isSideEffectingTool("email", "send")).toBe(true);
    expect(isSideEffectingTool("github", "open_pr")).toBe(true);
    expect(isSideEffectingTool("stripe", "create_payment")).toBe(true);
    expect(isSideEffectingTool("jira", "create_issue")).toBe(true);
    expect(isSideEffectingTool("praxis", "action")).toBe(true);
    expect(isSideEffectingTool("praxis", "handoff")).toBe(true);
    expect(isSideEffectingTool("memory", "write")).toBe(true);
    expect(isSideEffectingTool("connectors", "request")).toBe(true);
    expect(isSideEffectingTool("growth", "propose_creative_brief")).toBe(true);
  });

  it("does NOT guard declared reads on read-only servers", () => {
    expect(isSideEffectingTool("web_search", "search")).toBe(false);
    expect(isSideEffectingTool("web_fetch", "fetch")).toBe(false);
    expect(isSideEffectingTool("apify", "scrape_instagram")).toBe(false);
    expect(isSideEffectingTool("praxis_corpus", "read_run_output")).toBe(false);
  });

  it("does NOT guard declared reads on mixed servers, whatever their name", () => {
    expect(isSideEffectingTool("memory", "search")).toBe(false);
    expect(isSideEffectingTool("memory", "read")).toBe(false);
    expect(isSideEffectingTool("slack", "get_channel_history")).toBe(false);
    expect(isSideEffectingTool("operator_db", "query")).toBe(false);
    expect(isSideEffectingTool("operator_db", "catalog")).toBe(false);
    expect(isSideEffectingTool("meta_ads", "analyst_brief")).toBe(false);
    expect(isSideEffectingTool("growth", "constraint_diagnosis")).toBe(false);
    expect(isSideEffectingTool("github", "grep")).toBe(false);
    expect(isSideEffectingTool("jira", "search")).toBe(false);
    expect(isSideEffectingTool("linear", "search")).toBe(false);
    expect(isSideEffectingTool("reddit", "thread_read")).toBe(false);
  });

  it("does NOT guard remote/streamable servers (handled separately, HF has own guard)", () => {
    expect(isSideEffectingTool("higgsfield", "generate_video")).toBe(false);
    expect(isSideEffectingTool("composio", "gmail_send")).toBe(false);
    expect(isSideEffectingTool("pipedream:abc", "anything")).toBe(false);
  });

  it("fail-safe: an UNDECLARED tool on an internal server is a write, even with a read-looking name", () => {
    expect(isSideEffectingTool("slack", "schedule_message")).toBe(true);
    expect(isSideEffectingTool("growth", "fire_campaign")).toBe(true);
    expect(isSideEffectingTool("slack", "get_everything_new")).toBe(true);
    expect(isSideEffectingTool("web_search", "list_new_thing")).toBe(true);
  });
});

describe("INTERNAL_SERVERS stays in sync with execute.ts dispatch branches", () => {
  it("every server_id branch in execute.ts dispatchMcpToolRaw is in INTERNAL_SERVERS", () => {
    const src = readFileSync(join(__dirname, "..", "execute.ts"), "utf8");
    const branches = new Set(
      [...src.matchAll(/server_id === "([a-z_]+)"/g)].map((m) => m[1]),
    );
    expect(branches.size).toBeGreaterThanOrEqual(15);
    const REMOTE_PRECHECKS = new Set(["composio"]);
    const missing = [...branches].filter((s) => !INTERNAL_SERVERS.has(s) && !REMOTE_PRECHECKS.has(s));
    expect(missing, `internal servers missing from INTERNAL_SERVERS: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("stripe reads pass, stripe writes stay guarded (G2)", () => {
  it("retrieve_dispute + retrieve_payout are reads", () => {
    expect(isSideEffectingTool("stripe", "retrieve_dispute")).toBe(false);
    expect(isSideEffectingTool("stripe", "retrieve_payout")).toBe(false);
  });

  it("the other stripe reads are unchanged", () => {
    for (const t of [
      "list_charges",
      "list_payouts",
      "list_customers",
      "list_invoices",
      "list_payment_intents",
      "search_stripe_resources",
    ]) {
      expect(isSideEffectingTool("stripe", t), t).toBe(false);
    }
  });

  it("EVERY stripe write is still side-effecting → governed → approval-gated", () => {
    for (const t of [
      "submit_dispute_evidence",
      "create_payment",
      "remit_to_tenant",
      "create_connected_account",
      "refund_charge",
      "accept_dispute",
      "some_future_stripe_mutation",
    ]) {
      expect(isSideEffectingTool("stripe", t), t).toBe(true);
    }
  });
});
