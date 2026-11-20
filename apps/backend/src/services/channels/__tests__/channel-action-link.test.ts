import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import { stepDecisionBodies } from "@/agents/lib/channel-recipe-step";
import { actionLinkForStep } from "../action-link";
import { recordChannelRunActions, type ScoreContext } from "../channel-actions";

const CTX: ScoreContext = {
  channel_in_plan: false,
  goal_metric_keys: new Set(),
  rejected_title_keys: new Set(),
  rejected_ids: new Set(),
};

const DEPS = {
  loadScoreContext: async () => CTX,
  ledger: { figureWasRead: () => false, ledgerIsEmpty: () => true },
  stagedPosts: async () => [],
};

function rpcSpy() {
  return vi.fn(async (_tid: unknown, name: string, _args: Record<string, unknown>) => {
    if (name === "record_channel_run_actions") {
      return { data: { inserted: 1, metrics: 0, stale_accepted: 0, stale_dropped: 0, ids: [{ position: 1, id: "a1" }] }, error: null };
    }
    return { data: { ok: true }, error: null };
  });
}

async function writeOne(channelSlug: string, step: Record<string, unknown>) {
  const envelope = { rendered_markdown: "r", steps: [step], metrics: [], stale: [] };
  const rpc = rpcSpy();
  await recordChannelRunActions(
    { tenantId: "t-1", runId: "run-1", channelSlug, envelope, bodies: stepDecisionBodies(envelope), redo: null },
    { rpc: rpc as never, ...DEPS },
  );
  const actions = rpc.mock.calls[0][2].p_actions as Array<Record<string, unknown>>;
  return actions[0];
}

const COPY =
  "Full disclosure, I run Zavi. For a slow signup funnel the first thing I would check is the time to first value, because that is usually where people drop.";

describe("actionLinkForStep", () => {
  it("a GEO listing card links to the directory's confirmed sign-up page, and only to one of those", () => {
    const listing = (ref: string) => ({ title: "Get listed on G2", target: { kind: "profile", ref } });
    expect(actionLinkForStep("geo", listing("https://sell.g2.com/create-free-profile"))).toBe(
      "https://sell.g2.com/create-free-profile",
    );
    expect(actionLinkForStep("geo", listing("https://evil.example/claim"))).toBeNull();
    expect(actionLinkForStep("geo", { target: { kind: "page", ref: "https://sell.g2.com/create-free-profile" } })).toBeNull();
  });

  it("a reddit reply's thread_url becomes the canonical permalink", () => {
    expect(
      actionLinkForStep("reddit_organic", {
        deliverable: {
          presentation: {
            type: "reddit_reply",
            subreddit: "SaaS",
            thread_url: "https://old.reddit.com/r/SaaS/comments/1f5mjfs/some_slug/?utm_source=share",
          },
        },
      }),
    ).toBe("https://www.reddit.com/r/saas/comments/1f5mjfs/");
  });

  it("a reddit post with no thread yet points at its community", () => {
    expect(
      actionLinkForStep("reddit_organic", {
        deliverable: { presentation: { type: "reddit_post", subreddit: "r/webdev/" } },
      }),
    ).toBe("https://www.reddit.com/r/webdev/");
  });

  it("no presentation: the thread URL is read out of the step's evidence", () => {
    expect(
      actionLinkForStep("reddit_organic", {
        title: "Post Answer 1 — r/webdev",
        body: "Answer the OP directly.",
        evidence: ["r/webdev thread 1i1stbv (https://www.reddit.com/r/webdev/comments/1i1stbv/ga_alternative/)"],
        deliverable: { label: "Reply copy" },
      }),
    ).toBe("https://www.reddit.com/r/webdev/comments/1i1stbv/");
  });

  it("a step that names no target at all gets no link", () => {
    expect(
      actionLinkForStep("reddit_organic", { title: "Write a positioning note", body: "no url here" }),
    ).toBeNull();
  });

  it("a non-reddit channel gets no link, whatever the step says", () => {
    expect(
      actionLinkForStep("google_ads", {
        title: "See https://www.reddit.com/r/PPC/comments/abc123/x/",
        evidence: ["https://www.reddit.com/r/PPC/comments/abc123/x/"],
      }),
    ).toBeNull();
  });
});

describe("recordChannelRunActions puts the link on the stored body", () => {
  it("a reddit reply row carries the thread URL", async () => {
    const action = await writeOne("reddit_organic", {
      title: "Reply in r/SaaS",
      body: "b",
      blocking: false,
      effort: "minutes",
      evidence: ["e"],
      deliverable: {
        kind: "comment",
        label: "Reply copy",
        content: COPY,
        presentation: {
          type: "reddit_reply",
          subreddit: "SaaS",
          thread_title: "Slow signup funnel",
          thread_url: "https://www.reddit.com/r/SaaS/comments/1f5mjfs/slow_signup/",
          reply_style: "answer",
          rule_status: "ready",
          potential: { level: "moderate", confidence: "low", reasons: ["on topic"] },
        },
      },
    });
    expect(action.action_type).toBe("reply");
    expect((action.body as { link?: unknown }).link).toBe(
      "https://www.reddit.com/r/saas/comments/1f5mjfs/",
    );
  });

  it("a prod-shaped reply — no presentation, URL in evidence — still carries it", async () => {
    const action = await writeOne("reddit_organic", {
      title: "Post Answer 1 — r/webdev: 'What is a good Google Analytics alternative?'",
      body: "Answer the OP directly with the tradeoff.",
      blocking: false,
      effort: "minutes",
      evidence: ["r/webdev thread: https://www.reddit.com/r/webdev/comments/1i1stbv/ga_alternative/"],
      deliverable: { kind: "comment", label: "Reply copy", content: COPY },
    });
    expect((action.body as { link?: unknown }).link).toBe(
      "https://www.reddit.com/r/webdev/comments/1i1stbv/",
    );
  });

  it("a google_ads row is byte-identical: no link key at all", async () => {
    const action = await writeOne("google_ads", {
      title: "Enable the booking conversion action",
      body: "b",
      blocking: true,
      effort: "minutes",
      evidence: ["e"],
      action_type: "fix",
    });
    const body = action.body as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, "link")).toBe(false);
    expect(Object.keys(body).sort()).toEqual(
      ["action_key", "breakdown", "caveat", "findings", "intent", "of", "owner", "position", "reads_not_done", "rendered_markdown", "step", "summary"].sort(),
    );
  });

  it("a reddit step with no target is byte-identical too", async () => {
    const action = await writeOne("reddit_organic", {
      title: "Write a positioning note for the team",
      body: "No thread here.",
      blocking: false,
      effort: "minutes",
      evidence: ["e"],
    });
    expect(Object.prototype.hasOwnProperty.call(action.body as object, "link")).toBe(false);
  });
});
