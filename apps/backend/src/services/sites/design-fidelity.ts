
import type { SiteGatePageText } from "./contract";
import type { DesignBrief } from "./design-brief";

export function planSectionId(name: string, taken: Set<string> = new Set()): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/g, "") || "section";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

export function planSectionIds(sections: ReadonlyArray<{ name: string }>): string[] {
  const taken = new Set<string>();
  return sections.map((s) => planSectionId(s.name, taken));
}

export type FidelityItemKind = "name" | "section" | "page" | "action" | "fact" | "journey";

export const JOURNEY_FIX_MARK = "zavi:brief-journey";

const EMPTY_STATE = [
  /^(?:there are )?no (?:available |open |upcoming )?(?:classes|class times|times|time slots|slots|appointments|bookings|sessions|dates|services|tours|rooms|tables|events|products|items|menu items|courses|openings) (?:are |is )?(?:yet|available|scheduled|listed|added|right now|at the moment)(?: yet| right now| at the moment)?[.!]?$/i,
  /^nothing (?:to book|available|scheduled|on the schedule|for sale)(?: yet| right now)?[.!]?$/i,
  /^(?:the owner |we )?(?:has|have) not added any (?:classes|times|slots|services|products|items|events|dates) yet[.!]?$/i,
];

export const PRIVATE_PATH = /^\/(?:admin|account|login|auth|dashboard|my-|profile)/i;

export function emptyStateLine(pages: readonly SiteGatePageText[]): { path: string; line: string } | null {
  for (const page of pages) {
    if (PRIVATE_PATH.test(page.path)) continue;
    for (const raw of page.text.split("\n")) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (line && line.length <= 80 && EMPTY_STATE.some((re) => re.test(line))) return { path: page.path, line };
    }
  }
  return null;
}

export type FidelityItem = {
  kind: FidelityItemKind;
  label: string;
  found: boolean;
  evidence?: string;
  required: boolean;
};

export type FidelityResult = {
  checked_at: string;
  items: FidelityItem[];
  found: number;
  total: number;
  gross: boolean;
};

const STOP = new Set([
  "the", "and", "for", "with", "your", "you", "our", "are", "from", "that", "this", "what", "when", "how", "who", "why",
  "into", "about", "more", "most", "best", "just", "here", "there", "them", "they", "will", "can", "all", "any", "get",
  "make", "made", "every", "each", "page", "section", "home",
]);

function norm(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function contentWords(text: string): string[] {
  return [...new Set(norm(text).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)))];
}

function stem(w: string): string {
  return w.length > 4 ? w.replace(/(ing|ies|es|s|ed)$/, "") : w;
}

export function mentions(haystack: string, phrase: string, minShare = 0.6): boolean {
  const p = norm(phrase);
  if (!p) return false;
  const padded = ` ${haystack} `;
  if (padded.includes(` ${p} `)) return true;
  const words = contentWords(phrase);
  if (words.length === 0) return false;
  const have = new Set(haystack.split(" ").map(stem));
  const hits = words.filter((w) => have.has(stem(w))).length;
  return hits >= Math.max(1, Math.ceil(words.length * minShare));
}

export function checkFidelity(input: {
  brief: DesignBrief;
  siteName: string | null;
  pages: readonly SiteGatePageText[];
  now?: () => Date;
}): FidelityResult | null {
  const home = input.pages.find((p) => p.path === "/");
  if (!home) return null;
  const homeText = norm(home.text);
  const allText = norm(input.pages.map((p) => p.text).join("\n"));
  const items: FidelityItem[] = [];
  const name = (input.siteName ?? "").trim();
  if (name) items.push({ kind: "name", label: name, found: mentions(homeText, name, 1), required: true });
  const plan = input.brief.plan;
  const modelPlan = input.brief.source !== "fallback" && !!plan;
  if (plan) {
    const homePage = plan.pages.find((p) => p.path === "/");
    const sections = homePage?.sections ?? [];
    const marked = new Set(home.sections ?? []);
    planSectionIds(sections).forEach((id, i) => {
      const sec = sections[i]!;
      const found = marked.has(id) || mentions(homeText, sec.headline) || mentions(homeText, sec.name, 1);
      items.push({ kind: "section", label: sec.name, found, required: modelPlan });
    });
    for (const page of plan.pages.filter((p) => p.path !== "/")) {
      const found = input.pages.some((p) => p.path === page.path) || mentions(allText, page.title, 1);
      items.push({ kind: "page", label: page.title, found, required: false });
    }
    items.push({ kind: "action", label: plan.primary_action.label, found: mentions(allText, plan.primary_action.label), required: false });
  }
  for (const fact of input.brief.facts ?? []) {
    items.push({ kind: "fact", label: fact, found: mentions(allText, fact, 0.5), required: false });
  }
  const dead = emptyStateLine(input.pages);
  items.push({
    kind: "journey",
    label: `${plan?.primary_action.label ?? "The main action"} works before anything is added`,
    found: dead === null,
    required: true,
    ...(dead ? { evidence: `${dead.path}: "${dead.line}"` } : {}),
  });
  const sections = items.filter((i) => i.kind === "section" && i.required);
  const sectionsFound = sections.filter((i) => i.found).length;
  const nameMissing = items.some((i) => i.kind === "name" && !i.found);
  const gross = nameMissing || (sections.length >= 2 && sectionsFound < Math.ceil(sections.length / 2));
  return {
    checked_at: (input.now ?? (() => new Date()))().toISOString(),
    items,
    found: items.filter((i) => i.found).length,
    total: items.length,
    gross,
  };
}

const SIGNAL_MAX_ITEMS = 10;

export const JOURNEY_RULE =
  "the main action must work on the live site the moment it publishes, before the owner adds anything: offer real choices from the idea (its services, classes or products, and open times worked out from its hours), never an empty list or a \"check back soon\".";

export function journeyDeadEnd(result: FidelityResult | null): FidelityItem | null {
  return result?.items.find((i) => i.kind === "journey" && !i.found) ?? null;
}

export function journeyRepairSignal(item: FidelityItem): string {
  return `The site check opened the published site with no records in it and the main action dead-ends: ${item.evidence ?? "it lists nothing to pick"}.\nFix it so ${JOURNEY_RULE} Keep every smoke journey and data rule as it is.`;
}

export function fidelityAddendum(result: FidelityResult | null): string {
  if (!result) return "";
  const missing = result.items.filter((i) => !i.found && (i.required || i.kind === "action")).slice(0, SIGNAL_MAX_ITEMS);
  if (missing.length === 0) return "";
  const lines = missing.map((i) =>
    i.kind === "name"
      ? `- the business name "${i.label}" (header, hero and footer)`
      : i.kind === "section"
        ? `- the "${i.label}" section from the site plan`
        : i.kind === "journey"
          ? `- ${JOURNEY_RULE} It shows ${i.evidence ?? "an empty list"}.`
          : `- the main action "${i.label}"`,
  );
  return `\nWhile you fix that, the home page is also missing parts of the site plan; add them with real copy:\n${lines.join("\n")}`;
}
