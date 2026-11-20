
import { SSR_WORD_FLOOR, type CrawlerAccess } from "../geo/analyze";

export const AGENT_READINESS_DISCLOSURE =
  "Zavi's own check, not Google's. PageSpeed Insights does not expose its Agentic " +
  "Browsing category through the API, so these four checks are read from your site " +
  "directly and will not match the number on pagespeed.web.dev.";

export const AGENT_READINESS_TITLE = "Agent readiness";

export const CLS_GOOD_MAX = 0.1;

export type AgentCheckId = "llms_txt" | "ai_crawlers" | "server_rendered" | "layout_stable";

export type AgentCheck = {
  id: AgentCheckId;
  label: string;
  state: "pass" | "fail" | "unknown";
  detail: string;
};

export type AgentReadiness = {
  checks: AgentCheck[];
  passed: number;
  applicable: number;
};

export type AgentReadinessInput = {
  llmsTxt: boolean | null;
  crawlers: readonly CrawlerAccess[] | null;
  pages: readonly { url: string; visible_words: number }[] | null;
  site?: string | null;
  field: AgentReadinessField | null;
};

export type AgentReadinessField =
  | { state: "ok"; cls: number | string | null }
  | { state: "no_data" }
  | { state: "not_configured" }
  | { state: "unavailable" };

function finite(v: number | string | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function list(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function llmsTxtCheck(present: boolean | null): AgentCheck {
  const label = "Has an /llms.txt";
  const caveat =
    "It is not a Google Search ranking signal; it is one of the files Lighthouse's " +
    "experimental Agentic Browsing category looks for.";
  if (present === null) {
    return {
      id: "llms_txt",
      label,
      state: "unknown",
      detail: `We did not get to check for /llms.txt on this crawl. ${caveat}`,
    };
  }
  return present
    ? { id: "llms_txt", label, state: "pass", detail: `/llms.txt exists at the root. ${caveat}` }
    : { id: "llms_txt", label, state: "fail", detail: `No /llms.txt at the root. ${caveat}` };
}

function aiCrawlersCheck(crawlers: readonly CrawlerAccess[] | null): AgentCheck {
  const label = "AI crawlers can reach the site";
  const gate = (crawlers ?? []).filter((c) => c.recommended);

  if (gate.length === 0) {
    return {
      id: "ai_crawlers",
      label,
      state: "unknown",
      detail: "We have no robots.txt read for this site, so crawler access is unknown.",
    };
  }

  const blocked = gate.filter((c) => c.state === "blocked");
  if (blocked.length > 0) {
    return {
      id: "ai_crawlers",
      label,
      state: "fail",
      detail: `robots.txt blocks ${list(blocked.map((c) => c.name))} from the whole site.`,
    };
  }

  const open = gate.filter((c) => c.state === "allowed" || c.state === "partial");
  if (open.length === 0) {
    return {
      id: "ai_crawlers",
      label,
      state: "unknown",
      detail: "robots.txt did not respond, so we could not read what it allows.",
    };
  }
  if (open.length < gate.length) {
    const unread = gate.filter((c) => c.state === "unknown").map((c) => c.name);
    return {
      id: "ai_crawlers",
      label,
      state: "unknown",
      detail:
        `robots.txt allows ${list(open.map((c) => c.name))}, but we could not read a ` +
        `verdict for ${list(unread)}.`,
    };
  }

  const partial = gate.filter((c) => c.state === "partial");
  const named = gate.filter((c) => !c.from_wildcard);
  if (partial.length > 0) {
    return {
      id: "ai_crawlers",
      label,
      state: "pass",
      detail:
        `robots.txt admits ${list(gate.map((c) => c.name))} to the site, with some paths ` +
        `disallowed for ${list(partial.map((c) => c.name))}.`,
    };
  }
  return {
    id: "ai_crawlers",
    label,
    state: "pass",
    detail:
      named.length > 0
        ? `robots.txt allows ${list(named.map((c) => c.name))} by name.`
        : `robots.txt allows all crawlers but names none of ${list(gate.map((c) => c.name))}.`,
  };
}

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const p = new URL(u);
      return `${p.origin.toLowerCase()}${p.pathname.replace(/\/+$/, "")}`;
    } catch {
      return u.trim().replace(/\/+$/, "").toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

function homepageIn(
  pages: readonly { url: string; visible_words: number }[],
  site: string | null | undefined,
): { url: string; visible_words: number } | null {
  for (const p of pages) {
    try {
      const path = new URL(p.url).pathname;
      if (path === "/" || path === "") return p;
    } catch {
      continue;
    }
  }
  if (site) {
    for (const p of pages) if (sameUrl(p.url, site)) return p;
  }
  return null;
}

function serverRenderedCheck(
  pages: readonly { url: string; visible_words: number }[] | null,
  site: string | null | undefined,
): AgentCheck {
  const label = "Readable without JavaScript";
  const ok = (pages ?? []).filter((p) => Number.isFinite(p.visible_words));

  if (ok.length === 0) {
    return {
      id: "server_rendered",
      label,
      state: "unknown",
      detail: "We have no crawled pages for this site, so we could not check this.",
    };
  }

  const noun = ok.length === 1 ? "page" : "pages";
  const thin = (p: { visible_words: number }) => p.visible_words < SSR_WORD_FLOOR;
  const shells = ok.filter(thin);

  if (shells.length === 0) {
    return {
      id: "server_rendered",
      label,
      state: "pass",
      detail:
        `All ${ok.length} ${noun} we fetched carried at least ${SSR_WORD_FLOOR} words of ` +
        `text with JavaScript switched off.`,
    };
  }

  const named =
    `${list(shells.slice(0, 3).map((p) => p.url))}` + (shells.length > 3 ? ", and others" : "");
  const under = `under ${SSR_WORD_FLOOR} words of text with JavaScript switched off`;

  const home = homepageIn(ok, site);
  if (home && thin(home)) {
    return {
      id: "server_rendered",
      label,
      state: "fail",
      detail: `The homepage (${home.url}) carried ${under}.`,
    };
  }

  if (shells.length * 2 > ok.length) {
    return {
      id: "server_rendered",
      label,
      state: "fail",
      detail: `${shells.length} of the ${ok.length} ${noun} we fetched carried ${under} (${named}).`,
    };
  }

  return {
    id: "server_rendered",
    label,
    state: "pass",
    detail:
      `${ok.length - shells.length} of the ${ok.length} ${noun} we fetched carried at least ` +
      `${SSR_WORD_FLOOR} words of text with JavaScript switched off. ` +
      `${shells.length} did not (${named}).`,
  };
}

export const CRUX_NO_DATA_DETAIL =
  "Google has no real-visitor data for this site, so layout shift could not be measured.";

function layoutStableCheck(field: AgentReadinessField | null): AgentCheck {
  const label = "Layout does not shift under the reader";
  const unknown = (detail: string): AgentCheck => ({
    id: "layout_stable",
    label,
    state: "unknown",
    detail,
  });

  if (!field) return unknown("We have not measured layout shift for this site yet.");

  switch (field.state) {
    case "no_data":
      return unknown(CRUX_NO_DATA_DETAIL);
    case "not_configured":
      return unknown("Performance checks are not switched on, so layout shift was not measured.");
    case "unavailable":
      return unknown("We could not read layout shift from Google for this site.");
    case "ok":
      break;
  }

  const p75 = finite(field.cls);
  if (p75 === null) {
    return unknown("Google answered for this site, but its record carried no layout shift score.");
  }
  const shown = String(Math.round(p75 * 1000) / 1000);
  return p75 <= CLS_GOOD_MAX
    ? {
        id: "layout_stable",
        label,
        state: "pass",
        detail: `Real visitors saw a layout shift score of ${shown}, at or under the ${CLS_GOOD_MAX} threshold.`,
      }
    : {
        id: "layout_stable",
        label,
        state: "fail",
        detail: `Real visitors saw a layout shift score of ${shown}, above the ${CLS_GOOD_MAX} threshold.`,
      };
}

export function computeAgentReadiness(input: AgentReadinessInput): AgentReadiness {
  const checks: AgentCheck[] = [
    llmsTxtCheck(input?.llmsTxt ?? null),
    aiCrawlersCheck(input?.crawlers ?? null),
    serverRenderedCheck(input?.pages ?? null, input?.site ?? null),
    layoutStableCheck(input?.field ?? null),
  ];
  return {
    checks,
    passed: checks.filter((c) => c.state === "pass").length,
    applicable: checks.filter((c) => c.state !== "unknown").length,
  };
}
