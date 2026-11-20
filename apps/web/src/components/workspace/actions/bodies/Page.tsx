"use client";

import { ActionCard } from "../ActionCard";
import type { ActionBodyProps } from "../types";

export function Page(props: ActionBodyProps) {
  return <ActionCard {...props} kindLabel="Page" deliverableLabel="Page copy" />;
}
