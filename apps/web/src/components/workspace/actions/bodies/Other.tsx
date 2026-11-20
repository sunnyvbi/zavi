"use client";

import { ActionCard } from "../ActionCard";
import type { ActionBodyProps } from "../types";

export function Other(props: ActionBodyProps) {
  return <ActionCard {...props} kindLabel="To do" />;
}
