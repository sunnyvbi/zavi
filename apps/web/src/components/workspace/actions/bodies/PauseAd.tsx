"use client";

import { ActionCard } from "../ActionCard";
import type { ActionBodyProps } from "../types";

export function PauseAd(props: ActionBodyProps) {
  return <ActionCard {...props} kindLabel="Pause" />;
}
