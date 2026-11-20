
import type { ArchetypeKit, ArchetypeSlug } from "@/services/agents/archetype-kits/types";
import { MARKETPLACE_KIT } from "@/services/agents/archetype-kits/kits/marketplace";
import { SAAS_DASHBOARD_KIT } from "@/services/agents/archetype-kits/kits/saas-dashboard";
import { LANDING_KIT } from "@/services/agents/archetype-kits/kits/landing";
import { SHOP_KIT } from "@/services/agents/archetype-kits/kits/shop";
import { BLOG_KIT } from "@/services/agents/archetype-kits/kits/blog";

export const ARCHETYPE_KITS: readonly ArchetypeKit[] = [
  MARKETPLACE_KIT,
  SAAS_DASHBOARD_KIT,
  LANDING_KIT,
  SHOP_KIT,
  BLOG_KIT,
] as const;

export const DEFAULT_ARCHETYPE: ArchetypeSlug = "saas-dashboard";

const RESERVED_KEYWORD_FALLBACK: ReadonlyArray<{
  reserved: ArchetypeSlug;
  routesTo: ArchetypeSlug;
  keywords: readonly string[];
}> = [
  { reserved: "booking", routesTo: "marketplace", keywords: ["booking", "book a", "appointment", "reservation", "schedule a", "calendar booking", "availability"] },
  { reserved: "crm", routesTo: "saas-dashboard", keywords: ["crm", "leads", "pipeline", "deals", "contacts", "sales pipeline", "customer relationship"] },
  { reserved: "community", routesTo: "marketplace", keywords: ["community", "forum", "social network", "feed", "posts", "members", "discussion"] },
  { reserved: "project-management", routesTo: "saas-dashboard", keywords: ["project management", "tasks", "kanban", "boards", "sprints", "to-do", "todo", "issue tracker"] },
  { reserved: "directory", routesTo: "marketplace", keywords: ["directory", "listings directory", "yellow pages", "find a", "search directory", "catalog of"] },
  { reserved: "fintech-tracker", routesTo: "saas-dashboard", keywords: ["fintech", "expenses", "budget", "transactions", "spending", "invoices", "finance tracker", "money tracker"] },
];

export type ArchetypeSelection = {
  kit: ArchetypeKit;
  classified: ArchetypeSlug;
  score: number;
  usedFallback: boolean;
};

function normalize(idea: string): string {
  return ` ${idea.toLowerCase().replace(/\s+/g, " ").trim()} `;
}

function scoreKeywords(normIdea: string, keywords: readonly string[]): number {
  let score = 0;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (normIdea.includes(k)) {
      score += k.includes(" ") ? k.split(" ").length : 1;
    }
  }
  return score;
}

export function selectArchetype(idea: string): ArchetypeSelection {
  const norm = normalize(idea ?? "");

  type Cand = { classified: ArchetypeSlug; routesTo: ArchetypeSlug; score: number };
  const candidates: Cand[] = ARCHETYPE_KITS.map((kit) => ({
    classified: kit.slug,
    routesTo: kit.slug,
    score: scoreKeywords(norm, kit.keywords),
  }));

  for (const r of RESERVED_KEYWORD_FALLBACK) {
    candidates.push({
      classified: r.reserved,
      routesTo: r.routesTo,
      score: scoreKeywords(norm, r.keywords),
    });
  }

  let best: Cand | null = null;
  for (const c of candidates) {
    if (c.score > 0 && (best === null || c.score > best.score)) best = c;
  }

  if (best === null) {
    return {
      kit: kitBySlug(DEFAULT_ARCHETYPE),
      classified: DEFAULT_ARCHETYPE,
      score: 0,
      usedFallback: false,
    };
  }

  const kit = kitBySlug(best.routesTo);
  return {
    kit,
    classified: best.classified,
    score: best.score,
    usedFallback: best.classified !== kit.slug,
  };
}

export function kitBySlug(slug: ArchetypeSlug): ArchetypeKit {
  const kit = ARCHETYPE_KITS.find((k) => k.slug === slug);
  if (!kit) throw new Error(`archetype kit not authored: ${slug}`);
  return kit;
}

export function archetypeHintFor(idea: string): {
  slug: ArchetypeSlug;
  classified: ArchetypeSlug;
  title: string;
  score: number;
  usedFallback: boolean;
  pages: string[];
  components: string[];
  tables: string[];
  visualMood: string;
} {
  const sel = selectArchetype(idea);
  return {
    slug: sel.kit.slug,
    classified: sel.classified,
    title: sel.kit.title,
    score: sel.score,
    usedFallback: sel.usedFallback,
    pages: sel.kit.pages.map((p) => p.name),
    components: sel.kit.components.map((c) => c.id),
    tables: sel.kit.schema.map((t) => t.name),
    visualMood: sel.kit.visualDirection.mood,
  };
}

export type ArchetypeHint = ReturnType<typeof archetypeHintFor>;
