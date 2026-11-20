import type { ChannelEntry } from "./ChannelsPage";

export const visibleWaiting = (entry: ChannelEntry): number =>
  entry.noticeWaiting ?? entry.waiting;

export const canReadChannel = (entry: Pick<ChannelEntry, "lock">): boolean =>
  !entry.lock || (entry.lock.kind === "plan" && entry.lock.open === true);

export const canExecuteChannel = (entry: Pick<ChannelEntry, "lock">): boolean => !entry.lock;

export type NeedYouTally = {
  items: number;
  channels: number;
  lockedOnly: boolean;
};

export const UPGRADE_TO_START = "Upgrade to start your channels";

export function needYouTally(entries: readonly ChannelEntry[]): NeedYouTally {
  let items = 0;
  let channels = 0;
  let openWork = false;
  let lockedWork = false;
  for (const entry of entries) {
    if (entry.lock?.kind === "plan" && !canReadChannel(entry)) {
      if (entry.waiting > 0) lockedWork = true;
      continue;
    }
    if (entry.waiting > 0) openWork = true;
    const shown = visibleWaiting(entry);
    items += shown;
    if (shown > 0) channels += 1;
  }
  return { items, channels, lockedOnly: lockedWork && !openWork };
}
