
const ARTICLES = new Set(["the", "a", "an"]);

const LEADING_NOISE = new Set([
  ...ARTICLES,
  "please",
  "pls",
  "can",
  "you",
  "could",
  "would",
  "hey",
  "hi",
  "i",
  "want",
  "need",
  "we",
  "let",
  "lets",
  "to",
  "for",
]);

const TRAILING_NOISE = new Set([
  "to",
  "for",
  "and",
  "or",
  "but",
  "of",
  "on",
  "in",
  "at",
  "by",
  "with",
  "from",
  "that",
  "when",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "be",
  "not",
  "no",
  "so",
  "if",
  "it",
  "its",
  "this",
  "into",
  "across",
  "over",
  "up",
  "as",
]);

const MAX_SLUG_LEN = 48;
const MAX_SLUG_WORDS = 7;

export function slugifyTask(text: string): string {
  if (typeof text !== "string") return "";

  const words = text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !ARTICLES.has(w));

  let start = 0;
  while (start < words.length && LEADING_NOISE.has(words[start])) start += 1;
  const meaningful = words.slice(start);

  if (meaningful.length === 0) return "";

  const capped = meaningful.slice(0, MAX_SLUG_WORDS);
  let slug = capped.join("-");

  if (slug.length > MAX_SLUG_LEN) {
    const cut = slug.slice(0, MAX_SLUG_LEN);
    const lastDash = cut.lastIndexOf("-");
    slug = (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
  }

  const kept = slug.split("-");
  while (kept.length > 1 && TRAILING_NOISE.has(kept[kept.length - 1])) {
    kept.pop();
  }
  return kept.join("-");
}

export function buildEngineerBranch(
  runId: string,
  sources: Array<string | undefined | null>,
  prefix: "engineer" | "product-builder" = "engineer",
): string {
  const runToken =
    String(runId ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 8) || "run";

  for (const source of sources) {
    const slug = slugifyTask(source ?? "");
    if (slug) return `${prefix}/${slug}-${runToken}`;
  }
  return `${prefix}/${runToken}`;
}

export function resolveHeadBranch(input: {
  agentSlug: string;
  runId: string;
  emitted: unknown;
  isProductBuildCodegen: boolean;
  followupCheckoutRef: string;
  slugSources: Array<string | undefined | null>;
  priorBranch: string | null;
}): string | undefined {
  if (input.followupCheckoutRef) return input.followupCheckoutRef;

  const emitted =
    typeof input.emitted === "string" && input.emitted.trim().length > 0
      ? input.emitted.trim()
      : "";

  if (!emitted) {
    if (input.isProductBuildCodegen) {
      const safeRunId = String(input.runId)
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .slice(0, 100);
      return `product-builder/${safeRunId}`;
    }
    if (input.agentSlug !== "engineer") return undefined;
    return (
      input.priorBranch ??
      buildEngineerBranch(input.runId, input.slugSources, "engineer")
    );
  }

  const interpolated = emitted.replace(/\{run_id\}/g, input.runId);

  if (input.agentSlug === "engineer" && interpolated.startsWith("engineer/")) {
    return (
      input.priorBranch ??
      buildEngineerBranch(input.runId, input.slugSources, "engineer")
    );
  }

  return interpolated;
}
