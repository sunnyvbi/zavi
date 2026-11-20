import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(__dirname, "../../routes/approvals/revision.ts"),
  "utf8",
);
const proposalsSrc = readFileSync(
  join(__dirname, "../../routes/agents/proposals.ts"),
  "utf8",
);

describe("approvals revision route source contract", () => {
  it("does not approve/reject or invoke Meta write handlers", () => {
    expect(src).not.toMatch(/approve_decision|reject_decision|decideOnDecision/);
    expect(src).not.toMatch(/decision\.approved/);
    expect(src).not.toMatch(/meta-ads\/write/);
    expect(src).not.toMatch(/executeDecision|executeMeta|dispatchDecision/);
  });

  it("enqueues through the existing chat-turn RPC path", () => {
    expect(src).toMatch(/send_agent_chat_turn/);
    expect(src).toMatch(/buildRunRequestedEvent/);
    expect(src).toMatch(/revision_request/);
  });

  it("is scoped to an explicit revisable set and DERIVES the reviser, never hardcodes it", () => {
    expect(src).not.toMatch(/performance-marketer/);
    expect(src).toMatch(/resolveDecisionReviser/);
    expect(src).toMatch(/REVISABLE_PREFIXES = \["meta_ads\.", "google_ads\."\]/);
    expect(src).toMatch(/REVISABLE_CLASSES = new Set\(\["channel\.recipe_step"\]\)/);
    expect(src).not.toMatch(/startsWith\("channel\."\)/);
    expect(src).toMatch(/decision\.status !== "proposed"/);
  });

  it("passes the channel origin to the visibility gate for a channel class", () => {
    expect(src).toMatch(
      /ensureAgentRunnable\(auth\.tenant_id, AGENT_SLUG, \{[\s\S]*?origin:[\s\S]*?REVISABLE_CLASSES\.has\(decision\.decision_class\)[\s\S]*?"channel"[\s\S]*?"standard"/,
    );
  });

  it("builds its operator-visible message from the shared per-family copy module", () => {
    expect(src).toMatch(/revisionPrompt\(decision, message\)/);
    expect(src).not.toMatch(/function buildVisibleRevisionMessage/);
  });

  it("the transcript route derives the same way (one posture, two routes)", () => {
    const transcriptSrc = readFileSync(
      join(__dirname, "../../routes/approvals/revision-transcript.ts"),
      "utf8",
    );
    expect(transcriptSrc).not.toMatch(/performance-marketer/);
    expect(transcriptSrc).toMatch(/resolveDecisionReviser/);
  });

  it("records original proposal snapshots for revision runs", () => {
    expect(src).toMatch(/original_decision_class/);
    expect(src).toMatch(/original_handler/);
    expect(src).toMatch(/original_body/);
  });

  it("reconciles replacements by lineage and supersedes the original card", () => {
    expect(proposalsSrc).toMatch(/replacement_decision_id/);
    expect(proposalsSrc).toMatch(/status: "superseded"/);
    expect(proposalsSrc).toMatch(/superseded_by: resolution\.replacement\.id/);
    expect(proposalsSrc).toMatch(/REVISION_STALE_MS/);
    expect(proposalsSrc).toMatch(/serving unreconciled proposals/);
  });
});
