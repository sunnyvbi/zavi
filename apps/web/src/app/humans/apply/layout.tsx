import { notFound } from "next/navigation";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import type { ReactNode } from "react";

export default function HumanApplyLayout({ children }: { children: ReactNode }) {
  if (!CREATOR_MARKETPLACE_ENABLED) notFound();
  return children;
}
