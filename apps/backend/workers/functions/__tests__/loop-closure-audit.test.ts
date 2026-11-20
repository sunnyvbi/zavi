
import { describe, it, expect } from "vitest";
import { classifyViolations, type Violation } from "../loop-closure-audit";
import {
  isCommsReplyHandler,
  isOutwardCommsHandler,
  COMMS_REPLY_HANDLERS,
} from "../email-triage-reply";

const T = "tenant-1";

function dec(over: Partial<Parameters<typeof classifyViolations>[0]["decisions"][0]> = {}) {
  return {
    id: "d-1",
    tenant_id: T,
    agent_run_id: "r-1",
    decision_class: "engineer.ship-pr",
    handler: "github.open_pr",
    body: {},
    ...over,
  };
}

function run(over: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    trigger: "slack",
    parsed: { pr_url: "https://github.com/o/r/pull/1" },
    payload: { slack: { channel_id: "C1", thread_ts: "1.2" } },
    ...over,
  } as never;
}

function classify(args: {
  decisions?: ReturnType<typeof dec>[];
  runs?: Array<ReturnType<typeof run>>;
  claims?: string[];
  noticed?: string[];
}): Violation[] {
  const runsById = new Map<string, never>();
  for (const r of args.runs ?? [run()]) runsById.set((r as { id: string }).id, r);
  return classifyViolations({
    decisions: (args.decisions ?? [dec()]) as never,
    runsById,
    slackClaimIds: new Set(args.claims ?? []),
    noticedDecisionIds: new Set(args.noticed ?? []),
  });
}

describe("Q1 — pr_url writeback", () => {
  it("clean: opened PR with pr_url + delivered slack claim → no violations", () => {
    expect(classify({ claims: ["dispatch-notice:d-1"] })).toEqual([]);
  });

  it("flags an acted open_pr whose run lacks parsed.pr_url", () => {
    const v = classify({
      runs: [run({ parsed: {} })],
      claims: ["dispatch-notice:d-1"],
    });
    expect(v.map((x) => x.kind)).toEqual(["pr_url_missing"]);
  });

  it("push_to_main decisions without pr_url → non-paging push_to_main_unverified (ambiguous: direct push vs gate-refused fallback PR)", () => {
    const v = classify({
      decisions: [dec({ body: { push_to_main: true } })],
      runs: [run({ parsed: {} })],
      claims: ["dispatch-notice:d-1"],
    });
    expect(v.map((x) => x.kind)).toEqual(["push_to_main_unverified"]);
  });

  it("push_to_main fallback that DID write pr_url is clean", () => {
    const v = classify({
      decisions: [dec({ body: { push_to_main: true } })],
      claims: ["dispatch-notice:d-1"],
    });
    expect(v).toEqual([]);
  });

  it("does NOT flag non-open_pr handlers", () => {
    const v = classify({
      decisions: [dec({ handler: "jira.create_issue" })],
      runs: [run({ parsed: {} })],
      claims: ["dispatch-notice:d-1"],
    });
    expect(v.filter((x) => x.kind === "pr_url_missing")).toEqual([]);
  });
});

describe("Q2 — outcome notice delivery", () => {
  it("flags a slack-triggered decision with no dispatch-notice claim", () => {
    const v = classify({ claims: [] });
    expect(v.map((x) => x.kind)).toEqual(["notice_missing"]);
  });

  it("does NOT flag slack runs without routing (no thread to post to)", () => {
    const v = classify({ runs: [run({ payload: { slack: {} } })] });
    expect(v.filter((x) => x.kind === "notice_missing")).toEqual([]);
  });

  it("chat run with a posted notice bubble passes; without it, flags", () => {
    const chatRun = run({ trigger: "chat", payload: { thread_id: "t-uuid" } });
    expect(
      classify({ runs: [chatRun], noticed: ["d-1"] }).filter((x) => x.kind === "notice_missing"),
    ).toEqual([]);
    expect(classify({ runs: [chatRun], noticed: [] }).map((x) => x.kind)).toEqual([
      "notice_missing",
    ]);
  });

  it("ignores cron/a2a/handoff/manual triggers (no asker surface)", () => {
    for (const trigger of ["cron", "a2a", "handoff", "manual", null]) {
      const v = classify({ runs: [run({ trigger })] });
      expect(v.filter((x) => x.kind === "notice_missing")).toEqual([]);
    }
  });
});

describe("Q3 — email outcome gap (pages until an email notice path ships)", () => {
  const emailRun = run({ trigger: "email", payload: { email: { from: "a@b.c" } } });

  it("flags non-comms acted decisions from email runs", () => {
    const v = classify({ runs: [emailRun] });
    expect(v.map((x) => x.kind)).toEqual(["email_outcome_gap"]);
  });

  it("does NOT flag comms handlers (their dispatch IS the reply) or null handlers", () => {
    for (const handler of [...COMMS_REPLY_HANDLERS, null]) {
      const v = classify({ decisions: [dec({ handler })], runs: [emailRun] });
      expect(v.filter((x) => x.kind === "email_outcome_gap")).toEqual([]);
    }
  });
});

describe("isCommsReplyHandler", () => {
  it("matches exactly the email-reply comms set", () => {
    expect(isCommsReplyHandler("email.send")).toBe(true);
    expect(isCommsReplyHandler("gmail.send")).toBe(true);
    expect(isCommsReplyHandler("outbound.send")).toBe(true);
    expect(isCommsReplyHandler("github.open_pr")).toBe(false);
    expect(isCommsReplyHandler("slack.post_message")).toBe(false);
    expect(isCommsReplyHandler(null)).toBe(false);
    expect(isCommsReplyHandler(undefined)).toBe(false);
  });
});

describe("isOutwardCommsHandler (email auto-reply suppress set)", () => {
  it("suppresses all outward drafts but never engineering/ops handlers", () => {
    for (const h of ["email.send", "gmail.send", "outbound.send", "slack.post_message", "social.publish"]) {
      expect(isOutwardCommsHandler(h)).toBe(true);
    }
    for (const h of ["github.open_pr", "jira.create_issue", "meta_ads.set_status", null, undefined]) {
      expect(isOutwardCommsHandler(h as never)).toBe(false);
    }
  });

  it("slack/social drafts suppress the email answer BUT still page in Q3 (visible, not rot)", () => {
    expect(isOutwardCommsHandler("slack.post_message")).toBe(true);
    expect(isCommsReplyHandler("slack.post_message")).toBe(false);
  });
});
