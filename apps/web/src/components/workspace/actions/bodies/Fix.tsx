"use client";

import { ActionCard } from "../ActionCard";
import type { ActionBodyProps } from "../types";

export function Fix(props: ActionBodyProps) {
  return <ActionCard {...props} kindLabel="Fix" deliverableLabel="Use this" />;
}
