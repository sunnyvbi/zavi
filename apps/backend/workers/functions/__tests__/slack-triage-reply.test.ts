
import { describe, it, expect } from "vitest";
import {
  buildTailEnqueuePayloads,
  chunkText,
  rewriteArtifactsTabSentence,
  isFileUploadBlockedError,
  slackErrorClass,
  slackReplyClaimEventId,
  buildSlackReplyText,
  decideNoClaimUpdate,
  decideReplyClaimAction,
  precedingTurnChunks,
  buildSlackHandoffChildText,
} from "../slack-triage-reply";

function run(over: Partial<Parameters<typeof buildSlackReplyText>[0]>) {
  return {
    status: "dispatch_error",
    output_text: null,
    error: null,
    parse_error: null,
    agent_slug: "engineer",
    outcome: null,
    ...over,
  };
}

const SIZE = 2900;

describe("buildTailEnqueuePayloads — B4 durable tail on mid-message failure", () => {
  const CTX = {
    tenant_id: "t1",
    channel_id: "C1",
    thread_ts: "1700.1",
    team_id: "T1",
    run_id: "r1",
    event_id: "ev1",
  };

  it("enqueues ONLY the undelivered tail (chunks from failedIndex on), not the landed ones", () => {
    const chunks = ["a", "b", "c", "d"];
    const out = buildTailEnqueuePayloads(chunks, 2, CTX);
    expect(out.map((p) => p.body)).toEqual(["c", "d"]);
    expect(out.every((p) => p.kind === "reply_tail")).toBe(true);
  });

  it("uses a stable per-chunk idempotency key so an Inngest re-run is a no-op", () => {
    const out = buildTailEnqueuePayloads(["a", "b", "c"], 1, CTX);
    expect(out.map((p) => p.idempotency_key)).toEqual(["ev1:tail:1", "ev1:tail:2"]);
  });

  it("carries thread routing + run/team so the drainer posts to the right thread/workspace", () => {
    const [p] = buildTailEnqueuePayloads(["x", "y"], 1, CTX);
    expect(p).toMatchObject({ channel_id: "C1", thread_ts: "1700.1", team_id: "T1", run_id: "r1" });
  });

  it("returns [] when the failure was at the last chunk (nothing left to deliver)", () => {
    expect(buildTailEnqueuePayloads(["a", "b"], 2, CTX)).toEqual([]);
  });
});

describe("chunkText", () => {
  it("returns [] for empty input", () => {
    expect(chunkText("", SIZE)).toEqual([]);
  });

  it("returns a single chunk when text fits", () => {
    expect(chunkText("hello", SIZE)).toEqual(["hello"]);
  });

  it("returns a single chunk at exactly the size cap", () => {
    const s = "a".repeat(SIZE);
    expect(chunkText(s, SIZE)).toEqual([s]);
  });

  it("splits on newline boundaries when possible", () => {
    const para = "a".repeat(2000);
    const text = `${para}\n${para}\n${para}`;
    const chunks = chunkText(text, SIZE);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SIZE);
    expect(chunks.join("\n")).toBe(text);
  });

  it("hard-slices a single line longer than the cap", () => {
    const giant = "x".repeat(SIZE * 2 + 50);
    const chunks = chunkText(giant, SIZE);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("x".repeat(SIZE));
    expect(chunks[1]).toBe("x".repeat(SIZE));
    expect(chunks[2]).toBe("x".repeat(50));
  });

  it("flushes any buffered text before hard-slicing an oversized line", () => {
    const giant = "x".repeat(SIZE + 10);
    const text = `short head\n${giant}`;
    const chunks = chunkText(text, SIZE);
    expect(chunks[0]).toBe("short head");
    expect(chunks[1]).toBe("x".repeat(SIZE));
    expect(chunks[2]).toBe("x".repeat(10));
  });

  it("packs multiple short lines into one chunk up to the cap", () => {
    const line = "a".repeat(100);
    const text = Array(50).fill(line).join("\n");
    const chunks = chunkText(text, SIZE);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SIZE);
  });
});

describe("rewriteArtifactsTabSentence — slack-threads-teammate P0#3", () => {
  it("rewrites the BRAND_VOICE_FOOTER 'Artifacts tab' sentence to attached-here", () => {
    const reply =
      "Here is your competitor analysis. You can find it in the Zavi web app at https://www.zaviagent.com , on the Artifacts tab.";
    const out = rewriteArtifactsTabSentence(reply);
    expect(out).not.toMatch(/artifacts?\s+tab/i);
    expect(out).toContain("I've attached it here.");
    expect(out).toContain("Here is your competitor analysis.");
  });

  it("rewrites a terse 'it's in the Artifacts tab' pointer", () => {
    const out = rewriteArtifactsTabSentence("Done. It's in the Artifacts tab.");
    expect(out).not.toMatch(/artifacts?\s+tab/i);
    expect(out).toContain("I've attached it here.");
  });

  it("is a no-op when there is no Artifacts-tab sentence", () => {
    const reply = "Here is the summary you asked for. Let me know if you want more.";
    expect(rewriteArtifactsTabSentence(reply)).toBe(reply);
  });

  it("handles empty input", () => {
    expect(rewriteArtifactsTabSentence("")).toBe("");
  });
});

describe("isFileUploadBlockedError — link-fallback trigger (Slack-IQ delivery P0)", () => {
  it("returns true for channel-membership / scope errors (fall back to link)", () => {
    for (const msg of [
      "slack completeUploadExternal failed: not_in_channel",
      "channel_not_found",
      "slack getUploadURLExternal returned: missing_scope",
      "is_archived",
      "restricted_action",
    ]) {
      expect(isFileUploadBlockedError(msg)).toBe(true);
    }
  });

  it("returns false for non-membership errors (real fail, no link fallback)", () => {
    for (const msg of [
      "slack upload POST returned HTTP 500",
      "invalid_auth",
      "ECONNRESET",
      "rate_limited",
    ]) {
      expect(isFileUploadBlockedError(msg)).toBe(false);
    }
  });
});

describe("slackErrorClass — C14-safe error code extraction", () => {
  it("extracts the bare Slack error code, lowercased, never the full message", () => {
    expect(slackErrorClass("upload failed: NOT_IN_CHANNEL extra detail")).toBe(
      "not_in_channel",
    );
    expect(slackErrorClass("channel_not_found")).toBe("channel_not_found");
    expect(slackErrorClass("invalid_auth token bad")).toBe("invalid_auth");
  });

  it("returns a generic class for an unrecognized message (no content leak)", () => {
    expect(slackErrorClass("some weird boom with /secret/path and ip 10.0.0.1")).toBe(
      "upload_error",
    );
  });
});

describe("slackReplyClaimEventId — handoff child delivery idempotency", () => {
  it("uses the original Slack event id for normal Slack runs", () => {
    expect(slackReplyClaimEventId("Ev123", "run-1", {})).toBe("Ev123");
  });

  it("uses a run-specific claim id for delegated Slack children", () => {
    expect(slackReplyClaimEventId("Ev123", "child-1", { slack_handoff_child: true })).toBe(
      "Ev123:handoff:child-1",
    );
  });
});

describe("decideNoClaimUpdate — direct-wake file_share silent-drop fix", () => {
  it("non-handoff with NO claim row → insert + post (the file_share direct-answer fix)", () => {
    expect(
      decideNoClaimUpdate({ isHandoffChild: false, claimRowExists: false }),
    ).toBe("insert_and_post");
  });

  it("non-handoff with an EXISTING claim row → skip (already delivered / racing worker)", () => {
    expect(
      decideNoClaimUpdate({ isHandoffChild: false, claimRowExists: true }),
    ).toBe("skip_already_handled");
  });

  it("handoff child → always insert its own claim + post, regardless of row state", () => {
    expect(
      decideNoClaimUpdate({ isHandoffChild: true, claimRowExists: false }),
    ).toBe("insert_and_post");
    expect(
      decideNoClaimUpdate({ isHandoffChild: true, claimRowExists: true }),
    ).toBe("insert_and_post");
  });
});

describe("decideReplyClaimAction — two-phase slot (2026-07-16 silent-drop fix)", () => {
  it("INCIDENT REPLAY: a provisional courtesy post buried a real deliverable → upgrade + post", () => {
    expect(
      decideReplyClaimAction({
        isHandoffChild: false,
        runHasRealDeliverable: true,
        provisionalUpgradeSucceeded: true,
        claimRowExists: true,
      }),
    ).toBe("upgrade_provisional");
  });

  it("genuine FINAL answer already delivered (no provisional to upgrade) → skip", () => {
    expect(
      decideReplyClaimAction({
        isHandoffChild: false,
        runHasRealDeliverable: true,
        provisionalUpgradeSucceeded: false,
        claimRowExists: true,
      }),
    ).toBe("skip_already_handled");
  });

  it("file_share direct-answer with NO claim row → still insert + post (regression preserved)", () => {
    expect(
      decideReplyClaimAction({
        isHandoffChild: false,
        runHasRealDeliverable: true,
        provisionalUpgradeSucceeded: false,
        claimRowExists: false,
      }),
    ).toBe("insert_and_post");
  });

  it("an ERROR run never overwrites another post (upgrade not attempted) → defers to existing matrix", () => {
    expect(
      decideReplyClaimAction({
        isHandoffChild: false,
        runHasRealDeliverable: false,
        provisionalUpgradeSucceeded: false,
        claimRowExists: true,
      }),
    ).toBe("skip_already_handled");
  });

  it("handoff child → always insert its own slot, upgrade never applies", () => {
    expect(
      decideReplyClaimAction({
        isHandoffChild: true,
        runHasRealDeliverable: true,
        provisionalUpgradeSucceeded: false,
        claimRowExists: true,
      }),
    ).toBe("insert_and_post");
  });
});

describe("buildSlackReplyText — praxis-action links never reach Slack raw", () => {
  const hasRawSentinel = (s: string) => s.includes("__praxis_action__");

  it("rewrites the action link on the SUCCESS branch (2026-07-22 prod leak)", () => {
    const out = buildSlackReplyText(
      {
        status: "succeeded",
        output_text:
          "I can't reach your repo. [Connect GitHub](/__praxis_action__/connect:github)",
        error: null,
        parse_error: null,
        agent_slug: "operator",
        outcome: null,
      } as never,
      false,
    );
    expect(hasRawSentinel(out)).toBe(false);
    expect(out).toContain(
      "<https://www.zaviagent.com/workspace?tab=settings#connector-github|Connect GitHub>",
    );
  });

  it("rewrites the action link on the failure branch too", () => {
    const out = buildSlackReplyText(
      {
        status: "failed",
        output_text: null,
        error: "github_not_connected",
        parse_error: null,
        agent_slug: "operator",
        outcome: null,
      } as never,
      false,
    );
    expect(hasRawSentinel(out)).toBe(false);
  });
});

describe("buildSlackReplyText — failure copy parity with chat", () => {
  it("usage-limit failure → honest reset copy, never the Runs-tab banner", () => {
    const t = buildSlackReplyText(
      run({ status: "dispatch_error", error: "You've hit your limit · resets Jun 20, 12am (UTC)" }),
      false,
    );
    expect(t).toMatch(/usage limit/i);
    expect(t).not.toMatch(/Check the Runs tab/i);
  });

  it("generic dispatch_error → scrubbed body, no Runs-tab banner", () => {
    const t = buildSlackReplyText(
      run({ status: "dispatch_error", error: "Some backend exploded at /srv/app/x.ts" }),
      false,
    );
    expect(t.length).toBeGreaterThan(0);
    expect(t).not.toMatch(/Check the Runs tab/i);
  });

  it("connector auth-expired → action deep-link becomes a real clickable URL", () => {
    const t = buildSlackReplyText(
      run({ status: "dispatch_error", error: '{"error":"github_auth_expired","message":"token expired"}' }),
      false,
    );
    expect(t).not.toContain("/__praxis_action__");
    expect(t).toContain(
      "<https://www.zaviagent.com/workspace?tab=settings#connector-github|Reconnect Github>",
    );
  });

  it("parse_failed derives copy from parse_error when error is null", () => {
    const t = buildSlackReplyText(
      run({ status: "parse_failed", parse_error: "unexpected token at line 2", error: null }),
      false,
    );
    expect(t.length).toBeGreaterThan(0);
    expect(t).not.toMatch(/Check the Runs tab/i);
  });

  it("null error still produces a non-empty body (no crash)", () => {
    const t = buildSlackReplyText(run({ status: "dispatch_error", error: null }), false);
    expect(t.length).toBeGreaterThan(0);
  });

  it("parse_failed WITH output_text and null error/parse_error → shows the answer, NOT 'unknown error'", () => {
    const t = buildSlackReplyText(
      run({
        status: "parse_failed",
        output_text:
          "I made changes in the sandbox but the platform refused to ship them: forbidden_path.",
        error: null,
        parse_error: null,
      }),
      false,
    );
    expect(t).toContain("refused to ship them: forbidden_path");
    expect(t).not.toMatch(/unknown error/i);
  });
});

describe("buildSlackReplyText — success path unchanged", () => {
  it("converts markdown output to mrkdwn (no literal **bold**)", () => {
    const t = buildSlackReplyText(
      run({ status: "success", output_text: "Done **now**" }),
      false,
    );
    expect(t).not.toContain("**");
    expect(t).toContain("Done");
  });

  it("empty success output → 'Done - no output.'", () => {
    expect(buildSlackReplyText(run({ status: "success", output_text: "" }), false)).toBe(
      "Done - no output.",
    );
  });
});

describe("precedingTurnChunks — multi-turn Slack delivery (single-claimed-delivery-path P0)", () => {
  const CHUNK = 2900;

  const sub = (label: string) =>
    [
      `${label}: here is the part of the answer this turn carries.`,
      "",
      "The payout failed because the connected account has no external account",
      "attached, so Stripe rejects the transfer before it reaches the bank. That is",
      "why all three hosts fail identically rather than in a pattern tied to their",
      "individual trips or payout amounts this cycle.",
    ].join("\n");

  it("null/undefined turns → [] (today's output_text-only behavior)", () => {
    expect(precedingTurnChunks(null, false, CHUNK)).toEqual([]);
    expect(precedingTurnChunks(undefined, false, CHUNK)).toEqual([]);
  });

  it("single turn → [] (nothing precedes the final reply)", () => {
    expect(precedingTurnChunks(["only one turn"], false, CHUNK)).toEqual([]);
  });

  it("two turns → delivers the FIRST as a preceding post (last == output_text, dropped)", () => {
    const out = precedingTurnChunks([sub("the full breakdown"), "saved to memory, reply above"], false, CHUNK);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("the full breakdown");
    expect(out.join("\n")).not.toContain("saved to memory");
  });

  it("three turns → first two precede, in order", () => {
    const out = precedingTurnChunks([sub("turn A"), sub("turn B"), "final turn C"], false, CHUNK);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("turn A");
    expect(out[1]).toContain("turn B");
  });

  it("error reply → [] (a failure stays a single message)", () => {
    expect(precedingTurnChunks(["breakdown", "follow-up"], true, CHUNK)).toEqual([]);
  });

  it("converts each preceding turn markdown → mrkdwn (no literal **bold**)", () => {
    const out = precedingTurnChunks([sub("a **bold** breakdown"), "follow-up"], false, CHUNK);
    expect(out[0]).not.toContain("**");
    expect(out[0]).toContain("bold");
  });

  it("a long preceding turn is itself chunked below the size cap", () => {
    const big = "x".repeat(CHUNK * 2 + 500);
    const out = precedingTurnChunks([big, "final"], false, CHUNK);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(CHUNK);
  });
});

describe("buildSlackHandoffChildText", () => {
  it("a clean answer posts alone, with no status line", () => {
    const text = buildSlackHandoffChildText(
      {
        status: "success",
        output_text: "Spend the next $500 on search.",
        error: null,
        parse_error: null,
        agent_slug: "meta_ads",
        payload: { slack_handoff_child: true },
        outcome: null,
      },
      "r1",
    );
    expect(text).toBe("Spend the next $500 on search.");
  });

  const JARGON =
    "I can't ship from this run: the sandbox is on the wrong repo (`git remote -v`). " +
    "Re-dispatch with `repo_hint: acme/shop`. No envelope emitted.";

  it("refused engineer with a jargon write-up -> the status phrase, nothing internal", () => {
    const text = buildSlackHandoffChildText(
      {
        status: "success",
        output_text: JARGON,
        error: null,
        parse_error: null,
        agent_slug: "engineer",
        payload: { slack_handoff_child: true },
        outcome: {
          deliverable: JARGON,
          side_effect: { kind: "refused", reason: "refused_envelope", reason_code: "wrong_repo" },
          failure: { class: "none" },
          liveness_tier: "plan_only",
        },
      },
      "3f1c2b7a-1111-4222-8333-944445555666",
    );
    expect(text).toBe("I couldn't work in the right repo. Which one should I use?");
    for (const re of [/sandbox/i, /repo_hint/i, /envelope/i, /git remote/i, /@engineer/, /3f1c2b7a/, /⚠/]) {
      expect(text).not.toMatch(re);
    }
  });

  it("engineer no_change (RLS already on) -> leads with the answer, never 'didn't finish'", () => {
    const summary = "Row-level security is already on for every table, so there is nothing to fix.";
    const text = buildSlackHandoffChildText(
      {
        status: "success",
        output_text: "Checked every table: all have RLS enabled.",
        error: null,
        parse_error: null,
        agent_slug: "engineer",
        payload: { slack_handoff_child: true },
        outcome: {
          deliverable: "Checked every table: all have RLS enabled.",
          side_effect: { kind: "refused", reason: "refused_envelope", reason_code: "no_change" },
          customer_summary: summary,
          failure: { class: "none" },
          liveness_tier: "plan_only",
        },
      },
      "r1",
    );
    expect(text.startsWith(summary)).toBe(true);
    expect(text).toContain("No changes were made.");
    expect(text).not.toMatch(/didn't finish/);
  });

  it("shipped PR -> 'Opened PR #N: title' with the link", () => {
    const text = buildSlackHandoffChildText(
      {
        status: "success",
        output_text: "## Files\n- `src/a.ts`",
        error: null,
        parse_error: null,
        agent_slug: "engineer",
        payload: { slack_handoff_child: true },
        outcome: {
          deliverable: "## Files\n- `src/a.ts`",
          side_effect: { kind: "shipped", detail: "d1" },
          failure: { class: "none" },
          liveness_tier: "shipped",
        },
        parsed: { title: "Fix the footer", pr_url: "https://github.com/acme/shop/pull/7", pr_number: 7 },
      },
      "r1",
    );
    expect(text).toContain("Opened PR #7: Fix the footer");
    expect(text).toContain("https://github.com/acme/shop/pull/7");
    expect(text).not.toContain("src/a.ts");
  });
});

describe("isTerminalRunStatus (a requeued run waits for its own completion)", () => {
  it("answers terminal runs only", async () => {
    const { isTerminalRunStatus } = await import("../slack-triage-reply");
    for (const s of ["success", "dispatch_error", "failed", "parse_failed"]) expect(isTerminalRunStatus(s)).toBe(true);
    for (const s of ["queued", "running"]) expect(isTerminalRunStatus(s)).toBe(false);
  });
});

describe("isStaleAttempt (a reply worker never posts for an attempt that was replaced)", () => {
  it("is stale when the run is queued again or its attempt token moved on", async () => {
    const { isStaleAttempt } = await import("../slack-triage-reply");
    expect(isStaleAttempt({ infra_retry_count: 0 }, { status: "dispatch_error", infra_retry_count: 0 })).toBe(false);
    expect(isStaleAttempt({ infra_retry_count: 0 }, { status: "queued", infra_retry_count: 1 })).toBe(true);
    expect(isStaleAttempt({ infra_retry_count: 0 }, { status: "success", infra_retry_count: 1 })).toBe(true);
    expect(isStaleAttempt({}, { status: "failed", infra_retry_count: null })).toBe(false);
  });
});
