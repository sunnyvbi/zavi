import type { ReactNode } from "react";
import type { LaneEntry } from "./cardGroups";
import type { ActionHandlers, ActionItem, ActionRedoState, PlatformSpec } from "./types";
import type { KindGroup } from "./ActionSection";

export interface ActionSectionProps {
  title?: string;
  kinds?: KindGroup[];
  actions: ActionItem[];
  completed?: ActionItem[];
  entries?: LaneEntry<ActionItem>[];
  platform?: PlatformSpec;
  handlers: ActionHandlers;
  busyId?: string | null;
  redoState?: Record<string, ActionRedoState>;
  newIds?: Set<string>;
  more?: number;
  onShowMore?: () => void;
  onShowLess?: () => void;
  empty: ReactNode;
  cooking?: ReactNode;
  emptyGroups?: boolean;
  keepEmpty?: boolean;
  lead?: ReactNode[];
  extra?: { cards: ReactNode[]; position: "before" | "after" };
}
