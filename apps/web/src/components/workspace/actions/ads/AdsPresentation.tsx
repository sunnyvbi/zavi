"use client";

import { createContext, useContext, type ReactNode } from "react";
import { getChannel } from "@zavi/shared";
import type { ActionBodyProps } from "../types";

export type AdsPresentationValue = ActionBodyProps & { inlineInstructions?: boolean };

const AdsPresentationContext = createContext<AdsPresentationValue | null>(null);

export function isAdsChannel(slug: string): boolean {
  const channel = getChannel(slug);
  return channel?.category === "paid" && channel.section !== "creators";
}

export function AdsPresentation({ value, children }: { value: AdsPresentationValue; children: ReactNode }) {
  return <AdsPresentationContext.Provider value={value}>{children}</AdsPresentationContext.Provider>;
}

export function useAdsPresentation(): AdsPresentationValue | null {
  return useContext(AdsPresentationContext);
}
