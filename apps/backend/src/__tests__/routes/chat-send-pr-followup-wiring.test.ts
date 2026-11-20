import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "../../routes/agents/chat-send.ts"),
  "utf8",
);

function followupBlock(): string {
  const start = SRC.indexOf("// Engineer PR follow-up routing (DEL-318, S4).");
  const end = SRC.indexOf("// Phase 2 C2/C3/C4 — tenant-command resolution.");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("Could not locate the DEL-318 follow-up routing block — chat-send.ts layout changed?");
  }
  return SRC.slice(start, end);
}

describe("chat-send — PR follow-up routing wiring (S4)", () => {
  const block = followupBlock();

  it("gates on sandbox agent + existing thread + no command/image/doc", () => {
    expect(block).toMatch(/def\.metadata_praxis\.requires_sandbox/);
    expect(block).toMatch(/body\.thread_id/);
    expect(block).toMatch(/!body\.command_slug/);
    expect(block).toMatch(/image_paths \?\? \[\]\)\.length === 0/);
    expect(block).toMatch(/doc_paths \?\? \[\]\)\.length === 0/);
  });

  it("excludes affirmative approvals and explicit rejections (those are handled by the approve fast-path)", () => {
    expect(block).toMatch(/!isAffirmativeApproval\(body\.message\)/);
    expect(block).toMatch(/!isExplicitRejection\(body\.message\)/);
  });

  it("re-verifies thread ownership before any service-role write", () => {
    expect(block).toMatch(/fThread\.user_id as string\) === auth\.user_id/);
    expect(block).toMatch(/fThread\.agent_slug as string\) === slug/);
  });

  it("derives the PR set server-side: thread→runs→acted/dispatched engineer.ship-pr decisions", () => {
    expect(block).toMatch(/payload->>thread_id/);
    expect(block).toMatch(/decision_class["']?,\s*["']engineer\.ship-pr/);
    expect(block).toMatch(/\.in\("status",\s*\["acted",\s*"dispatched"\]\)/);
  });

  it("reads pr_head_branch / pr_number / pr_repo / pr_url off the originating run's parsed.*", () => {
    expect(block).toMatch(/parsed\.pr_head_branch|pr_head_branch\?:/);
    expect(block).toMatch(/parsed\.pr_number/);
    expect(block).toMatch(/parsed\.pr_repo/);
    expect(block).toMatch(/parsed\.pr_url/);
  });

  it("enqueues on the e2b lane with source chat_pr_followup (the drainer claims e2b)", () => {
    expect(block).toMatch(/enqueueWorkItem\(\{/);
    expect(block).toMatch(/source:\s*"chat_pr_followup"/);
    expect(block).toMatch(/dedupe_key,/);
  });

  it("builds the follow-up payload via the shared contract helper", () => {
    expect(block).toMatch(/buildFollowupPayload\(\{/);
    expect(block).toMatch(/source:\s*"chat"/);
  });

  it("threads the operator reply-bubble id into the payload as user_message_id", () => {
    expect(block).toMatch(/user_message_id:\s*fUserMsg\.id/);
  });

  it("captures the fUserMsg insert error and throws (degrade) BEFORE enqueue — no orphan run", () => {
    expect(block).toMatch(/error:\s*fUserMsgErr/);
    const buildIdx = block.indexOf("buildFollowupPayload({");
    const throwIdx = block.indexOf("pr-followup: operator reply bubble insert failed");
    const enqueueIdx = block.indexOf("await enqueueWorkItem({");
    expect(throwIdx).toBeGreaterThanOrEqual(0);
    expect(throwIdx).toBeLessThan(buildIdx);
    expect(throwIdx).toBeLessThan(enqueueIdx);
    const guardSlice = block.slice(throwIdx - 400, throwIdx + 200);
    expect(guardSlice).toMatch(/throw new Error/);
    const guardCode = guardSlice
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(guardCode).not.toMatch(/res\.status\(500\)/);
  });

  it("posts the PR follow-up confirmation ONLY after the enqueue (route case)", () => {
    const routeIdx = block.indexOf('classification.action === "route"');
    const enqueueIdx = block.indexOf("await enqueueWorkItem({", routeIdx);
    const replySlice = block.slice(enqueueIdx);
    const replyIdx = replySlice.search(/body:\s*`On it [^`]* PR #\$\{pr\.pr_number\}\.`/);
    const metaIdx = replySlice.indexOf("chat_pr_followup: true");
    expect(routeIdx).toBeGreaterThanOrEqual(0);
    expect(enqueueIdx).toBeGreaterThan(routeIdx);
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    expect(metaIdx).toBeGreaterThan(replyIdx);
  });

  it("clarify → status/provenance question answered via the shared non-push service; non-status falls through; NEVER enqueues", () => {
    const clarifyIdx = block.indexOf('classification.action === "clarify"');
    expect(clarifyIdx).toBeGreaterThanOrEqual(0);
    expect(block).toMatch(/answerNonPushFollowup\(/);
    expect(block).not.toMatch(/resolvePrThreadClarifyReply\(/);
    const clarifySlice = block.slice(clarifyIdx);
    const skipMarker = clarifySlice.indexOf('action === "skip"');
    const clarifyBody = skipMarker > 0 ? clarifySlice.slice(0, skipMarker) : clarifySlice;
    expect(clarifyBody).not.toMatch(/enqueueWorkItem/);
  });

  it("a follow-up routing failure degrades to normal flow (try/catch, no 500)", () => {
    expect(block).toMatch(/catch \(e\)/);
    expect(block).toMatch(/pr-followup routing failed/);
  });
});

describe("chat-send — imports the follow-up routing helpers + work-queue enqueue", () => {
  it("imports enqueueWorkItem from work-queue", () => {
    expect(SRC).toMatch(
      /import \{ enqueueWorkItem \} from "@\/services\/agents\/work-queue"/,
    );
  });
  it("imports the chat-pr-followup brain", () => {
    expect(SRC).toMatch(/from "@\/services\/agents\/chat-pr-followup"/);
    expect(SRC).toMatch(/classifyFollowupCandidates/);
    expect(SRC).toMatch(/buildFollowupPayload/);
    expect(SRC).toMatch(/followupDedupeKey/);
  });
});

describe("chat-send — engineer plan refusal is held for a PR follow-up only (2026-09-22)", () => {
  const gateStart = SRC.indexOf("const prFollowupCandidate =");
  const gate = SRC.slice(gateStart, SRC.indexOf("// Structural chat-eligibility", gateStart));

  it("holds the refusal only for engineer, only when the follow-up entry conditions hold", () => {
    expect(gateStart).toBeGreaterThan(0);
    expect(gate).toMatch(/slug === "engineer" && prFollowupCandidate/);
    expect(gate).toMatch(/!body\.edit_of_message_id/);
    expect(gate).toMatch(/!isAffirmativeApproval\(body\.message\)/);
    expect(gate).toMatch(/!isExplicitRejection\(body\.message\)/);
    expect(gate).toMatch(/else \{\s*res\.status\(403\)\.json\(planUpgradeErrorBody/);
  });

  it("refuses a held request right after the follow-up block if it was not routed or answered", () => {
    const net = SRC.indexOf("if (heldPlanRefusal) {");
    const blockEnd = SRC.indexOf("// Phase 2 C2/C3/C4 — tenant-command resolution.");
    const blockStart = SRC.indexOf("// Engineer PR follow-up routing (DEL-318, S4).");
    expect(net).toBeGreaterThan(blockStart);
    expect(net).toBeLessThan(blockEnd);
    expect(SRC.slice(net, net + 200)).toMatch(/res\.status\(403\)\.json\(planUpgradeErrorBody/);
  });

  it("never dereferences gates.agent (a held refusal leaves gates non-runnable)", () => {
    expect(SRC).not.toMatch(/gates\.agent\b/);
  });
});
