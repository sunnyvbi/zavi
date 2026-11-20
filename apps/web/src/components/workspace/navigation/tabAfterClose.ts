import type { TabDescriptor } from "@/lib/workspace/types";

export function tabAfterClose(
  tabs: TabDescriptor[],
  closed: TabDescriptor,
  toHome = false,
) {
  const remaining = tabs.filter((tab) => tab.id !== closed.id);
  const home = remaining.find((tab) => tab.kind === "home");
  if (toHome) return home;
  const agents = tabs.filter((tab) => tab.payload.kind === "agent");
  const survivors = agents.filter((tab) => tab.id !== closed.id);
  const sameAgent = agents.filter(
    (tab) =>
      tab.payload.kind === "agent" &&
      closed.payload.kind === "agent" &&
      tab.payload.slug === closed.payload.slug,
  );
  const sameAgentSurvivors = sameAgent.filter((tab) => tab.id !== closed.id);
  return (
    sameAgentSurvivors[sameAgent.findIndex((tab) => tab.id === closed.id)] ??
    sameAgentSurvivors.at(-1) ??
    survivors[agents.findIndex((tab) => tab.id === closed.id)] ??
    survivors.at(-1) ??
    home ??
    remaining[0]
  );
}
