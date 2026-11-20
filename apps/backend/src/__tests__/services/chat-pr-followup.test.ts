import { describe, it, expect } from "vitest";
import {
  classifyFollowupCandidates,
  buildFollowupPayload,
  buildClarifyText,
  followupDedupeKey,
  shortHash,
  isSafeCheckoutRef,
  type OpenEngineerPr,
} from "@/services/agents/chat-pr-followup";
import { extractSlackRouting } from "../../../workers/functions/dispatch-notice";
import { sourceToTrigger, isBackgroundSource } from "@/services/agents/work-queue";

const PR_A: OpenEngineerPr = {
  decision_id: "dec-a",
  run_id: "run-a",
  pr_number: 42,
  pr_repo: "acme/web",
  pr_url: "https://github.com/acme/web/pull/42",
  head_branch: "engineer/fix-button",
};
const PR_B: OpenEngineerPr = {
  decision_id: "dec-b",
  run_id: "run-b",
  pr_number: 43,
  pr_repo: "acme/web",
  pr_url: "https://github.com/acme/web/pull/43",
  head_branch: "engineer/add-footer",
};

describe("classifyFollowupCandidates", () => {
  it("zero open PRs → skip", () => {
    expect(
      classifyFollowupCandidates({ message: "also use blue", openPrs: [] }),
    ).toEqual({ action: "skip" });
  });

  it("empty message → skip", () => {
    expect(
      classifyFollowupCandidates({ message: "   ", openPrs: [PR_A] }),
    ).toEqual({ action: "skip" });
  });

  it("multiple open PRs → clarify (never auto-route)", () => {
    const r = classifyFollowupCandidates({
      message: "make the button bigger",
      openPrs: [PR_A, PR_B],
    });
    expect(r.action).toBe("clarify");
    if (r.action === "clarify") {
      expect(r.prs.map((p) => p.pr_number).sort()).toEqual([42, 43]);
    }
  });

  it("exactly one open PR + continuation change → route to it", () => {
    const r = classifyFollowupCandidates({
      message: "also rename the button to Save",
      openPrs: [PR_A],
    });
    expect(r.action).toBe("route");
    if (r.action === "route") expect(r.pr.pr_number).toBe(42);
  });

  it("exactly one open PR + bare imperative change verb → route", () => {
    const r = classifyFollowupCandidates({
      message: "change the header color to blue",
      openPrs: [PR_A],
    });
    expect(r.action).toBe("route");
  });

  it("exactly one open PR but message reads as a NEW task → clarify (could be new)", () => {
    const r = classifyFollowupCandidates({
      message: "start a new feature: add a billing page",
      openPrs: [PR_A],
    });
    expect(r.action).toBe("clarify");
  });

  it("one open PR + ambiguous non-continuation text → clarify (safe default)", () => {
    const r = classifyFollowupCandidates({
      message: "hmm interesting",
      openPrs: [PR_A],
    });
    expect(r.action).toBe("clarify");
  });

  it("'merge this' (bare pronoun, no code verb) → clarify, NOT route", () => {
    expect(
      classifyFollowupCandidates({ message: "merge this", openPrs: [PR_A] }).action,
    ).toBe("clarify");
  });
  it("'can you try merging now' → clarify, NOT route", () => {
    expect(
      classifyFollowupCandidates({ message: "can you try merging now", openPrs: [PR_A] }).action,
    ).toBe("clarify");
  });
  it("'ship it' (bare pronoun, no code verb) → clarify, NOT route", () => {
    expect(
      classifyFollowupCandidates({ message: "ship it", openPrs: [PR_A] }).action,
    ).toBe("clarify");
  });

  it("'thank you' with one open PR → skip (no clarify prompt)", () => {
    expect(
      classifyFollowupCandidates({ message: "thank you", openPrs: [PR_A] }).action,
    ).toBe("skip");
  });

  it("'thanks!' with one open PR → skip (trailing punctuation tolerated)", () => {
    expect(
      classifyFollowupCandidates({ message: "thanks!", openPrs: [PR_A] }).action,
    ).toBe("skip");
  });

  it("'perfect, thanks' / 'got it' acks → skip", () => {
    expect(
      classifyFollowupCandidates({ message: "perfect, thanks", openPrs: [PR_A] })
        .action,
    ).toBe("skip");
    expect(
      classifyFollowupCandidates({ message: "got it", openPrs: [PR_A] }).action,
    ).toBe("skip");
  });

  it("a bare 'thanks' skips even with multiple open PRs (ack beats clarify)", () => {
    expect(
      classifyFollowupCandidates({ message: "thanks", openPrs: [PR_A, PR_B] })
        .action,
    ).toBe("skip");
  });

  it("gratitude variants ('appreciate it' / 'thanks again' / 'thank u' / 'tysm' / 'cheers') → skip, never route", () => {
    for (const m of ["appreciate it", "thanks again", "thank u", "tysm", "cheers"]) {
      expect(
        classifyFollowupCandidates({ message: m, openPrs: [PR_A] }).action,
      ).toBe("skip");
    }
  });

  it("'thanks, also rename the button to Save' still ROUTES (ack prefix, real follow-up)", () => {
    const r = classifyFollowupCandidates({
      message: "thanks, also rename the button to Save",
      openPrs: [PR_A],
    });
    expect(r.action).toBe("route");
  });

  it("a bare 'yes' is not auto-routed even with one open PR (no continuation signal → clarify)", () => {
    const r = classifyFollowupCandidates({ message: "yes", openPrs: [PR_A] });
    expect(r.action).toBe("clarify");
  });

  it("an open PR with an unsafe head_branch is filtered out (never a push target)", () => {
    const bad: OpenEngineerPr = { ...PR_A, head_branch: "--exec" };
    const r = classifyFollowupCandidates({
      message: "also change the title",
      openPrs: [bad],
    });
    expect(r.action).toBe("skip");
  });
});

describe("buildFollowupPayload — SHARED CONTRACT #2 shape", () => {
  it("produces the exact contract payload from a chat follow-up", () => {
    const payload = buildFollowupPayload({
      pr: PR_A,
      instruction: "also rename the button to Save",
      source: "chat",
      thread_id: "thr-1",
      user_message_id: "umsg-1",
      slack_routing: null,
    });
    expect(payload).toEqual({
      kind: "engineer_pr_followup",
      checkout_ref: "engineer/fix-button",
      target_pr_number: 42,
      target_pr_repo: "acme/web",
      target_pr_url: "https://github.com/acme/web/pull/42",
      instruction: "also rename the button to Save",
      source: "chat",
      thread_id: "thr-1",
      user_message_id: "umsg-1",
      slack_routing: null,
    });
  });

  it("carries the user_message_id through so runChat can anchor the follow-up turn", () => {
    const payload = buildFollowupPayload({
      pr: PR_A,
      instruction: "also use green",
      source: "chat",
      thread_id: "thr-1",
      user_message_id: "umsg-42",
      slack_routing: null,
    });
    expect(payload.user_message_id).toBe("umsg-42");
  });

  it("carries slack_routing through when source is slack", () => {
    const routing = { channel_id: "C1", thread_ts: "1.2", team_id: "T1" };
    const payload = buildFollowupPayload({
      pr: PR_A,
      instruction: "tweak it",
      source: "slack",
      thread_id: "thr-2",
      user_message_id: "umsg-2",
      slack_routing: routing,
    });
    expect(payload.source).toBe("slack");
    expect(payload.slack_routing).toEqual(routing);
  });
});

describe("followupDedupeKey + shortHash — no double-enqueue on repeat", () => {
  it("same thread+decision+instruction → identical dedupe key (queue collapses)", () => {
    const a = followupDedupeKey({
      thread_id: "thr-1",
      decision_id: "dec-a",
      instruction: "also use blue",
    });
    const b = followupDedupeKey({
      thread_id: "thr-1",
      decision_id: "dec-a",
      instruction: "also use blue",
    });
    expect(a).toBe(b);
    expect(a).toBe(`chat-followup:thr-1:dec-a:${shortHash("also use blue")}`);
  });

  it("trims whitespace so '  also use blue ' dedupes with 'also use blue'", () => {
    expect(shortHash("  also use blue ")).toBe(shortHash("also use blue"));
  });

  it("a different instruction → different key (a genuinely new follow-up runs)", () => {
    const a = followupDedupeKey({
      thread_id: "thr-1",
      decision_id: "dec-a",
      instruction: "also use blue",
    });
    const b = followupDedupeKey({
      thread_id: "thr-1",
      decision_id: "dec-a",
      instruction: "also use green",
    });
    expect(a).not.toBe(b);
  });
});

describe("buildClarifyText", () => {
  it("single PR → 'Apply this to PR #N ... or start a new change?'", () => {
    expect(buildClarifyText([PR_A])).toBe(
      "Apply this to PR #42 (acme/web), or start a new change?",
    );
  });
  it("multiple PRs → lists them", () => {
    const t = buildClarifyText([PR_A, PR_B]);
    expect(t).toContain("#42");
    expect(t).toContain("#43");
  });
});

describe("isSafeCheckoutRef", () => {
  it("accepts engineer/* branch tokens", () => {
    expect(isSafeCheckoutRef("engineer/fix-foo")).toBe(true);
  });
  it("rejects leading-dash, empty, and shell-metachar refs", () => {
    expect(isSafeCheckoutRef("-rf")).toBe(false);
    expect(isSafeCheckoutRef("")).toBe(false);
    expect(isSafeCheckoutRef("foo; rm -rf")).toBe(false);
    expect(isSafeCheckoutRef(42)).toBe(false);
  });
});

describe("work-queue source mapping — SHARED CONTRACT #3", () => {
  it("chat_pr_followup → trigger 'chat' (run-end thread writeback fires)", () => {
    expect(sourceToTrigger("chat_pr_followup")).toBe("chat");
  });
  it("chat_pr_followup is background-drainable (cloud drainer claims it)", () => {
    expect(isBackgroundSource("chat_pr_followup")).toBe(true);
    expect(isBackgroundSource("chat")).toBe(false);
    expect(isBackgroundSource("manual")).toBe(false);
  });
});

describe("extractSlackRouting — chat_pr_followup Slack parity (S5)", () => {
  it("a chat-triggered chat_pr_followup run with source=slack resolves the Slack thread", () => {
    const routing = extractSlackRouting({
      trigger: "chat",
      payload: {
        kind: "engineer_pr_followup",
        source: "slack",
        thread_id: "thr-1",
        slack_routing: { channel_id: "C1", thread_ts: "1.2", team_id: "T1" },
      },
    });
    expect(routing).toEqual({ channel_id: "C1", thread_ts: "1.2", team_id: "T1" });
  });

  it("a chat_pr_followup run with source=chat → no Slack routing (posts to chat thread only)", () => {
    expect(
      extractSlackRouting({
        trigger: "chat",
        payload: {
          kind: "engineer_pr_followup",
          source: "chat",
          thread_id: "thr-1",
          slack_routing: null,
        },
      }),
    ).toBeNull();
  });

  it("still resolves a normal trigger=slack run (no regression)", () => {
    expect(
      extractSlackRouting({
        trigger: "slack",
        payload: { slack: { channel_id: "C9", thread_ts: "9.9" } },
      }),
    ).toEqual({ channel_id: "C9", thread_ts: "9.9", team_id: undefined });
  });

  it("a plain chat run (no follow-up payload) → null", () => {
    expect(extractSlackRouting({ trigger: "chat", payload: { thread_id: "x" } })).toBeNull();
  });
});

describe("classifyFollowupCandidates — omission markers (tight)", () => {
  const PR: OpenEngineerPr = {
    decision_id: "d", run_id: "r", pr_number: 460,
    pr_repo: "rravi149/upcar-private", pr_url: "https://x/pull/460",
    head_branch: "engineer/auto-capture",
  };
  const route = (m: string) => classifyFollowupCandidates({ message: m, openPrs: [PR] }).action;

  it("POSITIVE — the literal incident routes", () => {
    expect(route("you forgot to generate the .js files")).toBe("route");
    expect(route("you missed the dist files")).toBe("route");
    expect(route("you left out the tests")).toBe("route");
    expect(route("didn't include the migration")).toBe("route");
  });

  it("NEGATIVE — meta-complaints + new-scope asks do NOT route (customer-repo safety)", () => {
    expect(route("you didn't answer my question")).not.toBe("route");
    expect(route("I need the billing page rebuilt")).not.toBe("route");
    expect(route("I forgot to mention we need the billing page rebuilt")).not.toBe("route");
    expect(route("you missed my earlier message about the deadline")).not.toBe("route");
    expect(route("build a new separate feature for invoices")).toBe("clarify");
  });
});

describe("classifyFollowupCandidates — negative-feedback / rejection guard", () => {
  const route = (m: string) => classifyFollowupCandidates({ message: m, openPrs: [PR_A] }).action;

  it("the LITERAL incident does NOT route (was 'On it — applying that to PR #N')", () => {
    expect(route("this is not the correct fix think deep on the root cause again")).toBe("skip");
  });

  it("rejection / re-investigation turns skip (never push to the open PR)", () => {
    for (const m of [
      "this is not the right fix",
      "wrong fix",
      "that doesn't work",
      "this didn't solve it",
      "wrong root cause, think deeper",
      "actually this is wrong",
      "on second thought this is not the right fix",
      "try again, think deeper",
    ]) {
      expect(route(m), m).toBe("skip");
    }
  });

  it("does NOT over-fire — real continuations still route", () => {
    expect(route("also fix the failing test")).toBe("route");
    expect(route("fix the typo")).toBe("route");
    expect(route("actually use blue instead")).toBe("route");
    expect(route("thanks, also rename the button to Save")).toBe("route");
  });
});

describe("classifyFollowupCandidates — deferred-intent (reminder) guard", () => {
  const route = (m: string) => classifyFollowupCandidates({ message: m, openPrs: [PR_A] }).action;

  it("the LITERAL incident does NOT route (was 'On it — applying that to PR #N')", () => {
    expect(route("Remind me in one hour to check this")).toBe("skip");
  });

  it("reminder / follow-up-later requests skip (never push to the open PR)", () => {
    for (const m of [
      "remind me to check the PR tomorrow",
      "ping me in 30 minutes about this",
      "follow up with me later on that",
      "circle back tonight",
      "set a reminder to review it next week",
      "remind me to rename the button",
    ]) {
      expect(route(m), m).toBe("skip");
    }
  });

  it("does NOT over-fire — 'send me X now' requests still classify normally", () => {
    expect(route("dm me the PR link")).not.toBe("skip");
    expect(route("also rename the button to Save")).toBe("route");
    expect(route("actually use blue instead")).toBe("route");
  });
});
