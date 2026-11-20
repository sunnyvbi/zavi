"use client";

import { ActionCard } from "../ActionCard";
import type { ActionBodyProps } from "../types";

export function Check(props: ActionBodyProps) {
  return <ActionCard {...props} kindLabel="Check" deliverableLabel="What to look for" />;
}
