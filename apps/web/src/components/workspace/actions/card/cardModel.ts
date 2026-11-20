import { actionText, deliverableOf, deliverableParts, effortLabel, type ActionItem } from "../types";

export const TITLE_MAX = 100;
export const LEAD_MAX = 170;
export const POINT_MAX = 96;

const LIST_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;
const DEFAULT_ABOUT = "Zavi wrote this from your saved channel plan. Nothing happens until you press the button.";

export type CardCopy = { title: string; fullTitle: string; lead: string | null; points: string[]; steps: string[]; about: string };

function plain(text: string): string {
  return text.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
}

export function clipText(text: string, max: number): string {
  const t = plain(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

function fallbackCopy(a: ActionItem): Omit<CardCopy, "about" | "fullTitle"> {
  const rows = (actionText(a) ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const prose = plain(rows.filter((l) => !LIST_RE.test(l)).join(" "));
  const first = prose.split(/(?<=[.!?])\s+/)[0] ?? "";
  return {
    title: plain(a.title),
    lead: first ? clipText(first, LEAD_MAX) : null,
    points: rows.filter((l) => LIST_RE.test(l)).slice(0, 3).map((l) => clipText(l.replace(LIST_RE, ""), POINT_MAX)),
    steps: (a.how_to ?? []).slice(0, 3).map((l) => clipText(l, POINT_MAX)),
  };
}

export const CODE_LINE = /^\s*(?:<\/?[a-z!][^>]*>|[{}[\]],?$|"[@\w-]+"\s*:|(?:User-agent|Disallow|Allow|Sitemap):|(?:RewriteRule|Redirect(?:Match)?|rewrite)\s)/i;

export function fenceCode(text: string): string {
  if (text.includes("```")) return text;
  const out: string[] = [];
  let block: string[] = [];
  const flush = () => {
    if (block.length) out.push("```html", ...block, "```", "");
    block = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (CODE_LINE.test(line)) block.push(line.trim());
    else if (line.trim()) {
      flush();
      out.push(line.trim(), "");
    }
  }
  flush();
  return out.join("\n").trim();
}

const POST_ACTIONS = new Set(["text_post", "image_post", "video_post", "reply"]);

export function explainsFirst(a: ActionItem): boolean {
  return a.channel_slug === "seo" && !POST_ACTIONS.has(a.action_type) && a.body?.step?.deliverable?.presentation?.type !== "topic_pick" && !!actionText(a)?.trim() && !!deliverableOf(a);
}

export function deliverableAbout(a: ActionItem): string {
  const parts = deliverableParts(a);
  if (parts) return parts.map((p) => `**${p.label}**\n\n${fenceCode(p.content)}`).join("\n\n");
  return fenceCode(deliverableOf(a)?.content ?? "");
}

export function cardCopyOf(a: ActionItem): CardCopy {
  const brief = a.brief ?? fallbackCopy(a);
  const fullTitle = plain(a.title ?? "") || brief.title;
  const title = clipText(fullTitle, TITLE_MAX);
  const sentence = typeof a.body?.change_sentence === "string" ? a.body.change_sentence.trim() : "";
  const full = actionText(a);
  if (explainsFirst(a)) {
    const about = [...new Set([a.impact_reason?.trim(), deliverableAbout(a)].filter((t): t is string => !!t && t !== full?.trim()))].join("\n\n") || DEFAULT_ABOUT;
    return { title, fullTitle, lead: full!.trim(), points: [], steps: brief.steps, about };
  }
  const about = [...new Set([a.impact_reason, full].map((t) => (t ? t.trim() : "")).filter((t) => t.length > 0 && t !== brief.lead))].join("\n\n") || DEFAULT_ABOUT;
  return { title, fullTitle, lead: sentence || brief.lead, points: brief.points, steps: brief.steps, about };
}

export function howItWorks(steps: string[], primary: string | null): string[] {
  if (steps.length) return steps;
  return ["Read it.", primary ? `Press ${primary}.` : "Do the step on this card.", "Zavi reports what happened here."];
}

export function effortMeta(a: ActionItem): string | null {
  const effort = effortLabel(a);
  if (!effort || a.executable || a.channel_slug === "linkedin_ads") return null;
  const owner = a.body?.owner ?? a.body?.step?.owner;
  if (owner === "developer") return `Your developer · ${effort}`;
  return owner === "founder" || (!owner && a.body?.step?.responsibility === "client") ? `You do it · ${effort}` : null;
}

export function isDoneCard(a: ActionItem): boolean {
  return a.status === "acted" || a.exec_status === "executed" || (a.exec_status === "failed" && a.status !== "pending");
}
