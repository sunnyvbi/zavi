
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import { THEME_EDIT_RULE } from "./design-directions";

export type SiteEditSize = "tweak" | "theme" | "section" | "page" | "data";
export type SiteEditLane = "fast" | "structural";
export type SiteEditRoute = { size: SiteEditSize; lane: SiteEditLane };

export const SITE_EDIT_SIZES: readonly SiteEditSize[] = ["tweak", "theme", "section", "page", "data"];

const THEME_SIGNAL = new RegExp(
  [
    `\\b(?:theme|palette|colou?r scheme|brand colou?rs?|dark mode|light mode|dark theme|light theme)\\b`,
    `\\b(?:colou?rs?|fonts?|typography|look)\\b[^.?!]{0,40}\\b(?:site|website|everywhere|whole|entire|overall|across|all pages|every page)\\b`,
    `\\b(?:site|website|whole|entire|overall|all pages|every page)\\b[^.?!]{0,40}\\b(?:colou?rs?|fonts?|typography|darker|lighter|dark|light)\\b`,
  ].join("|"),
  "i",
);

export function isSiteEditSize(v: unknown): v is SiteEditSize {
  return typeof v === "string" && (SITE_EDIT_SIZES as readonly string[]).includes(v);
}

const ADD_VERB = "(?:add|adding|insert|create|build|include|introduce|need|want|give (?:me|us|it))";

const PAGE_SIGNAL = new RegExp(
  [
    `\\b(?:new|another|separate|extra|second|own|dedicated)\\s+(?:page|pages|screen|screens|route)\\b`,
    `\\b${ADD_VERB}\\b[^.?!]{0,40}\\b(?:a|an)\\s+(?:[\\w'-]+\\s+){0,3}(?:page|screen)\\b`,
    `\\b${ADD_VERB}\\b[^.?!]{0,40}\\b(?:pages|screens|routes)\\b`,
    `\\b(?:page|screen)\\s+(?:for|called|named|that lists|where)\\b`,
    `\\b(?:remove|delete|drop|get rid of)\\b[^.?!]{0,40}\\b(?:page|pages|screen)\\b(?!\\s+(?:title|heading|headline|text|background|colou?r|font))`,
  ].join("|"),
  "i",
);

const DATA_STRONG =
  /\b(?:form|forms|field|fields|collection|collections|database|checkout|cart|upload|uploads|inventory|newsletter|waitlist|wait list|sign-?up form|subscribe form|quantity|quantities)\b|\b(?:save|store|collect|record|track)\s+(?:the|a|an|their|each|every|visitors?|customers?|clients?|users?|people|guests?)\b/i;
const DATA_WEAK =
  /\b(?:sign ?up|signups|subscribe|booking|bookings|book|reservation|reservations|appointment|appointments|order|orders|payment|payments|pay|login|log in|account|accounts|admin|dashboard|search|filter|filters|rating|ratings|review form|comment|comments|stock)\b/i;
const ENABLE =
  /\b(?:add|adds|adding|insert|create|build|include|introduce|allow|enable|support|need|want)\b|\blet\s+(?:visitors|customers|people|users|clients|guests|them)\b|\b(?:let|allow)\s+(?:[a-z]+\s+){1,2}(?:book|order|sign|pay|upload|leave|submit|reserve|buy|register|join|log|rate|review|request)\b|\b(?:save|store|collect|track|record)\b/i;

const SECTION_SIGNAL = new RegExp(
  [
    `\\b(?:add|adds|adding|insert|create|build|include|introduce|remove|removes|removing|delete|deletes|drop|reorder|rearrange|restructure|redesign|rebuild|relayout|split|merge|duplicate)\\b`,
    `\\b(?:section|sections|block|blocks|testimonials?|gallery|faq|carousel|slider|map|video|grid|columns?|layout|theme|dark mode|light mode|navbar|nav bar|menu|sidebar|footer|header|hero|banner|popup|modal|tabs|accordion|timeline|team|pricing|cards?|logos?|partners|stats|counter|countdown|animation|animations)\\b`,
    `\\b(?:whole|entire|every|all)\\s+(?:site|website|page|pages)\\b`,
    `\\b(?:move|swap)\\b[^.?!]{0,40}\\b(?:above|below|before|after|under|over|to the (?:top|bottom|left|right))\\b`,
  ].join("|"),
  "i",
);

const STRUCT_TARGET =
  /\b(?:sections?|blocks?|forms?|fields?|gallery|galleries|testimonials?|faq|carousel|slider|map|video|videos|animation|animations|grid|layout|columns?|rows?|accordion|tabs|timeline|popup|modal|countdown|counter|cards?|list|table|menu|banner|badge|buttons?|images|photos|pictures)\b/i;

const TWEAK_VERB =
  /\b(?:change|changes|update|edit|replace|rename|reword|rewrite|fix|correct|make|set|use|turn|swap|switch|shorten|lengthen|tweak|adjust|bold|italici[sz]e|underline|capitali[sz]e|lowercase|uppercase|increase|decrease|enlarge|shrink|center|centre|align|recolou?r)\b/i;
const TWEAK_NOUN =
  /\b(?:text|copy|wording|words|headline|heading|title|subtitle|tagline|slogan|label|caption|button|cta|link|url|phone(?: number)?|email address|address|hours|opening hours|price|prices|name|typo|spelling|colou?r|colou?rs|font|fonts|size|bold|background|logo|image|photo|picture|icon|spacing|padding|margin|border|corners?|shadow)\b/i;
const QUOTED = /["“'‘][^"”'’]{1,200}["”'’]/;

function asksForSeveralThings(s: string): boolean {
  const clauses = s.split(/(?:[.;!?\n]+|\b(?:and then|also|plus|as well as)\b)/i).filter((c) => c.trim().length > 3);
  return clauses.length > 3;
}

export function isSiteRepairRequest(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const s = decodeXmlEntities(text).slice(0, 4000);
  return /\bfix (?:this|these) (?:\d+ )?errors? in the preview\b/i.test(s) ||
    /\b(?:failed to resolve import|cannot find module|module not found|uncaught (?:typeerror|referenceerror)|build error|runtime error)\b/i.test(s.replace(new RegExp(QUOTED.source, "g"), " "));
}

export function classifySiteEdit(text: string | null | undefined): SiteEditRoute {
  const s = decodeXmlEntities(String(text ?? "")).slice(0, 4000).trim();
  if (!s || isSiteRepairRequest(s)) return { size: "section", lane: "structural" };
  const unquoted = s.replace(new RegExp(QUOTED.source, "g"), " ");
  if (PAGE_SIGNAL.test(unquoted)) return { size: "page", lane: "structural" };
  const localScope = /\b(?:this|that|the|one|its)\s+(?:section|hero|header|footer|card|cards|banner|block|button|form|page)\b/i.test(unquoted) &&
    !/\b(?:whole|entire|every|all|everywhere|across)\b/i.test(unquoted);
  if (THEME_SIGNAL.test(unquoted) && !localScope && !/\b(?:add|insert|create|remove|delete)\b/i.test(unquoted)) {
    return { size: "theme", lane: "structural" };
  }
  if (DATA_STRONG.test(unquoted) || (DATA_WEAK.test(unquoted) && ENABLE.test(unquoted))) {
    return { size: "data", lane: "structural" };
  }
  if (SECTION_SIGNAL.test(unquoted)) {
    const elementEdit =
      TWEAK_VERB.test(unquoted) &&
      TWEAK_NOUN.test(unquoted) &&
      !STRUCT_TARGET.test(unquoted.replace(/\b(?:hero|header|footer|nav|navbar|menu|banner)\b/gi, " ")) &&
      !/\b(?:add|insert|create|remove|delete|drop|reorder|rearrange|restructure|redesign|rebuild|relayout|duplicate|split|merge|whole|entire|every|all)\b/i.test(unquoted);
    if (!elementEdit) return { size: "section", lane: "structural" };
  }
  if (s.length > 600 || asksForSeveralThings(s)) return { size: "section", lane: "structural" };
  if (TWEAK_VERB.test(unquoted) && (TWEAK_NOUN.test(unquoted) || QUOTED.test(s))) return { size: "tweak", lane: "fast" };
  return { size: "section", lane: "structural" };
}

export function structuralEditGuidance(size: unknown): string {
  switch (size) {
    case "page":
      return "\n\n### This change adds or removes a page\nLook at how the site declares its pages first and follow it: a new page is usually a new file under `src/pages/` with its route registered where the others are, linked from the site's navigation (header and, on a phone, the menu) so a visitor can reach it. Removing a page removes its route and every link to it. Keep every other route working.";
    case "section":
      return "\n\n### This change adds, removes or rearranges part of a page\nA new section of more than a few lines usually goes in its own component where the site keeps its others (`src/components/` when it has no other place), placed on the page the founder named (the home page when none is named), styled like the sections around it. Make it a finished section, not a stub: with no real content to use, write three believable examples written for this business and marked as samples the owner replaces (never a single placeholder card or a note to fill it in later). Keep the rest of the page as it is.";
    case "theme":
      return "\n\n### This change is the look of the whole site\n" + THEME_EDIT_RULE + " Keep each section's own layout.";
    case "data":
      return "\n\n### This change touches what the site stores or asks visitors for\nFollow rule 3: data changes are additive, so a field taken off a form stays in the data. A new thing a visitor can do gets a smoke journey in `zavi-site.json` with `data-zavi-*` attributes on the elements it uses.";
    default:
      return "";
  }
}

export const STRUCTURAL_EDIT_ESTIMATE_USD = 3.0;

type EditPayload = Record<string, unknown> & {
  fast_edit?: unknown;
  small_edit?: unknown;
  edit_size?: unknown;
  edit_routed?: unknown;
  escalated_from_fast?: unknown;
  resume_epoch?: unknown;
};

export const ROUTE_MISS_LEAD = "This needs a bigger change";

export const FAST_EDIT_ROUTE_MISS_RULE = `\n\nIf this needs more than editing files that exist (a new file, page, section or field), or you cannot find the code, change nothing and reply \`<pr_proposal>{"refused": true, "reason_code": "blocked", "customer_summary": "${ROUTE_MISS_LEAD}: <what it needs>", "rendered_markdown": "<what you checked>"}</pr_proposal>\`: Zavi then runs the full change pass.`;

export function isFastPassRouteMiss(row: { parsed?: unknown; outcome?: unknown } | null | undefined): boolean {
  const parsed = row?.parsed && typeof row.parsed === "object" && !Array.isArray(row.parsed)
    ? (row.parsed as { refused?: unknown; customer_summary?: unknown; commit_sha?: unknown; pr_url?: unknown })
    : null;
  if (!parsed || parsed.refused !== true) return false;
  if ((typeof parsed.commit_sha === "string" && parsed.commit_sha) || (typeof parsed.pr_url === "string" && parsed.pr_url)) return false;
  const summary = typeof parsed.customer_summary === "string" ? parsed.customer_summary.trim().toLowerCase() : "";
  return summary.startsWith(ROUTE_MISS_LEAD.toLowerCase());
}

export function escalateFastEdit(payload: EditPayload): boolean {
  if (payload.fast_edit !== true || payload.escalated_from_fast === true) return false;
  delete payload.fast_edit;
  delete payload.small_edit;
  payload.escalated_from_fast = true;
  if (payload.edit_size === "tweak" || !isSiteEditSize(payload.edit_size)) payload.edit_size = "section";
  const epoch = typeof payload.resume_epoch === "number" && Number.isInteger(payload.resume_epoch) ? payload.resume_epoch : 0;
  payload.resume_epoch = epoch + 1;
  delete payload.push_check_started_at;
  delete payload.deploy_enqueued_at;
  delete payload.refine_deploy_enqueued_at;
  return true;
}

export function isStructuralElementAsk(message: string | null | undefined): boolean {
  const s = decodeXmlEntities(String(message ?? "")).slice(0, 2000).trim();
  if (!s) return false;
  const unquoted = s.replace(new RegExp(QUOTED.source, "g"), " ");
  if (PAGE_SIGNAL.test(unquoted)) return true;
  if (/\b(?:add|adds|adding|insert|create|build|include|introduce|duplicate|split)\b/i.test(unquoted) && (STRUCT_TARGET.test(unquoted) || /\b(?:photo|image|picture|icon|logo|quote|review|subtitle|subheading|heading|headline|paragraph|sentence|line|caption|tagline|label)\b/i.test(unquoted))) return true;
  if (/\b(?:another|new|second|extra|more)\s+(?:link|links|heading|paragraph|line)\b/i.test(unquoted)) return true;
  if (/\b(?:above|below|before|after|under|beneath|next to|beside)\b[^.?!]{0,30}\b(?:this|it|here)\b/i.test(unquoted)) return true;
  return STRUCT_TARGET.test(unquoted) && /\b(?:new|another|more|extra|second)\b/i.test(unquoted);
}

const MAX_ELEMENT_TEXT = 160;

const PAGE_PATH = /^\/[A-Za-z0-9._~%/-]{0,200}$/;

export function safePagePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.split(/[?#]/)[0].trim();
  return PAGE_PATH.test(path) && !path.includes("//") ? path : null;
}

export function elementScopedRequest(input: { selector: string; text?: string | null; message: string; path?: unknown }): string {
  const text = (input.text ?? "").replace(/\s+/g, " ").trim();
  const shown = text.length > MAX_ELEMENT_TEXT ? `${text.slice(0, MAX_ELEMENT_TEXT - 1)}…` : text;
  const where = shown ? `the element \`${input.selector}\` (it reads ${JSON.stringify(shown)})` : `the element \`${input.selector}\``;
  const path = safePagePath(input.path);
  const page = path ? `On the page \`${path}\`` : "On the page I'm looking at";
  return `${page}, at ${where}: ${input.message.trim()}`;
}
