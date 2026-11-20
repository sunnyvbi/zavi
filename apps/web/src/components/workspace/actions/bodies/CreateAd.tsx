"use client";

import { ActionCard } from "../ActionCard";
import type { ActionBodyProps } from "../types";

export function CreateAd(props: ActionBodyProps) {
  return <ActionCard {...props} kindLabel="Ad" />;
}
