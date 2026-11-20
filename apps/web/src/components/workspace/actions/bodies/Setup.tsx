"use client";

import { ActionCard } from "../ActionCard";
import type { ActionBodyProps } from "../types";

export function Setup(props: ActionBodyProps) {
  return <ActionCard {...props} kindLabel="Setup" deliverableLabel="Details to enter" />;
}
