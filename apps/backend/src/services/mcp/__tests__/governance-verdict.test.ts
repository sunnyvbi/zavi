import { describe, it, expect } from "vitest";
import {
  resolveGovernanceVerdict,
  GOVERNED_EXTERNAL_SERVERS,
  TOOL_DECISION_CLASS,
} from "../governance-verdict";

const INTERNAL = new Set([
  "slack", "email", "jira", "linear", "github", "stripe", "meta_ads",
  "google_ads", "buffer", "report", "memory", "brain", "operator_db", "praxis",
]);
const isInternal = (s: string) => INTERNAL.has(s);

describe("resolveGovernanceVerdict", () => {
  it("governs a mapped external write (stripe money) → mapped, class set", () => {
    const v = resolveGovernanceVerdict("stripe", "create_payment", isInternal);
    expect(v.governed).toBe(true);
    expect(v.mapped).toBe(true);
    expect(v.decision_class).toBe("stripe.create_payment");
  });

  it("governs Slack outbound (all three shapes) → slack.teammate_message (auto) class", () => {
    for (const t of ["post_message", "open_dm", "upload_file"]) {
      const v = resolveGovernanceVerdict("slack", t, isInternal);
      expect(v.governed).toBe(true);
      expect(v.decision_class).toBe("slack.teammate_message");
    }
  });

  it("FAIL-CLOSED: an UNMAPPED external write on a governed server → governed but unmapped (→approval upstream)", () => {
    const v = resolveGovernanceVerdict("stripe", "some_new_write_tool", isInternal);
    expect(v.governed).toBe(true);
    expect(v.mapped).toBe(false);
    expect(v.decision_class).toBeNull();
  });

  it("does NOT govern a declared read on a governed server (slack history)", () => {
    const v = resolveGovernanceVerdict("slack", "get_channel_history", isInternal);
    expect(v.governed).toBe(false);
  });

  it("an UNDECLARED tool on a governed server is governed, even with a read-looking name", () => {
    expect(resolveGovernanceVerdict("slack", "history", isInternal).governed).toBe(true);
    expect(resolveGovernanceVerdict("slack", "get_new_thing", isInternal).governed).toBe(true);
  });

  it("jira / linear declared reads are no longer governed; their writes still are", () => {
    for (const [s, t] of [
      ["jira", "search"],
      ["jira", "count"],
      ["jira", "lookup_account_id"],
      ["jira", "atlassian_user_info"],
      ["linear", "search"],
    ]) {
      expect(resolveGovernanceVerdict(s, t, isInternal).governed, `${s}__${t}`).toBe(false);
    }
    for (const [s, t] of [
      ["jira", "create_issue"],
      ["jira", "add_comment"],
      ["linear", "create_issue"],
      ["linear", "add_comment"],
    ]) {
      expect(resolveGovernanceVerdict(s, t, isInternal).governed, `${s}__${t}`).toBe(true);
    }
  });

  it("does NOT govern internal bookkeeping writes (memory/brain/report)", () => {
    for (const [s, t] of [["memory", "write"], ["brain", "apply_anchor"], ["report", "render_pdf"]]) {
      const v = resolveGovernanceVerdict(s, t, isInternal);
      expect(v.governed).toBe(false);
    }
  });

  it("does NOT govern the ads propose_* path (self-governing; not in GOVERNED_EXTERNAL_SERVERS)", () => {
    const v = resolveGovernanceVerdict("meta_ads", "propose_budget_change", isInternal);
    expect(v.governed).toBe(false);
  });

  it("REMOTE write (non-internal server) is governed → fail-closed to unmapped when no read-check", () => {
    const v = resolveGovernanceVerdict("composio", "gmail_send", isInternal);
    expect(v.governed).toBe(true);
    expect(v.mapped).toBe(false);
  });

  it("REMOTE read (advertised read) is NOT governed", () => {
    const isRead = (_s: string, t: string) => t === "search";
    const v = resolveGovernanceVerdict("composio", "search", isInternal, isRead);
    expect(v.governed).toBe(false);
  });

  it("every mapped tool's server is in GOVERNED_EXTERNAL_SERVERS (map/scope consistency)", () => {
    for (const key of Object.keys(TOOL_DECISION_CLASS)) {
      const server = key.split("__")[0];
      expect(GOVERNED_EXTERNAL_SERVERS.has(server)).toBe(true);
    }
  });
});

describe("stripe reads are not governed; stripe writes still are (G2)", () => {
  it("retrieve_dispute / retrieve_payout resolve NOT governed → proceed", () => {
    for (const t of ["retrieve_dispute", "retrieve_payout"]) {
      const v = resolveGovernanceVerdict("stripe", t, isInternal);
      expect(v.governed, t).toBe(false);
    }
  });

  it("every stripe write still resolves governed", () => {
    for (const t of [
      "submit_dispute_evidence",
      "create_payment",
      "remit_to_tenant",
      "create_connected_account",
      "some_new_write_tool",
    ]) {
      const v = resolveGovernanceVerdict("stripe", t, isInternal);
      expect(v.governed, t).toBe(true);
    }
  });
});
