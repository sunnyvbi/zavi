import { describe, expect, it } from "vitest";
import { toActionView } from "../channel-actions";

const hold = {
  reasons: ["chatgpt_wallet_insufficient", "learning_lock"],
  words: ["the prepaid ChatGPT wallet cannot cover this campaign schedule; add balance or choose a smaller experiment"],
  evidence: "Wallet $12, schedule needs $140.",
  at: "2026-10-16T10:00:00Z",
};

const row = (over: Record<string, unknown>) =>
  ({
    id: "ca-1", channel_slug: "chatgpt_ads", run_id: "run-1", position: 1, run_of: 1, blocking: false,
    action_type: "launch_campaign", title: "Launch a ChatGPT test", body: {}, status: "pending", note: null,
    snoozed_until: null, impact: null, impact_reason: null, proposed_at: "2026-10-16T00:00:00Z",
    repeat_of: null, redo_of: null, exec_class: "chatgpt_ads.create_campaign", exec_status: null, cgo_hold: hold, ...over,
  }) as never;

describe("the hold on the wire", () => {
  it("a pending card nobody approved yet serves the hold's words, evidence and wallet_short", () => {
    const v = toActionView(row({}), 1, {});
    expect(v.held).toEqual({ words: hold.words, evidence: hold.evidence, wallet_short: true });
    expect(JSON.stringify(v)).not.toContain("chatgpt_wallet_insufficient");
    expect(JSON.stringify(v)).not.toContain("learning_lock");
    expect(v).not.toHaveProperty("cgo_hold");
  });

  it("a hold with no wallet reason is not wallet_short", () => {
    const v = toActionView(row({ cgo_hold: { ...hold, reasons: ["pause_needs_founder"] } }), 1, {});
    expect(v.held?.wallet_short).toBe(false);
  });

  it("is absent once the card moved: approved, executing, executed, failed, dismissed", () => {
    for (const exec_status of ["queued", "dispatching", "executed", "failed"]) {
      expect(toActionView(row({ exec_status }), 1, {}).held, exec_status).toBeNull();
    }
    for (const status of ["acted", "dismissed", "displaced", "snoozed"]) {
      expect(toActionView(row({ status }), 1, {}).held, status).toBeNull();
    }
  });

  it("is absent with no hold, or one that does not parse", () => {
    for (const cgo_hold of [null, undefined, "held", [], {}, { words: [] }, { words: [5] }]) {
      expect(toActionView(row({ cgo_hold }), 1, {}).held, JSON.stringify(cgo_hold)).toBeNull();
    }
  });
});
