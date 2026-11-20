
import type {
  StartCardAiEngine,
  StartCardAiEvidence,
  StartCardCheckKey,
  StartCardCompareEvidence,
  StartCardDesignEvidence,
  StartCardGoogleEvidence,
  StartCardSeoEvidence,
} from "@zavi/shared";
import { BODY_TEXT_MIN_PX, SEO_META_MAX, SEO_META_MIN, SEO_TITLE_MAX, SEO_TITLE_MIN } from "./points";

export const ENGINE_LABEL: Record<StartCardAiEngine, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  perplexity: "Perplexity",
  claude: "Claude",
};

export const CHECK_LABEL: Record<StartCardCheckKey, string> = {
  google: "Google",
  ai: "AI answers",
  seo: "SEO & basics",
  design: "Design & UX",
  compare: "Vs competitors",
};

const list = (xs: string[]): string =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export function googleNote(ev: StartCardGoogleEvidence): string {
  const term = `“${ev.search_term}”`;
  if (ev.position === null) {
    const top = ev.top_domains?.[0];
    return `Not in the top ${ev.results_checked} Google results for ${term}${top ? `; ${top} ranks first` : ""}.`;
  }
  const main = `#${ev.position} on Google for ${term}.`;
  const gap = broadGapLine(ev);
  return gap ? `${main} ${gap}` : main;
}

export function broadGapLine(ev: StartCardGoogleEvidence): string {
  if (ev.term_source !== "ranked" || !ev.broad_term || ev.broad_position === undefined) return "";
  const broad = `“${ev.broad_term}”`;
  if (ev.broad_position !== null) return `For the broader ${broad} you're #${ev.broad_position}.`;
  const top = ev.broad_top_domain;
  return `For the broader ${broad} you're not in the top ${ev.broad_results_checked ?? 100}${top ? ` (${top} ranks first)` : ""}.`;
}

export function aiNote(ev: StartCardAiEvidence): string {
  const answered = ev.engines.filter((e) => e.answered);
  const named = answered.filter((e) => e.mentioned === true).map((e) => ENGINE_LABEL[e.engine]);
  const silent = ev.engines.length - answered.length;
  const base =
    named.length === 0
      ? `None of the ${answered.length} AI assistants that answered named you`
      : `Named by ${named.length} of ${answered.length} AI assistants (${list(named)})`;
  return `${base}${silent > 0 ? `; ${silent} did not answer` : ""}.`;
}

export function seoIssues(ev: StartCardSeoEvidence): string[] {
  const issues: string[] = [];
  const t = ev.title?.trim().length ?? 0;
  if (t === 0) issues.push("no page title");
  else if (t < SEO_TITLE_MIN || t > SEO_TITLE_MAX) issues.push(`page title is ${t} characters`);
  const m = ev.meta_description?.trim().length ?? 0;
  if (m === 0) issues.push("no meta description");
  else if (m < SEO_META_MIN || m > SEO_META_MAX) issues.push(`meta description is ${m} characters`);
  if (ev.h1_count === 0) issues.push("no H1 heading");
  else if (ev.h1_count > 1) issues.push(`${ev.h1_count} H1 headings`);
  if (ev.schema_types.length === 0) issues.push("no structured data");
  if (ev.robots_allows_root === false) issues.push("robots.txt blocks search engines");
  else if (!ev.sitemap_found) issues.push("no sitemap found");
  if (ev.broken_links.length > 0) {
    issues.push(`${ev.broken_links.length} broken link${ev.broken_links.length === 1 ? "" : "s"}`);
  }
  return issues;
}

export function seoNote(ev: StartCardSeoEvidence): string {
  const issues = seoIssues(ev);
  const pages = ev.pages_checked.length;
  const scope = `homepage read, ${pages} page${pages === 1 ? "" : "s"} checked for broken links`;
  if (issues.length === 0) return `All six basics in place (${scope}).`;
  const s = list(issues);
  return `${s.charAt(0).toUpperCase()}${s.slice(1)} (${scope}).`;
}

export function renderIssues(r: NonNullable<StartCardDesignEvidence["render"]>): string[] {
  const issues: string[] = [];
  if (!r.cta_above_fold) issues.push("no buy, sign-up or contact button on the first phone screen");
  if (r.body_text_px === null) issues.push("body text size not readable");
  else if (r.body_text_px < BODY_TEXT_MIN_PX) issues.push(`body text is ${r.body_text_px}px (under ${BODY_TEXT_MIN_PX}px)`);
  if (r.overlapping_boxes) issues.push("text boxes overlap");
  if (r.horizontal_scroll) issues.push("page scrolls sideways on a phone");
  return issues;
}

export function designNote(ev: StartCardDesignEvidence): string {
  const bits: string[] = [];
  if (ev.pagespeed) {
    bits.push(`Mobile speed ${ev.pagespeed.performance}/100, accessibility ${ev.pagespeed.accessibility}/100`);
  } else {
    bits.push("PageSpeed not measured");
  }
  if (ev.render) {
    const issues = renderIssues(ev.render);
    bits.push(issues.length === 0 ? "phone screen passes all four checks" : list(issues));
  } else {
    bits.push("phone screen not measured");
  }
  return `${bits.join("; ")}.`;
}

export function compareNote(ev: StartCardCompareEvidence): string {
  const me = ev.ranking.find((r) => r.is_business);
  const used = (ev.checks_used ?? []).map((k) => CHECK_LABEL[k]);
  if (!me) return "";
  return `#${me.rank} of ${ev.ranking.length} against your competitors${used.length ? ` on ${list(used)}` : ""}.`;
}
