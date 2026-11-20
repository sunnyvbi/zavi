
export const BRAIN_SLOT_SLUGS = [
  "company",
  "ops",
  "policies",
  "disputes",
  "support",
  "product",
  "gtm_growth",
  "engineering",
  "team_roles",
  "metrics_north_star",
] as const;

export type BrainSlotSlug = (typeof BRAIN_SLOT_SLUGS)[number];

export const HUMAN_ONLY_GAP_SLUGS = [
  "disputes",
  "gtm_growth",
  "metrics_north_star",
] as const;

export const NEW_BRAIN_SLUGS = [
  "product",
  "gtm_growth",
  "engineering",
  "team_roles",
  "metrics_north_star",
] as const;

export type NewBrainSlug = (typeof NEW_BRAIN_SLUGS)[number];

export type SlotStatus = "missing" | "thin" | "filled";

export const BRAIN_SLOT_TITLES: Record<BrainSlotSlug, string> = {
  company: "Company",
  ops: "Operating priorities",
  policies: "Policies",
  disputes: "Disputes",
  support: "Support",
  product: "Product",
  gtm_growth: "Go-to-market & growth",
  engineering: "Engineering",
  team_roles: "Team & roles",
  metrics_north_star: "Metrics & north star",
};

const BRAIN_SLOT_TOPICS: Record<NewBrainSlug, string> = {
  product: "product — what you sell and how it works",
  gtm_growth: "go-to-market and growth — channels, funnel, what moves the needle",
  engineering: "engineering — stack, repos, how the product is built",
  team_roles: "team and roles — who does what",
  metrics_north_star: "metrics — your north-star number and how you measure it",
};

export function scoreSlot(
  body: string | null | undefined,
  metadata?: Record<string, unknown>,
): SlotStatus {
  if (body == null || body.trim().length === 0) return "missing";
  if (metadata?.seed_kind === "thin_placeholder") return "thin";
  const withoutHeadings = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
  if (withoutHeadings.length < 200) return "thin";
  return "filled";
}

export function sanitizeGapAnswer(text: string): string {
  let s = String(text ?? "");
  s = s.replace(
    /<(system|assistant|user|tool)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi,
    "",
  );
  s = s.replace(/<\/?\s*(system|assistant|user|tool)\s*\/?>/gi, "");
  s = s.replace(/<\/?\s*untrusted[_a-z0-9-]*\s*\/?>/gi, "");
  s = s.replace(/<\|[^|]*\|>/g, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s
    .split("\n")
    .filter((line) => !/^\s*(system|assistant|user|tool)\s*:/i.test(line))
    .join("\n");
  return s.trim();
}

export function thinPlaceholderBody(slug: NewBrainSlug): string {
  const title = BRAIN_SLOT_TITLES[slug];
  const topic = BRAIN_SLOT_TOPICS[slug];
  return `# ${title}\n\n_(Set this up — tell your agents about your ${topic}.)_`;
}

export function slugsToSeed(
  existing: Partial<Record<string, SlotStatus>>,
): NewBrainSlug[] {
  return NEW_BRAIN_SLUGS.filter((slug) => existing[slug] !== "filled");
}
