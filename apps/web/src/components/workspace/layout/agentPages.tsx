
import type { ReactNode } from "react";
import { CodeXml, Landmark, Scale } from "lucide-react";
import { lockedTierOf, type LockTier } from "@/lib/workspace/planUpgrade";

export type AgentPage = {
  kind: "fundraising" | "supply-demand" | "engineer";
  slug: string;
  label: string;
  icon: ReactNode;
  lockedTier: Exclude<LockTier, "free"> | null;
};

const AGENT_PAGES: Omit<AgentPage, "lockedTier">[] = [
  {
    kind: "fundraising",
    slug: "fundraising",
    label: "Fundraising",
    icon: <Landmark className="h-4 w-4" aria-hidden />,
  },
  {
    kind: "supply-demand",
    slug: "supply-demand-balancer",
    label: "Supply & Demand",
    icon: <Scale className="h-4 w-4" aria-hidden />,
  },
  {
    kind: "engineer",
    slug: "engineer",
    label: "Engineer",
    icon: <CodeXml className="h-4 w-4" aria-hidden />,
  },
];

export function visibleAgentPages(
  treeAgents: ReadonlyArray<{ slug: string; locked_tier?: string | null }>,
  supplyDemandEligible: boolean,
): AgentPage[] {
  const bySlug = new Map(treeAgents.map((a) => [a.slug, a]));
  return AGENT_PAGES.filter(
    (page) =>
      bySlug.has(page.slug) &&
      (page.kind !== "supply-demand" || supplyDemandEligible),
  ).map((page) => ({
    ...page,
    lockedTier: lockedTierOf(bySlug.get(page.slug)),
  }));
}

const CUSTOM_SLUG_RE = /^c-[a-z0-9]{8,12}$/;

export type CustomAgentRow = { slug: string; name?: string; custom?: boolean; custom_agent_id?: string };

export function customAgentRows<T extends CustomAgentRow>(agents: ReadonlyArray<T>): T[] {
  return agents.filter((a) => a.custom === true && CUSTOM_SLUG_RE.test(a.slug) && !!a.name);
}
