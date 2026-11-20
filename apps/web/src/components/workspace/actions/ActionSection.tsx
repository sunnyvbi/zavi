"use client";

import type { LaneEntry } from "./cardGroups";
import type { ActionItem } from "./types";
import type { ActionSectionProps } from "./actionSectionTypes";
import { ChannelActionSection } from "./ChannelActionSection";

export type KindGroup = {
  kind: string;
  label: string;
  entries: LaneEntry<ActionItem>[];
  lead: number;
  open: boolean;
  onToggle: () => void;
};

export function ActionSection(props: ActionSectionProps) {
  return <ChannelActionSection {...props} />;
}
