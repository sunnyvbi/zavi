import type { ChannelPlanLock } from "../channelPlanLock";

export const LAUNCH_LOCK_ID = "campaign-launch-locked";

export const launchLockWords = (lock: ChannelPlanLock | null, name: string): string =>
  lock?.tierName
    ? `New campaigns and launches on ${name} need the ${lock.tierName} plan. You can still pause your campaigns.`
    : lock?.soon
      ? `${name} is coming soon, so new campaigns and launches are off for now. You can still pause your campaigns.`
      : "";
