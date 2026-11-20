"use client";

import { ChannelActionCard } from "./ChannelActionCard";
import { TARGET_WORD } from "./cardGroups";
import { GroupMetaProvider, groupMetaLine } from "./card/groupMeta";
import type { ActionHandlers, ActionItem, ActionRedoState, PlatformSpec } from "./types";

export function CardGroup({ members, targetKind, platform, handlers, busyId, redoState, newIds }: {
  members: ActionItem[];
  targetKind: string;
  platform?: PlatformSpec;
  handlers: ActionHandlers;
  busyId?: string | null;
  redoState?: Record<string, ActionRedoState>;
  newIds?: Set<string>;
}) {
  const word = TARGET_WORD[targetKind] ?? "thing";
  return (
    <>
      {members.map((a, i) => (
        <GroupMetaProvider key={a.id} value={members.length > 1 ? groupMetaLine(i, members.length, word, platform?.pinCards === true) : null}>
          <ChannelActionCard action={a} platform={platform} handlers={handlers} busy={busyId === a.id} redoing={redoState?.[a.id]} isNew={newIds?.has(a.id)} />
        </GroupMetaProvider>
      ))}
    </>
  );
}
