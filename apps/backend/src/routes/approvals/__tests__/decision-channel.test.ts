
import { describe, it, expect, vi } from "vitest";
import { isChannelSlug } from "@zavi/shared";
import { SOCIAL_CHANNEL_ACTIONS } from "@/services/connectors/social-channels";
import { HUMAN_APPLICATION_REVIEW_CLASS } from "@/services/humans/applications";
import {
  SOCIAL_ACTION_CHANNEL_SLUG,
  SOCIAL_PUBLISH_CLASS,
  channelFieldsFromBody,
  channelSlugForDecision,
  refuseIfSocialPostPlanLocked,
  socialActionKeysForChannel,
} from "@/routes/approvals/decision-channel";

const noRuns = () => null;

describe("SOCIAL_ACTION_CHANNEL_SLUG parity", () => {
  it("maps every social action key", () => {
    for (const key of Object.keys(SOCIAL_CHANNEL_ACTIONS)) {
      expect(SOCIAL_ACTION_CHANNEL_SLUG[key], key).toBeTruthy();
    }
  });

  it("points only at real channel registry slugs", () => {
    for (const slug of Object.values(SOCIAL_ACTION_CHANNEL_SLUG)) {
      expect(isChannelSlug(slug), slug).toBe(true);
    }
  });

  it("reverse lookup round-trips", () => {
    for (const [key, slug] of Object.entries(SOCIAL_ACTION_CHANNEL_SLUG)) {
      expect(socialActionKeysForChannel(slug)).toContain(key);
    }
    expect(socialActionKeysForChannel("meta_ads")).toEqual([]);
  });
});

describe("channelSlugForDecision", () => {
  it("resolves a social post from body.channel", () => {
    expect(
      channelSlugForDecision(
        { agent_run_id: null, decision_class: SOCIAL_PUBLISH_CLASS, ...channelFieldsFromBody({ channel: "x_video" }) },
        noRuns,
      ),
    ).toBe("x_organic");
  });

  it("does not read body.channel for a non-social class", () => {
    expect(
      channelSlugForDecision(
        { agent_run_id: null, decision_class: "pm.needs_action", social_channel: "x_video" },
        noRuns,
      ),
    ).toBeNull();
  });

  it("keeps the human review card path", () => {
    const d = { agent_run_id: null, decision_class: HUMAN_APPLICATION_REVIEW_CLASS, brief_kind: "not-a-real-kind" };
    expect(channelSlugForDecision(d, noRuns)).toBeNull();
  });

  it("prefers the run's stamped channel", () => {
    expect(
      channelSlugForDecision(
        { agent_run_id: "r1", decision_class: SOCIAL_PUBLISH_CLASS, social_channel: "tiktok_video" },
        () => "reddit_organic",
      ),
    ).toBe("reddit_organic");
  });
});

describe("refuseIfSocialPostPlanLocked", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const plan = (tier: "free" | "starter" | "growth") => ({
    loadConfig: vi.fn(async () => ({
      enforced: false,
      agentMin: { linkedin_organic: "starter" as const, tiktok_organic: "growth" as const },
      proTenants: [],
      alwaysPro: [],
    })),
    resolveTier: async () => tier,
  });

  it("refuses a Free workspace, naming the owning channel's tier", async () => {
    expect((await refuseIfSocialPostPlanLocked(T, "linkedin_image", plan("free")))?.required_tier).toBe("starter");
    expect((await refuseIfSocialPostPlanLocked(T, "tiktok_video", plan("free")))?.required_tier).toBe("growth");
  });

  it("never refuses a paid workspace, even for a channel above its tier", async () => {
    expect(await refuseIfSocialPostPlanLocked(T, "linkedin_image", plan("starter"))).toBeNull();
    expect(await refuseIfSocialPostPlanLocked(T, "tiktok_video", plan("starter"))).toBeNull();
    expect(await refuseIfSocialPostPlanLocked(T, "tiktok_video", plan("growth"))).toBeNull();
  });

  it("keeps the refusal when the tier read fails after the lock was found", async () => {
    let calls = 0;
    const deps = {
      ...plan("free"),
      resolveTier: async () => {
        if (++calls > 1) throw new Error("subscription read failed");
        return "free" as const;
      },
    };
    expect(await refuseIfSocialPostPlanLocked(T, "linkedin_image", deps)).not.toBeNull();
  });

  it("strict: a failed second tier read throws instead of refusing a paid workspace's post", async () => {
    let calls = 0;
    const deps = {
      ...plan("starter"),
      strict: true,
      resolveTier: async () => {
        if (++calls > 1) throw new Error("subscription read failed");
        return "starter" as const;
      },
    };
    await expect(refuseIfSocialPostPlanLocked(T, "tiktok_video", deps)).rejects.toThrow("subscription read failed");
  });

  it("an action key with no organic channel is not blocked, and costs no plan read", async () => {
    const deps = plan("free");
    for (const key of ["slack_post", "", "constructor", "__proto__"]) {
      expect(await refuseIfSocialPostPlanLocked(T, key, deps), key).toBeNull();
    }
    expect(deps.loadConfig).not.toHaveBeenCalled();
  });
});
