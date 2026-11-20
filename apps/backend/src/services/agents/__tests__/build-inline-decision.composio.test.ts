import { describe, it, expect, vi } from "vitest";
import {
  buildInlineDecisionBody,
  maybeEmitInlineConfirmCard,
  type MaybeEmitInlineCardInput,
} from "../build-inline-decision";

const DECISION_ID = "22222222-2222-4222-8222-222222222222";
const body = {
  kind: "composio_write",
  app_name: "Square",
  action: "Create refund",
  tool_slug: "SQUARE_CREATE_REFUND",
  arguments: { amount: 500, note: "customer secret note" },
  labels: ["moves_money"],
  fingerprint: "a".repeat(64),
};

describe("buildInlineDecisionBody — Composio write", () => {
  for (const cls of ["composio.write", "composio.moves_money", "composio.deletes_data"]) {
    it(`${cls}: names the decision, app and action only`, () => {
      const card = buildInlineDecisionBody({ decision_id: DECISION_ID, decision_class: cls, body });
      expect(card).toEqual({ decision_id: DECISION_ID, decision_class: cls, title: "Square: Create refund" });
      expect(JSON.stringify(card)).not.toContain("secret");
    });
  }
  it("a composio class without a composio_write body gets no card", () => {
    expect(buildInlineDecisionBody({ decision_id: DECISION_ID, decision_class: "composio.write", body: {} })).toBeNull();
  });
  it("falls back to the tool slug when the action words are missing", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "composio.write",
      body: { kind: "composio_write", tool_slug: "NOTION_CREATE_PAGE" },
    });
    expect(card?.title).toBe("App: NOTION_CREATE_PAGE");
  });
});

describe("maybeEmitInlineConfirmCard — Composio write", () => {
  const input: MaybeEmitInlineCardInput = {
    decision_id: DECISION_ID,
    decision_class: "composio.moves_money",
    body,
    run_trigger: "chat",
    thread_id: "33333333-3333-4333-8333-333333333333",
    agent_run_id: "44444444-4444-4444-8444-444444444444",
    agent_slug: "operator",
    tenant_id: "55555555-5555-4555-8555-555555555555",
  };
  it("emits the card into the chat thread with both flags OFF", async () => {
    const emit = vi.fn(async () => {});
    const ok = await maybeEmitInlineConfirmCard(input, {
      isSpendFlagOn: async () => false,
      isUrgentCardsFlagOn: async () => false,
      emit,
    });
    expect(ok).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "decision", thread_id: input.thread_id, body: expect.objectContaining({ decision_id: DECISION_ID }) }),
    );
  });
  it("a scheduled run (no chat thread) emits nothing: Home keeps the full card", async () => {
    const emit = vi.fn(async () => {});
    const deps = { isSpendFlagOn: async () => true, isUrgentCardsFlagOn: async () => true, emit };
    expect(await maybeEmitInlineConfirmCard({ ...input, run_trigger: "scheduled" }, deps)).toBe(false);
    expect(await maybeEmitInlineConfirmCard({ ...input, thread_id: null }, deps)).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
