
export const SKILL_MAX_BODY_CHARS = 50_000;
export const SKILL_MAX_FILE_BYTES = 512 * 1024;
export const SKILL_MAX_TITLE_CHARS = 200;
export const SKILL_MAX_TAGS = 10;
export const SKILL_MAX_TAG_CHARS = 40;
export const SKILL_FILE_ACCEPT = ".md,.markdown,.txt,text/markdown,text/plain";

const ALLOWED_EXTENSIONS = [".md", ".markdown", ".txt"];

export type ParsedSkill = {
  title: string;
  body_markdown: string;
  tags: string[];
};

export type SkillFileParse = { ok: true; skill: ParsedSkill } | { ok: false; error: string };

export function checkSkillFile(file: { name: string; size: number }): string | null {
  const lower = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return "Upload a markdown file (.md, .markdown or .txt).";
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > SKILL_MAX_FILE_BYTES) {
    return `That file is larger than ${Math.round(SKILL_MAX_FILE_BYTES / 1024)}KB.`;
  }
  return null;
}

function titleFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  return stem.replace(/[-_]+/g, " ").trim();
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseFrontmatter(block: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && listKey) {
      const prev = out[listKey];
      const items = Array.isArray(prev) ? prev : [];
      items.push(stripQuotes(listItem[1]));
      out[listKey] = items;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (value === "") {
      listKey = key;
      out[key] = [];
      continue;
    }
    listKey = null;
    out[key] = stripQuotes(value);
  }
  return out;
}

function normalizeTags(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value)
    ? value
    : value
        .replace(/^\[|\]$/g, "")
        .split(",");
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    const tag = stripQuotes(String(item)).replace(/^#/, "").trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag.slice(0, SKILL_MAX_TAG_CHARS));
    if (tags.length === SKILL_MAX_TAGS) break;
  }
  return tags;
}

export function normalizeTagInput(value: string): string[] {
  return normalizeTags(value);
}

export function parseSkillFile(fileName: string, raw: string): SkillFileParse {
  const text = raw
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .replace(/^[ \t\n]*(?=---[ \t]*\n)/, "");

  let front: Record<string, string | string[]> = {};
  let body = text;
  const fm = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (fm) {
    front = parseFrontmatter(fm[1]);
    body = text.slice(fm[0].length);
  }

  const heading = body.match(/^\s*#{1,6}[ \t]+(.+?)\s*$/m);
  const rawTitle =
    (typeof front.name === "string" && front.name) ||
    (typeof front.title === "string" && front.title) ||
    heading?.[1] ||
    titleFromFileName(fileName);
  const title = rawTitle.trim().slice(0, SKILL_MAX_TITLE_CHARS);

  const description = typeof front.description === "string" ? front.description.trim() : "";
  body = body.trim();
  if (description && !body.includes(description)) {
    body = body ? `${description}\n\n${body}` : description;
  }

  if (!body) return { ok: false, error: "That file has no content below the frontmatter." };
  if (body.length > SKILL_MAX_BODY_CHARS) {
    return {
      ok: false,
      error: `That skill is ${body.length.toLocaleString()} characters. The limit is ${SKILL_MAX_BODY_CHARS.toLocaleString()}.`,
    };
  }

  return {
    ok: true,
    skill: { title, body_markdown: body, tags: normalizeTags(front.tags) },
  };
}
