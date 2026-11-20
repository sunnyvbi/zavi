"use client";

import { ActionCard } from "../ActionCard";
import type { ActionBodyProps } from "../types";

export function UpdateAd(props: ActionBodyProps) {
  return <ActionCard {...props} kindLabel="Ad change" />;
}
