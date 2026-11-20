
import { describe, expect, it } from "vitest";
import { actionsStoreFor, allowedActionTypes, type ActionType } from "@zavi/shared";
import { actionTypeFromStep, deriveActionType, type DerivableStep } from "../action-type";

const WAVE1 = ["linkedin_organic", "reddit_organic", "instagram_organic"] as const;

type Fixture = {
  shape: string;
  step: DerivableStep;
  staged?: string | null;
  expected?: ActionType;
};

const LINKEDIN: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: {
      title: "Post the migration write-up",
      deliverable: { kind: "post" },
    },
    expected: "text_post",
  },
  {
    shape: "team-subscription-tool",
    step: {
      title: "Post the chart of last quarter's onboarding times",
      deliverable: { kind: "post" },
    },
    staged: "linkedin_image",
    expected: "image_post",
  },
  {
    shape: "booking-led-local-service",
    step: {
      title: "Rewrite the About section's first line",
      deliverable: { kind: "page_copy" },
    },
    expected: "fix",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "Confirm the Featured link still resolves", deliverable: null },
    expected: "check",
  },
  {
    shape: "physical-goods-maker",
    step: {
      title: "Comment on the sourcing thread with the drafted opener",
      deliverable: { kind: "comment" },
    },
    expected: "reply",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Reconnect the account in Settings so posts can be staged", deliverable: null },
    expected: "setup",
  },
  {
    shape: "two-sided-marketplace",
    step: {
      title: "Record the 40-second walkthrough",
      deliverable: { kind: "script" },
    },
    expected: "video_post",
  },
  {
    shape: "paid-community",
    step: { title: "Send the connect note to the two named accounts", deliverable: { kind: "dm" } },
  },
];

const REDDIT: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: {
      title: "Answer the thread asking how teams handle deposits",
      deliverable: {
        kind: "comment",
        presentation: { type: "reddit_reply" },
      },
    },
    expected: "reply",
  },
  {
    shape: "booking-led-local-service",
    step: {
      title: "Answer the pricing question in the trade community",
      deliverable: { kind: "post", presentation: { type: "reddit_reply" } },
    },
    expected: "reply",
  },
  {
    shape: "physical-goods-maker",
    step: {
      title: "Submit the build-log post",
      deliverable: { kind: "post", presentation: { type: "reddit_post", post_type: "text" } },
    },
    expected: "text_post",
  },
  {
    shape: "physical-goods-maker",
    step: {
      title: "Submit the finished-piece photo post",
      deliverable: { kind: "post", presentation: { type: "reddit_post", post_type: "image" } },
    },
    expected: "image_post",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Run the logged-out check on the answer", deliverable: null },
    expected: "check",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Claim the account name before the next run", deliverable: null },
    expected: "setup",
  },
  {
    shape: "paid-community",
    step: { title: "The four queries worth watching", deliverable: { kind: "list" } },
  },
];

const INSTAGRAM: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: { title: "Post the single-image episode", deliverable: { kind: "post" } },
    staged: "instagram_image",
    expected: "image_post",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "Shoot episode one to this shot list", deliverable: { kind: "script" } },
    expected: "video_post",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Replace the bio's first line", deliverable: { kind: "page_copy" } },
    expected: "fix",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Check what the link in the bio actually resolves to", deliverable: null },
    expected: "check",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Pin the introduction post to the profile", deliverable: null },
    expected: "setup",
  },
  {
    shape: "paid-community",
    step: { title: "Reply to the three comments left on last week's post", deliverable: { kind: "comment" } },
    expected: "reply",
  },
  {
    shape: "paid-community",
    step: { title: "Send the collab pitch to the partner account", deliverable: { kind: "dm" } },
  },
];

const BY_CHANNEL: Record<(typeof WAVE1)[number], Fixture[]> = {
  linkedin_organic: LINKEDIN,
  reddit_organic: REDDIT,
  instagram_organic: INSTAGRAM,
};

describe("wave 1: the three organic channels are switched", () => {
  it.each(WAVE1)("%s reads and writes channel_actions", (slug) => {
    expect(actionsStoreFor(slug)).toBe("channel_actions");
  });
});

describe.each(WAVE1)("%s: derived type is always one the registry allows", (slug) => {
  const fixtures = BY_CHANNEL[slug];

  it("covers at least 3 different business shapes", () => {
    expect(new Set(fixtures.map((f) => f.shape)).size).toBeGreaterThanOrEqual(3);
  });

  it("every fixture derives a type inside this channel's action_types", () => {
    const allowed = allowedActionTypes(slug);
    expect(allowed.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      const { action_type } = deriveActionType(slug, f.step, f.staged ?? null);
      expect(allowed, `${slug} / ${f.shape} / ${String(f.step.title)}`).toContain(action_type);
    }
  });

  it("derives the type each per-channel rule calls for", () => {
    for (const f of fixtures) {
      if (!f.expected) continue;
      const { action_type, coerced } = deriveActionType(slug, f.step, f.staged ?? null);
      expect(action_type, `${slug} / ${f.shape} / ${String(f.step.title)}`).toBe(f.expected);
      expect(coerced, `${slug} / ${f.shape}: an expected type must not be a coercion`).toBe(false);
    }
  });

  it("a fixture with no expected type falls to `other`, which is always allowed", () => {
    for (const f of fixtures) {
      if (f.expected) continue;
      const { action_type } = deriveActionType(slug, f.step, f.staged ?? null);
      expect(allowedActionTypes(slug)).toContain(action_type);
    }
  });
});

describe("the two signals wave 1 added", () => {
  it("a reddit presentation block outranks the deliverable kind", () => {
    expect(actionTypeFromStep("post", "Answer it", null, { type: "reddit_reply" })).toBe("reply");
    expect(
      actionTypeFromStep("comment", "Submit it", null, { type: "reddit_post", post_type: "image" }),
    ).toBe("image_post");
    expect(
      actionTypeFromStep("comment", "Submit it", null, { type: "reddit_post", post_type: "text" }),
    ).toBe("text_post");
  });

  it("an unrecognised presentation block changes nothing", () => {
    expect(actionTypeFromStep("comment", "Answer it", null, { type: "not_a_block" })).toBe("reply");
    expect(actionTypeFromStep("comment", "Answer it", null, null)).toBe("reply");
  });

  it("a read verb beats a setup verb on a step that hands nothing over", () => {
    expect(actionTypeFromStep(null, "Confirm the link in the bio resolves", null)).toBe("check");
    expect(actionTypeFromStep(null, "Check which accounts the handle follows", null)).toBe("check");
    expect(actionTypeFromStep(null, "Verify the pinned post is still the right one", null)).toBe("check");
    expect(actionTypeFromStep(null, "Pull the impressions for the posts read this run", null)).toBe("check");
    expect(actionTypeFromStep(null, "Send back the top job titles from the viewer list", null)).toBe("check");
  });

  it("and a plain setup step is still setup", () => {
    expect(actionTypeFromStep(null, "Connect the account in Settings", null)).toBe("setup");
    expect(actionTypeFromStep(null, "Reconnect the account in Settings", null)).toBe("setup");
    expect(actionTypeFromStep(null, "Claim the profile", null)).toBe("setup");
    expect(actionTypeFromStep(null, "Pin the introduction post", null)).toBe("setup");
    expect(actionTypeFromStep(null, "Decide the handle", null)).toBe("setup");
  });
});
