import { channelPlanLock } from "@/services/growth/preview-plan";
import { isChannelLockedStrict } from "@/services/channels/lock";

export async function channelVideoBlock(
  tenant_id: string,
  deps: { planLock?: typeof channelPlanLock; lockedStrict?: typeof isChannelLockedStrict } = {},
): Promise<string | null> {
  const lockedStrict = deps.lockedStrict ?? isChannelLockedStrict;
  try {
    if (await lockedStrict("generated_video")) return "AI UGC Videos is switched off right now, so the video was not made";
  } catch {
    return "Zavi could not check whether video making is on, so the video was not made. Try again in a minute";
  }
  const lock = await (deps.planLock ?? channelPlanLock)(tenant_id, "generated_video");
  if (lock) return `your plan does not include AI UGC Videos (it needs ${lock.required_tier}), so the video was not made`;
  return null;
}
