
import { channelForBriefKind } from "@zavi/shared";
import { HUMAN_APPLICATION_REVIEW_CLASS } from "@/services/humans/applications";
import { refuseIfChannelPlanLocked, type ChannelPlanRefusal, type PlanDeps } from "@/services/growth/preview-plan";
import { loadTierGateConfig, resolveTenantTier } from "@/services/agents/entitlement";

export const SOCIAL_PUBLISH_CLASS = "social.publish.v2";

export const SOCIAL_ACTION_CHANNEL_SLUG: Readonly<Record<string, string>> = {
  linkedin: "linkedin_organic",
  linkedin_image: "linkedin_organic",
  linkedin_video: "linkedin_organic",
  reddit: "reddit_organic",
  reddit_comment: "reddit_organic",
  x: "x_organic",
  x_image: "x_organic",
  x_video: "x_organic",
  instagram_image: "instagram_organic",
  instagram_video: "instagram_organic",
  youtube_video: "youtube_organic",
  tiktok_video: "tiktok_organic",
  pinterest_pin: "pinterest_organic",
};

export function socialActionKeysForChannel(channelSlug: string): string[] {
  return Object.entries(SOCIAL_ACTION_CHANNEL_SLUG)
    .filter(([, slug]) => slug === channelSlug)
    .map(([key]) => key);
}

export async function refuseIfSocialPostPlanLocked(
  tenant_id: string,
  socialChannel: string,
  deps: PlanDeps & { strict?: boolean } = {},
): Promise<ChannelPlanRefusal | null> {
  const slug = Object.hasOwn(SOCIAL_ACTION_CHANNEL_SLUG, socialChannel) ? SOCIAL_ACTION_CHANNEL_SLUG[socialChannel] : null;
  if (!slug) return null;
  const refusal = await refuseIfChannelPlanLocked(tenant_id, slug, deps);
  if (!refusal) return null;
  try {
    const cfg = await (deps.loadConfig ?? loadTierGateConfig)();
    if (cfg.deferred) throw new Error("tier config unreadable");
    return (await (deps.resolveTier ?? resolveTenantTier)(tenant_id, cfg)) === "free" ? refusal : null;
  } catch (e) {
    if (deps.strict === true) throw e;
    return refusal;
  }
}

export type ChannelResolvable = {
  agent_run_id: string | null;
  decision_class?: string | null;
  brief_kind?: string | null;
  social_channel?: string | null;
};

export function channelSlugForDecision(
  d: ChannelResolvable,
  channelOfRun: (runId: string) => string | null | undefined,
): string | null {
  const fromRun = d.agent_run_id ? channelOfRun(d.agent_run_id) : null;
  if (fromRun) return fromRun;
  if (d.decision_class === HUMAN_APPLICATION_REVIEW_CLASS) {
    return typeof d.brief_kind === "string"
      ? channelForBriefKind(d.brief_kind)?.slug ?? null
      : null;
  }
  if (d.decision_class === SOCIAL_PUBLISH_CLASS) {
    return typeof d.social_channel === "string"
      ? SOCIAL_ACTION_CHANNEL_SLUG[d.social_channel] ?? null
      : null;
  }
  return null;
}

export function channelFieldsFromBody(body: unknown): {
  brief_kind: string | null;
  social_channel: string | null;
} {
  const b = (body ?? {}) as { brief_kind?: unknown; channel?: unknown };
  return {
    brief_kind: typeof b.brief_kind === "string" ? b.brief_kind : null,
    social_channel: typeof b.channel === "string" ? b.channel : null,
  };
}
