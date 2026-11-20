"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ChannelTabKey } from "./ChannelTabs";

type ChannelPage = {
  active: ChannelTabKey;
  tabs: readonly ChannelTabKey[];
  analytics: HTMLElement | null;
};

const ChannelPageContext = createContext<ChannelPage | null>(null);

export function ChannelPageProvider({ value, children }: { value: ChannelPage; children: ReactNode }) {
  return <ChannelPageContext.Provider value={value}>{children}</ChannelPageContext.Provider>;
}

export function useChannelPage(): ChannelPage | null {
  return useContext(ChannelPageContext);
}

export function OnTab({ tab, children }: { tab: ChannelTabKey; children: ReactNode }) {
  const page = useChannelPage();
  if (page && page.tabs.includes(tab) && page.active !== tab) return null;
  return <>{children}</>;
}

export function AnalyticsPortal({ children }: { children: ReactNode }) {
  const page = useChannelPage();
  if (!page || !page.tabs.includes("analytics")) return <>{children}</>;
  return page.analytics ? createPortal(children, page.analytics) : null;
}
