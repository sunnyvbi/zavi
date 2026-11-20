
export type JargonClass =
  | "repo_hint"
  | "envelope"
  | "sandbox"
  | "uuid"
  | "file_path"
  | "tool_name"
  | "ticket_key"
  | "git_command"
  | "build_repo";

const URL_RE = /\bhttps?:\/\/\S+/gi;

const CODE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|json|ya?ml|toml|sql|md|sh|css|scss|lock|env|prisma";

const RULES: ReadonlyArray<{ cls: JargonClass; re: RegExp }> = [
  { cls: "repo_hint", re: /\brepo_hint\b/i },
  { cls: "envelope", re: /\benvelopes?\b/i },
  { cls: "sandbox", re: /\bsandbox(?:es)?\b/i },
  {
    cls: "uuid",
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  },
  {
    cls: "file_path",
    re: new RegExp(`(?:^|[\\s\`'"(\\[])\\.?(?:[\\w.@-]+/)+[\\w.-]+\\.(?:${CODE_EXT})\\b`, "i"),
  },
  { cls: "tool_name", re: /\b(?:mcp|praxis)__/i },
  { cls: "ticket_key", re: /\bSCRUM-\d+\b/ },
  { cls: "git_command", re: /\bgit\s+(?:remote|push|diff)\b/i },
  { cls: "build_repo", re: /\bPraxis-build\//i },
];

export function findInternalJargon(text: string | null | undefined): JargonClass[] {
  if (typeof text !== "string" || text.trim().length === 0) return [];
  const scan = text.replace(URL_RE, " ");
  const hits: JargonClass[] = [];
  for (const { cls, re } of RULES) {
    if (re.test(scan)) hits.push(cls);
  }
  return hits;
}

export function hasInternalJargon(text: string | null | undefined): boolean {
  return findInternalJargon(text).length > 0;
}

const BUILD_REPO_REF_RE =
  /\]\([^)\s]*\)|\bhttps?:\/\/\S+|`?\bPraxis-build\/[A-Za-z0-9._-]+`?/gi;

export function replaceBuildRepoRefs(text: string, replacement: string): string {
  if (!text || !/praxis-build\//i.test(text)) return text;
  return text.replace(BUILD_REPO_REF_RE, (m: string, offset: number, whole: string) => {
    if (m.startsWith("](") || /^https?:/i.test(m)) return m;
    const before = whole.slice(0, offset);
    const sentenceStart = /(?:^|\n|[.!?]\s+)(?:[-*>#]+\s*|\d+[.)]\s*)?$/.test(before);
    return sentenceStart ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
  });
}

