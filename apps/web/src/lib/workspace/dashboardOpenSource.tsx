"use client";

import { createContext, useContext } from "react";

export type DashboardOpenSource = "roster" | "summon";

const DashboardOpenSourceContext = createContext<DashboardOpenSource>("roster");

export function DashboardOpenSourceProvider({
  source,
  children,
}: {
  source: DashboardOpenSource;
  children: React.ReactNode;
}) {
  return (
    <DashboardOpenSourceContext.Provider value={source}>
      {children}
    </DashboardOpenSourceContext.Provider>
  );
}

export function useDashboardOpenSource(): DashboardOpenSource {
  return useContext(DashboardOpenSourceContext);
}
