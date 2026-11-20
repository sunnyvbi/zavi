import { hasInternalJargon } from "@/services/agents/internal-jargon";

export const NEUTRAL_EDIT_LINE = "Updated your site";

type ChangedFile = { path?: unknown; action?: unknown };
type Verb = "Added" | "Removed" | "Updated";

const MAX_FILES = 200;
const MAX_ITEMS = 3;
const PAGE_NAME_RE = /^[a-z][a-z0-9 ]{0,29}$/;
const HOME_NAMES = new Set(["index", "home", "landing", "homepage"]);
const APP_PAGE_RE = /(?:^|\/)app\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js|mdx)$/i;
const PAGES_DIR_RE = /(?:^|\/)pages\/(.+)\.(?:tsx|jsx|ts|js|mdx)$/i;
const HTML_PAGE_RE = /(?:^|\/)([^/]+)\.html?$/i;
const STYLE_RE = /\.(?:css|scss|sass|less)$|(?:^|\/)(?:tailwind\.config|theme)\.[a-z]+$/i;
const FONT_RE = /\.(?:woff2?|ttf|otf)$/i;
const PICTURE_RE = /\.(?:png|jpe?g|gif|svg|webp|avif|ico)$/i;
const BEHIND_RE = /(?:^|\/)(?:api|server|supabase|migrations|functions|db)\/|\.sql$/i;
const COMPONENT_RE = /\.(?:tsx|jsx|vue|svelte|astro)$/i;

const SECTIONS: ReadonlyArray<[ReadonlySet<string>, string]> = [
  [new Set(["header", "topbar"]), "your header"],
  [new Set(["footer"]), "your footer"],
  [new Set(["nav", "navbar", "navigation", "menu"]), "your menu"],
  [new Set(["hero", "banner"]), "your main banner"],
  [new Set(["pricing", "prices", "plans"]), "your pricing section"],
  [new Set(["contact"]), "your contact section"],
  [new Set(["about"]), "your about section"],
  [new Set(["faq", "faqs"]), "your questions section"],
  [new Set(["testimonial", "testimonials", "review", "reviews"]), "your reviews section"],
  [new Set(["feature", "features"]), "your features section"],
  [new Set(["gallery"]), "your gallery"],
  [new Set(["service", "services"]), "your services section"],
  [new Set(["team"]), "your team section"],
  [new Set(["booking", "bookings"]), "your booking section"],
];

function words(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

function pageName(segment: string | undefined): string | null {
  if (segment === undefined) return "home";
  if (/^\(.*\)$|\[|^@/.test(segment)) return null;
  const name = words(segment).join(" ");
  if (HOME_NAMES.has(name)) return "home";
  return PAGE_NAME_RE.test(name) ? name : null;
}

function pageOf(path: string): string | null | undefined {
  const app = APP_PAGE_RE.exec(path);
  if (app) {
    const segs = (app[1] ?? "").split("/").filter((s) => s.length > 0 && !/^\(.*\)$/.test(s));
    return pageName(segs[segs.length - 1]);
  }
  const pages = PAGES_DIR_RE.exec(path);
  if (pages) {
    const segs = pages[1].split("/").filter(Boolean);
    if (segs[0]?.toLowerCase() === "api") return undefined;
    if (segs.some((s) => s.startsWith("_"))) return undefined;
    const last = segs[segs.length - 1];
    if (last && HOME_NAMES.has(last.toLowerCase()) && segs.length > 1) return pageName(segs[segs.length - 2]);
    return pageName(last);
  }
  const html = HTML_PAGE_RE.exec(path);
  if (html) return pageName(html[1]);
  return undefined;
}

function sectionOf(path: string): string | null {
  if (!COMPONENT_RE.test(path)) return null;
  const base = path.split("/").pop() ?? "";
  for (const w of words(base.replace(COMPONENT_RE, ""))) {
    for (const [names, phrase] of SECTIONS) {
      if (names.has(w)) return phrase;
    }
  }
  return null;
}

function verbOf(action: unknown): Verb {
  if (action === "create") return "Added";
  if (action === "delete") return "Removed";
  return "Updated";
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function plainEditLine(files: ReadonlyArray<ChangedFile> | null | undefined): string {
  const pages = new Map<string, Verb>();
  const others: string[] = [];
  const addOther = (phrase: string) => {
    if (!others.includes(phrase)) others.push(phrase);
  };
  for (const f of (files ?? []).slice(0, MAX_FILES)) {
    const path = typeof f?.path === "string" ? f.path.trim() : "";
    if (!path) continue;
    if (STYLE_RE.test(path) || FONT_RE.test(path)) {
      addOther("your site's look");
      continue;
    }
    if (PICTURE_RE.test(path)) {
      addOther("your site's pictures");
      continue;
    }
    if (BEHIND_RE.test(path)) {
      addOther("how your site works behind the scenes");
      continue;
    }
    const page = pageOf(path);
    if (page) {
      const verb = verbOf(f.action);
      const seen = pages.get(page);
      pages.set(page, seen === undefined || seen === verb ? verb : "Updated");
      continue;
    }
    const section = sectionOf(path);
    if (section) addOther(section);
  }
  const phrases: Array<{ verb: Verb; text: string }> = [];
  for (const [name, verb] of pages) {
    const text = verb === "Added" ? `a new ${name} page` : `your ${name} page`;
    phrases.push({ verb, text });
  }
  for (const text of others) phrases.push({ verb: "Updated", text });
  if (phrases.length === 0) return NEUTRAL_EDIT_LINE;
  const shown = phrases.slice(0, MAX_ITEMS);
  const clauses: string[] = [];
  for (const verb of ["Added", "Removed", "Updated"] as const) {
    const items = shown.filter((p) => p.verb === verb).map((p) => p.text);
    if (items.length === 0) continue;
    const lead = clauses.length === 0 ? verb : verb.toLowerCase();
    clauses.push(`${lead} ${list(items)}`);
  }
  const more = phrases.length > MAX_ITEMS ? ", and more" : "";
  const line = `${list(clauses)}${more}`;
  return hasInternalJargon(line) ? NEUTRAL_EDIT_LINE : line;
}
