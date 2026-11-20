import { describe, it, expect, vi, beforeEach } from "vitest";

const logEventMock = vi.hoisted(() => vi.fn(async (_input: { code?: string }) => {}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: logEventMock }));

import { verifyReceipt } from "../receipt-verifier";
import { composeHandoffBody } from "../handoff-result";

describe("receipt-verifier — verifyReceipt", () => {
  it("outcome claim + NO receipt → hedged (fabricated-success guard)", () => {
    const r = verifyReceipt({ body: "✅ shipped the PR and deployed the fix." });
    expect(r.hedged).toBe(true);
    expect(r.text).toMatch(/Unverified result/);
    expect(r.text).toContain("shipped the PR");
  });

  it("outcome claim + PR URL in prose but NO evidence → HEDGED (#14: prose is not self-certifying)", () => {
    const r = verifyReceipt({
      body: "Opened a PR: https://github.com/rravi149/praxis/pull/412",
    });
    expect(r.hedged).toBe(true);
    expect(r.flags.receipt_in_body).toBe(false);
  });

  it("outcome claim + PR URL in prose AND corroborating evidence → not hedged", () => {
    const r = verifyReceipt({
      body: "Opened a PR: https://github.com/rravi149/praxis/pull/412",
      evidence: { pr_url: "https://github.com/rravi149/praxis/pull/412" },
    });
    expect(r.hedged).toBe(false);
    expect(r.flags.receipt_in_body).toBe(true);
    expect(r.flags.receipt_in_evidence).toBe(true);
  });

  it("outcome claim + bare #1234 ref in body → HEDGED (#14: a bare ref is never a receipt)", () => {
    const r = verifyReceipt({ body: "Filed a ticket #1234 for the overcharge." });
    expect(r.hedged).toBe(true);
  });

  it("outcome claim + structured pr_url evidence → not hedged", () => {
    const r = verifyReceipt({
      body: "Shipped the fix.",
      evidence: { pr_url: "https://github.com/rravi149/praxis/pull/77" },
    });
    expect(r.hedged).toBe(false);
    expect(r.flags.receipt_in_evidence).toBe(true);
  });

  it("outcome claim + side-effecting tool actually ran → not hedged", () => {
    const r = verifyReceipt({
      body: "Posted the summary to the Slack thread.",
      evidence: { tool_names: ["memory__search", "slack__post_message"] },
    });
    expect(r.hedged).toBe(false);
  });

  it("outcome claim + only NON-side-effecting tools → hedged", () => {
    const r = verifyReceipt({
      body: "✅ shipped it.",
      evidence: { tool_names: ["memory__search", "operator_db__query_user"] },
    });
    expect(r.hedged).toBe(true);
  });

  it("outcome claim + a READ-ONLY slack tool → HEDGED (#14: slack__ substring is not a write)", () => {
    const r = verifyReceipt({
      body: "Posted the summary to the Slack thread.",
      evidence: { tool_names: ["slack__list_channels"] },
    });
    expect(r.hedged).toBe(true);
  });

  it("NO outcome claim (plain answer) → never hedged (false-positive guard)", () => {
    const r = verifyReceipt({
      body: "Trip 10927 was overcharged $493 due to asymmetric drift. Here's why…",
    });
    expect(r.hedged).toBe(false);
    expect(r.flags.has_outcome_claim).toBe(false);
  });

  it("empty body → not hedged", () => {
    expect(verifyReceipt({ body: "" }).hedged).toBe(false);
  });

  it("PII-safe: banner NEVER echoes evidence content (tool names / outputs)", () => {
    const r = verifyReceipt({
      body: "✅ shipped it.",
      evidence: { tool_names: ["secret__internal_tool_name_xyz"] },
    });
    expect(r.hedged).toBe(true);
    expect(r.text).not.toContain("secret__internal_tool_name_xyz");
  });
});

describe("receipt-verifier — composeHandoffBody wiring", () => {
  const base = {
    tenant_id: "t1",
    run_id: "r1",
    operator_thread_id: "th1",
    from_agent_slug: "engineer",
  };

  beforeEach(() => {
    logEventMock.mockClear();
  });
  const receiptEvents = () =>
    logEventMock.mock.calls.filter((c) => (c[0] as { code?: string }).code === "receipt_unverified");

  it("success body claiming shipped, no receipt → TELEMETRY, never a banner (Slice 3)", () => {
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: "✅ Shipped the fix and deployed it.",
    });
    expect(body).not.toMatch(/Unverified|⚠/);
    expect(receiptEvents()).toHaveLength(1);
  });

  it("success body claiming shipped WITH a tool receipt → no banner", () => {
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: "Shipped the fix.",
      evidence: { tool_names: ["github__create_pr"] },
    });
    expect(body).not.toMatch(/Unverified result/);
  });

  it("success body claiming a PR with a URL in prose but NO evidence → telemetry (#14: prose is not self-certifying), no banner", () => {
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: "Opened a PR — https://github.com/rravi149/praxis/pull/9",
    });
    expect(body).not.toMatch(/Unverified|⚠/);
    expect(receiptEvents()).toHaveLength(1);
  });

  it("success body claiming a PR WITH corroborating evidence → no banner", () => {
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: "Opened a PR — https://github.com/rravi149/praxis/pull/9",
      evidence: { pr_url: "https://github.com/rravi149/praxis/pull/9" },
    });
    expect(body).not.toMatch(/Unverified result/);
  });

  it("plain success answer (no outcome claim) → unchanged", () => {
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: "The booking shows a 2-day trip with no anomalies.",
    });
    expect(body).not.toMatch(/Unverified result/);
    expect(body).toContain("no anomalies");
  });

  it("error / parse_failed bodies are never receipt-hedged (success-only)", () => {
    const errBody = composeHandoffBody({
      ...base,
      status: "error",
      error: "shipped nothing — the run failed",
    });
    expect(errBody).not.toMatch(/Unverified result/);
  });
});
