import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const transcriptSrc = readFileSync(
  join(__dirname, "../../routes/approvals/revision-transcript.ts"),
  "utf8",
);
const proposalsSrc = readFileSync(
  join(__dirname, "../../routes/agents/proposals.ts"),
  "utf8",
);

describe("revision-transcript active flag (P2)", () => {
  it("does not OR the status-only anyActive count into the populated-path active", () => {
    expect(transcriptSrc).toMatch(/transcript,\s*active\s*}/);
    expect(transcriptSrc).not.toMatch(/active:\s*active\s*\|\|\s*anyActive/);
  });
  it("keys the in-flight check on run terminal status (not rev.status)", () => {
    expect(transcriptSrc).toMatch(/!!run && !TERMINAL_SUCCESS\.has\(run\.status\) && !TERMINAL_FAILED\.has\(run\.status\)/);
    expect(transcriptSrc).toMatch(/!run && \(r\.status === "requested" \|\| r\.status === "running"\)/);
  });
  it("still uses anyActive only on the empty (teammate) path", () => {
    expect(transcriptSrc).toMatch(/transcript: \[\], active: anyActive/);
  });
});

describe("proposals recent_conversations (P1)", () => {
  it("returns a recent_conversations list", () => {
    expect(proposalsSrc).toMatch(/recent_conversations: recentConversations/);
  });
  it("is INITIATOR-ONLY (created_by = auth.user_id) and tenant-scoped", () => {
    expect(proposalsSrc).toMatch(/\.eq\("created_by", auth\.user_id\)/);
    const block = proposalsSrc.slice(proposalsSrc.indexOf("recentConversations"));
    expect(block).toMatch(/\.eq\("tenant_id", auth\.tenant_id\)/);
  });
  it("excludes decisions still shown in the proposed buckets", () => {
    expect(proposalsSrc).toMatch(/proposedIds\.has\(rv\.decision_id\)/);
  });
  it("is best-effort — never breaks the proposals read", () => {
    const block = proposalsSrc.slice(proposalsSrc.indexOf("recentConversations"));
    expect(block).toMatch(/catch \(e\)/);
  });
});
