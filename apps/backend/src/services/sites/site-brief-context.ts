import { renderUntrustedBlock } from "@/services/agents/prompt-injection";
import { BRIEF_FONTS, BRIEF_LAYOUTS, isBriefLayout, parseBriefExtras, parseSitePlan } from "./design-brief";

const HEX = /^#[0-9a-fA-F]{6}$/;

function label(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.replace(/[\r\n\t`*_<>{}[\]\\"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() : "";
}

function sectionLabel(section: { name: string }): string {
  const s = section as { name: string; component?: unknown; variant?: unknown };
  const component = label(s.component, 20);
  const variant = label(s.variant, 20);
  const detail = [component, variant].filter(Boolean).join(" ");
  return detail ? `${section.name} [${detail}]` : section.name;
}

export const SITE_SCOPE_RULE =
  "Change only what the request asks for and keep everything outside it as it is. Only an explicit redesign request changes the layout or look; a theme or look switch changes colours and fonts only.";

export function siteBriefLines(raw: unknown): string[] {
  const b = raw as { mood?: unknown; fonts?: { heading?: unknown; body?: unknown }; colors?: Record<string, unknown>; plan?: unknown } | null;
  if (!b || typeof b !== "object") return [];
  const lines: string[] = [];
  const mood = label(b.mood, 80);
  if (mood) lines.push(`Look: ${mood}`);
  const heading = typeof b.fonts?.heading === "string" && BRIEF_FONTS[b.fonts.heading] ? b.fonts.heading : null;
  const body = typeof b.fonts?.body === "string" && BRIEF_FONTS[b.fonts.body] ? b.fonts.body : null;
  if (heading && body) lines.push(`Fonts: ${heading} headings, ${body} body`);
  const primary = typeof b.colors?.primary === "string" && HEX.test(b.colors.primary) ? b.colors.primary : null;
  const background = typeof b.colors?.background === "string" && HEX.test(b.colors.background) ? b.colors.background : null;
  if (primary && background) lines.push(`Colours: primary ${primary} on ${background} (the site's theme: src/theme.css is platform-owned, a site-wide change is an override in the :root block of src/index.css)`);
  const extras = parseBriefExtras(raw);
  const rawLayout = (b as { look?: { layout?: unknown } }).look?.layout;
  const layout = extras.look?.layout ?? (isBriefLayout(rawLayout) ? rawLayout : null);
  if (layout) lines.push(`Layout: ${layout} (${BRIEF_LAYOUTS[layout].split(/[,(]/)[0].trim()})`);
  const plan = parseSitePlan(b.plan);
  if (plan) {
    lines.push(`Tone: ${plan.tone}`);
    lines.push(`Main action: ${plan.primary_action.label}`);
    for (const page of plan.pages) lines.push(`Page ${page.path} (${page.title}): ${page.sections.map(sectionLabel).join(", ")}`);
  }
  if (extras.imagery) {
    const subjects = extras.imagery.subjects.slice(0, 3).map((x) => label(x, 60)).filter(Boolean);
    const style = label(extras.imagery.style, 80);
    if (subjects.length === 0) lines.push("Photos: none");
    else lines.push(`Photos: ${subjects.join("; ")}${style ? ` (${style})` : ""}`);
  }
  return lines;
}

export function siteBriefContext(raw: unknown): string {
  const lines = siteBriefLines(raw);
  if (lines.length === 0) return "";
  return `\n\n### The site's brand and plan (set when it was built; keep them unless the change asks otherwise)\n${SITE_SCOPE_RULE}\n${renderUntrustedBlock("site_brief", lines.join("\n"))}`;
}

export function designBriefFromGraph(graph: unknown): Record<string, unknown> | null {
  if (!Array.isArray(graph)) return null;
  for (const node of graph) {
    const brief = (node as { payload?: { design_brief?: unknown } } | null)?.payload?.design_brief;
    if (brief && typeof brief === "object" && !Array.isArray(brief)) return brief as Record<string, unknown>;
  }
  return null;
}
