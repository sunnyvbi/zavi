export const SKILL_MAX_TITLE_CHARS = 200;
const SKILL_MAX_TAGS = 10;
const SKILL_MAX_TAG_CHARS = 40;

export type Skill = {
  id: string;
  title: string;
  body_markdown: string;
  source?: string;
  tags: string[];
  created_at: string;
  updated_at: string;
};

export function previewOf(body: string): string {
  const text = body.replace(/\r\n/g, "\n").replace(/^[ \t\n]*/, "");
  return text
    .replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(\n|$)/, "")
    .split("\n")
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join("\n")
    .trim();
}

function stripQuotes(s: string): string {
  const t = s.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

export function normalizeTags(value: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value.replace(/^\[|\]$/g, "").split(",")) {
    const tag = stripQuotes(item).replace(/^#/, "").trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag.slice(0, SKILL_MAX_TAG_CHARS));
    if (tags.length === SKILL_MAX_TAGS) break;
  }
  return tags;
}

export function matchesSkill(skill: Skill, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    skill.title.toLowerCase().includes(q) ||
    skill.body_markdown.toLowerCase().includes(q) ||
    skill.tags.some((t) => t.toLowerCase().includes(q))
  );
}
