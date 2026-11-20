
export type SuggestedPurpose = "support" | "dev" | "exec" | "general";

const PURPOSE_KEYWORDS: Array<{ purpose: SuggestedPurpose; words: string[] }> = [
  { purpose: "support", words: ["support", "help", "cx", "customer", "success", "helpdesk", "tickets"] },
  { purpose: "dev", words: ["eng", "engineering", "dev", "develop", "bug", "deploy", "infra", "platform", "backend", "frontend", "ops", "oncall", "incident"] },
  { purpose: "exec", words: ["exec", "leadership", "founders", "board", "strategy", "gtm"] },
];

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function inferSuggestedPurpose(
  team_name: string | null | undefined,
  channel_names: readonly string[] = [],
): SuggestedPurpose {
  const tokens = new Set<string>();
  for (const t of tokenize(team_name ?? "")) tokens.add(t);
  for (const ch of channel_names) {
    for (const t of tokenize(ch)) tokens.add(t);
  }
  if (tokens.size === 0) return "general";

  for (const { purpose, words } of PURPOSE_KEYWORDS) {
    if (words.some((w) => tokens.has(w))) return purpose;
  }
  return "general";
}
