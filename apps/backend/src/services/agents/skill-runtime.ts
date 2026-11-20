
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import { logEvent } from "@/services/logging/logEvent";
import type { ResolvedTool } from "@/services/mcp/discovery";
import { splitAgentSection } from "./agent-sections";

export const SKILL_SERVER_ID = "skill" as const;
export const SKILL_LOAD_TOOL = "load" as const;
export const SKILL_LOAD_TOOL_NAME = `${SKILL_SERVER_ID}__${SKILL_LOAD_TOOL}` as const;

type SkillSource = "core" | "playbooks" | "ads" | "channel";

const SKILL_ROOTS: Record<"core" | "playbooks", string> = {
  core: path.join(process.cwd(), "src", "agents", "_core", "skills"),
  playbooks: path.join(process.cwd(), "skills"),
};

const SKILL_FILENAME: Record<"core" | "playbooks", string> = {
  core: "skill.md",
  playbooks: "SKILL.md",
};

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const MAX_SKILL_BODY_BYTES = 12_000;

export const MAX_SKILL_LOADS_PER_RUN = 3;

export interface SkillRegistryEntry {
  slug: string;
  when_to_use: string;
  applies_to: readonly string[];
  source?: SkillSource;
  exclusive_group?: string;
  priority?: number;
  variant_only?: true;
  agent_section?: string;
}

export function skillCorpusPath(entry: SkillRegistryEntry): string {
  if (entry.agent_section) {
    return path.join(process.cwd(), "src", "agents", entry.applies_to[0], "agent.md");
  }
  const source: SkillSource = entry.source ?? "core";
  if (source === "ads") {
    return path.join(process.cwd(), "src", "agents", "_core", "ads", `${entry.slug}.md`);
  }
  if (source === "channel") {
    return path.join(
      process.cwd(),
      "src",
      "agents",
      entry.applies_to[0],
      "skills",
      `${entry.slug}.md`,
    );
  }
  return path.join(SKILL_ROOTS[source], entry.slug, SKILL_FILENAME[source]);
}

const DEFAULT_SKILL_PRIORITY = 50;

export const SKILL_REGISTRY: readonly SkillRegistryEntry[] = [
  {
    slug: "architect",
    when_to_use: "Connected new campaign or justified rebuild, with exact PAUSED structure and required inputs.",
    applies_to: ["google_ads", "youtube_ads"],
    source: "ads",
  },
  {
    slug: "causality",
    when_to_use: "Performance break, due experiment readout or manual causal test plan.",
    applies_to: ["google_ads", "youtube_ads"],
    source: "ads",
  },
  {
    slug: "creative",
    when_to_use: "Connected video creative/new build; public recipe already injects this.",
    applies_to: ["youtube_ads"],
    source: "channel",
  },
  {
    slug: "evidence",
    when_to_use: "Establish evidence and ownership outside recipe runs; recipe context already injects this.",
    applies_to: ["google_ads", "youtube_ads"],
    source: "ads",
  },
  {
    slug: "execution",
    when_to_use: "Last load before a supported proposal or application/readback follow-up.",
    applies_to: ["google_ads", "youtube_ads"],
    source: "ads",
  },
  {
    slug: "measurement",
    when_to_use: "Tier-0 measurement failure or unresolved conversion goal/recording issue.",
    applies_to: ["google_ads", "youtube_ads"],
    source: "ads",
  },
  {
    slug: "negatives",
    when_to_use: "Second skill for Search/PMax query exclusions, collateral checks and exact promotion.",
    applies_to: ["google_ads"],
    source: "channel",
  },
  {
    slug: "pmax",
    when_to_use: "Observed PERFORMANCE_MAX work item, never Search or Video.",
    applies_to: ["google_ads"],
    source: "channel",
    exclusive_group: "google-ads-optimizer",
  },
  {
    slug: "search",
    when_to_use: "Observed SEARCH campaign including AI Max, never PMax or Video.",
    applies_to: ["google_ads"],
    source: "channel",
    exclusive_group: "google-ads-optimizer",
  },
  {
    slug: "video",
    when_to_use: "Observed VIDEO or DEMAND_GEN performance diagnosis using paid video reads.",
    applies_to: ["youtube_ads"],
    source: "channel",
  },
  {
    slug: "chart-design",
    when_to_use:
      "the answer is data the user should SEE — a breakdown, a series over time, a comparison, a funnel, headline numbers, or a custom visual.",
    applies_to: ["operator"],
  },
  {
    slug: "extension-browser-control",
    when_to_use:
      "the founder, in the Zavi Chrome extension, asks you to DO something in the site open in their tab. Load BEFORE calling extension__browser_task.",
    applies_to: ["operator"],
  },
  {
    slug: "operator-render-video",
    when_to_use:
      "the user wants a launch, explainer, ad or social VIDEO made or changed. Load BEFORE calling praxis__render_video.",
    applies_to: ["operator"],
    agent_section: "Launch / explainer / ad / social videos",
  },
  {
    slug: "operator-slack-document",
    when_to_use:
      "sending a document, report or any long text to Slack. Load BEFORE rendering or posting it.",
    applies_to: ["operator"],
    agent_section: "Sending a document to Slack",
  },
  {
    slug: "copywriting",
    when_to_use:
      "writing or rewriting marketing copy — headlines, subheads, CTAs, value props, any page copy.",
    applies_to: ["content-design"],
  },
  {
    slug: "geo-audit",
    when_to_use:
      "getting cited by AI search — AI Overviews, AI Mode, ChatGPT, Perplexity; AI crawler access, citability, llms.txt.",
    applies_to: ["growth-lead", "content-design", "seo-geo", "geo"],
    source: "playbooks",
    priority: 10,
  },
  {
    slug: "page-cro",
    when_to_use:
      "improving conversions on a marketing page (low conversion / high bounce / 'this page isn't converting').",
    applies_to: ["growth-lead", "content-design"],
  },
  {
    slug: "seo-audit",
    when_to_use:
      "a general SEO diagnosis — 'why aren't we ranking', organic traffic drop, where to start.",
    applies_to: ["growth-lead", "content-design", "seo-geo", "seo"],
    priority: 90,
  },
  {
    slug: "seo-content",
    when_to_use:
      "whether content deserves to rank — E-E-A-T, thin content, content audit, author credibility.",
    applies_to: ["content-design", "seo-geo", "seo"],
    source: "playbooks",
    priority: 35,
  },
  {
    slug: "seo-content-brief",
    when_to_use:
      "planning a page before it is written — content brief, outline, per-section keyword guidance.",
    applies_to: ["content-design", "seo-geo", "seo"],
    source: "playbooks",
    priority: 15,
  },
  {
    slug: "seo-page",
    when_to_use:
      "one specific URL to review — 'check this page', on-page SEO, single-page audit.",
    applies_to: ["growth-lead", "content-design", "seo-geo", "seo"],
    source: "playbooks",
    priority: 45,
  },
  {
    slug: "seo-schema",
    when_to_use:
      "structured data — schema detection, validation, JSON-LD generation, rich results.",
    applies_to: ["content-design", "seo-geo", "seo", "geo"],
    source: "playbooks",
    priority: 20,
  },
  {
    slug: "seo-technical",
    when_to_use:
      "technical SEO — crawlability, indexation, robots.txt, sitemaps, canonicals, redirects, Core Web Vitals, JS rendering.",
    applies_to: ["growth-lead", "seo-geo", "seo"],
    source: "playbooks",
    priority: 30,
  },
];

const corpusMap: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const entry of SKILL_REGISTRY) {
    if (!SLUG_RE.test(entry.slug)) {
      console.error(
        `[skill-runtime] registry slug '${entry.slug}' fails slug regex — dropped`,
      );
      continue;
    }
    m.set(entry.slug, skillCorpusPath(entry));
  }
  return m;
})();

export function skillsForAgent(
  agentSlug: string,
  variantSkills: readonly string[] = [],
): SkillRegistryEntry[] {
  if (typeof agentSlug !== "string" || agentSlug.length === 0) return [];
  return SKILL_REGISTRY.filter(
    (s) =>
      s.applies_to.includes(agentSlug) && (!s.variant_only || variantSkills.includes(s.slug)),
  ).sort(
    (a, b) => a.slug.localeCompare(b.slug),
  );
}

export function agentHasSkills(agentSlug: string): boolean {
  return skillsForAgent(agentSlug).length > 0;
}

const KEYWORD_TRIGGERS: Record<string, RegExp> = {
  "chart-design":
    /\b(charts?|graphs?|plot (?:it|this|these)|visuali[sz]\w*|bar chart|pie chart|donut|funnel(?!-)|breakdown|break (?:it |this |them )?down|broken down|split (?:by|across)|distribution|by (?:channel|week|month|day|source|campaign|segment|stage|city|region|cohort|platform)|over time|over the (?:last|past) \d+|week[- ]over[- ]week|month[- ]over[- ]month|top \d+|trend(?:s|ed|ing)? (?:over|by|for|across)|trendline|show me the numbers)\b/i,
  copywriting:
    /\b(copy|copywrit\w*|rewrite|re-?word|headlines?|sub-?heads?|CTAs?|call to action|value prop\w*|taglines?|hero (?:copy|section|headline)|marketing copy|messaging|write (?:the |our |a |some )?(?:copy|headline|landing|home ?page|hero|pricing|about|feature) )\b/i,
  "page-cro":
    /\b(convert(?:ing|s)?|conversions?|CRO|bounce(?: rate)?|isn'?t converting|not converting|low conversion|high bounce|conversion rate|optimi[sz]e (?:the |this |our )?(?:page|landing|conversion|funnel)|improve (?:the |our )?conversion)\b/i,
  "seo-audit":
    /\b(SEO|search engine optimi[sz]ation|not ranking|aren'?t we ranking|rankings? (?:dropped|fell|declined|tanked)|organic (?:search|traffic|rankings?)|search visibility|traffic drop)\b/i,
  "geo-audit":
    /\b(AI Overviews?|AIO|SGE|AEO|generative engine optimi[sz]ation|GEO (?:audit|score|readiness|optimi[sz]\w*|strateg\w*|analysis)|AI search|AI Mode|LLM optimi[sz]ation|Perplexity|ChatGPT search|AI citations?|cited by (?:AI|ChatGPT|Perplexity)|AI visibility|AI crawlers?|llms\.txt|GPTBot|ClaudeBot|PerplexityBot)\b/i,
  "seo-technical":
    /\b(technical SEO|crawl(?:ability|ing|ed|er|ers)?|robots\.txt|sitemaps?|canonicals?|noindex|redirect (?:chains?|loops?)|index(?:ing|ed|ation)|core web vitals|CWV|LCP|INP|CLS|site speed|page ?speed|security headers|mixed content|SSL cert\w*|hreflang|IndexNow|JS rendering|JavaScript rendering|server-?side render\w*|\bSSR\b)\b/i,
  "seo-content":
    /\b(E-?E-?A-?T|content quality|content audit|thin content|readability|helpful content|quality rater|author (?:bio|credentials?|byline)|trustworthiness|topical authority|duplicate content)\b/i,
  "seo-schema":
    /\b(schema(?:\.org)?|structured data|JSON-?LD|rich (?:results?|snippets?)|microdata|RDFa|markup)\b/i,
  "seo-page":
    /\b(analy[sz]e this page|check (?:this|the|our) page|review this (?:page|URL)|single (?:page|URL)|page (?:SEO|analysis|audit|score)|on-?page(?: SEO)?|title tags?|meta descriptions?|open graph|og:image)\b/i,
  "seo-content-brief":
    /\b(content brief|writing brief|content outline|content plan|blog brief|service page brief|brief for|outline for)\b/i,
};

export function resolveSkills(agentSlug: string, taskText: string): string[] {
  if (typeof taskText !== "string" || taskText.trim().length === 0) return [];
  const matched = skillsForAgent(agentSlug).filter((s) => {
    const re = KEYWORD_TRIGGERS[s.slug];
    return re instanceof RegExp && re.test(taskText);
  });
  matched.sort(
    (a, b) =>
      (a.priority ?? DEFAULT_SKILL_PRIORITY) - (b.priority ?? DEFAULT_SKILL_PRIORITY) ||
      a.slug.localeCompare(b.slug),
  );
  return matched.slice(0, MAX_SKILL_LOADS_PER_RUN).map((s) => s.slug);
}

export function buildSkillIndexBlock(
  agentSlug: string,
  variantSkills: readonly string[] = [],
): string {
  const skills = skillsForAgent(agentSlug, variantSkills);
  if (skills.length === 0) return "";
  const lines = skills.map(
    (s) => `- \`${SKILL_LOAD_TOOL_NAME}\` with slug \`${s.slug}\` — ${s.when_to_use}`,
  );
  return (
    [
      "## Skill playbooks (load on demand)",
      `You have expert playbooks you can pull in mid-task with the \`${SKILL_LOAD_TOOL_NAME}\` tool (pass the slug). Load one only when the task matches — then follow it. Cap: ${MAX_SKILL_LOADS_PER_RUN} loads per run.`,
      ...lines,
    ].join("\n") + "\n\n---\n\n"
  );
}

export function synthesizeSkillLoadTool(): ResolvedTool {
  return {
    name: SKILL_LOAD_TOOL_NAME,
    description:
      "Load a platform skill playbook on demand by slug (see the 'Skill playbooks' list in your prompt). Returns the playbook text; follow it for the current task. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "The skill slug to load, e.g. 'copywriting'.",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    server_id: SKILL_SERVER_ID,
    tool_name: SKILL_LOAD_TOOL,
  };
}

const MAX_TRACKED_RUNS = 5_000;
const loadCounts = new Map<string, number>();
const loadedGroups = new Map<string, Map<string, string>>();

function bumpLoadCount(runId: string): number {
  const next = (loadCounts.get(runId) ?? 0) + 1;
  loadCounts.set(runId, next);
  if (loadCounts.size > MAX_TRACKED_RUNS) {
    const oldest = loadCounts.keys().next().value;
    if (oldest !== undefined) {
      loadCounts.delete(oldest);
      loadedGroups.delete(oldest);
    }
  }
  return next;
}

export function __resetSkillLoadCountsForTest(): void {
  loadCounts.clear();
  loadedGroups.clear();
}

export interface SkillLoadResult {
  content: string;
  is_error: boolean;
}

export async function handleSkillLoad(params: {
  run_id: string;
  tenant_id?: string;
  agent_slug?: string;
  input: unknown;
}): Promise<SkillLoadResult> {
  const { run_id, tenant_id, agent_slug } = params;

  const rawSlug =
    params.input && typeof params.input === "object"
      ? (params.input as Record<string, unknown>).slug
      : undefined;
  const slug = typeof rawSlug === "string" ? rawSlug : "";
  if (!SLUG_RE.test(slug) || !corpusMap.has(slug)) {
    return {
      is_error: true,
      content:
        "Unknown skill slug. Load only a slug listed in your 'Skill playbooks' index.",
    };
  }

  const entry = SKILL_REGISTRY.find((s) => s.slug === slug)!;
  if (
    typeof agent_slug !== "string" ||
    !entry.applies_to.includes(agent_slug)
  ) {
    return {
      is_error: true,
      content: `The '${slug}' playbook is not available to this agent.`,
    };
  }

  if (entry.exclusive_group) {
    if (!run_id) {
      return { is_error: true, content: "A run ID is required to isolate campaign specialist context." };
    }
    const selected = loadedGroups.get(run_id)?.get(entry.exclusive_group);
    if (selected && selected !== slug) {
      return {
        is_error: true,
        content: `This run already loaded '${selected}'. Keep this work item scoped; use a separate run for another campaign family.`,
      };
    }
  }

  const priorLoads = run_id ? (loadCounts.get(run_id) ?? 0) : 0;
  if (priorLoads >= MAX_SKILL_LOADS_PER_RUN) {
    return {
      is_error: true,
      content: `Skill-load cap reached (${MAX_SKILL_LOADS_PER_RUN} per run). Work with the playbooks you already loaded.`,
    };
  }

  const realpath = corpusMap.get(slug)!;
  if (!existsSync(realpath)) {
    console.error(`[skill-runtime] corpus file missing at ${realpath}`);
    return {
      is_error: true,
      content: "That playbook is temporarily unavailable.",
    };
  }
  let body: string;
  try {
    const raw = readFileSync(realpath, "utf-8");
    body = matter(raw).content.trim();
  } catch (e) {
    console.error(
      `[skill-runtime] failed to read/parse ${realpath}: ${(e as Error).message}`,
    );
    return {
      is_error: true,
      content: "That playbook could not be loaded.",
    };
  }
  if (entry.agent_section) {
    body = splitAgentSection(body, entry.agent_section)?.section ?? "";
  }
  if (body.length === 0) {
    return { is_error: true, content: "That playbook is empty." };
  }
  if (!entry.agent_section && Buffer.byteLength(body, "utf-8") > MAX_SKILL_BODY_BYTES) {
    body = body.slice(0, MAX_SKILL_BODY_BYTES) + "\n\n[playbook truncated]";
  }

  if (run_id) {
    bumpLoadCount(run_id);
    if (entry.exclusive_group) {
      const groups = loadedGroups.get(run_id) ?? new Map<string, string>();
      groups.set(entry.exclusive_group, slug);
      loadedGroups.set(run_id, groups);
    }
  }

  const contentHash = createHash("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 12);
  logEvent({
    level: "info",
    source: "agents.skill_runtime",
    code: "skill.load",
    tenant_id: tenant_id,
    run_id: run_id ?? null,
    meta: { slug, agent_slug, content_hash: contentHash },
  }).catch((err) => console.error("skill_load_log_failed", err));

  return { is_error: false, content: body };
}

function readSkillBodyBySlug(slug: string): string | null {
  const realpath = corpusMap.get(slug);
  if (!realpath || !existsSync(realpath)) {
    if (realpath) console.error(`[skill-runtime] corpus file missing at ${realpath}`);
    return null;
  }
  let body: string;
  try {
    body = matter(readFileSync(realpath, "utf-8")).content.trim();
  } catch (e) {
    console.error(
      `[skill-runtime] failed to read/parse ${realpath}: ${(e as Error).message}`,
    );
    return null;
  }
  if (body.length === 0) return null;
  if (Buffer.byteLength(body, "utf-8") > MAX_SKILL_BODY_BYTES) {
    body = body.slice(0, MAX_SKILL_BODY_BYTES) + "\n\n[playbook truncated]";
  }
  return body;
}

export interface AutoInjectResult {
  block: string;
  slugs: string[];
}

export function buildAutoInjectedSkillBlock(
  agentSlug: string,
  taskText: string,
  runId?: string,
): AutoInjectResult {
  const slugs = resolveSkills(agentSlug, taskText);
  if (slugs.length === 0) return { block: "", slugs: [] };
  const sections: string[] = [];
  const injected: string[] = [];
  for (const slug of slugs) {
    const body = readSkillBodyBySlug(slug);
    if (body === null) continue;
    sections.push(`## Skill playbook: ${slug}\n\n${body}`);
    injected.push(slug);
    if (runId) bumpLoadCount(runId);
  }
  if (sections.length === 0) return { block: "", slugs: [] };
  return {
    block: `---\n\nThe following expert playbook(s) match this task. Apply them for this task.\n\n${sections.join(
      "\n\n",
    )}\n\n---`,
    slugs: injected,
  };
}
