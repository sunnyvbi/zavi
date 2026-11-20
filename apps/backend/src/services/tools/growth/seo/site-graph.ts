
import { z } from "zod";
import { canonicalOf, isHtmlPage, isNoindex, isPrivatePath, stripTags, type FetchedPage } from "./analyze";

export const SiteGraphLabel = z.enum([
  "orphan",
  "sitemap_unreachable",
  "redirects_to_login",
  "schema_without_visible_content",
  "missing_canonical",
  "llms_txt_missing_page",
  "could_not_read",
]);
export type SiteGraphLabel = z.infer<typeof SiteGraphLabel>;

export type SiteGraphFinding = {
  label: SiteGraphLabel;
  url: string;
  detail?: string;
  fix?: string;
};

const FIX_BY_LABEL: Record<SiteGraphLabel, ((url: string) => string) | null> = {
  orphan: (url) => `Add ${url} to sitemap.xml.`,
  sitemap_unreachable: (url) => `Remove ${url} from sitemap.xml or point it at the live page.`,
  redirects_to_login: (url) => `Take ${url} out of the sitemap and llms.txt, or make it public.`,
  schema_without_visible_content: (url) =>
    `Show these questions and answers as visible text on ${url}, or delete them from its FAQPage JSON-LD.`,
  missing_canonical: (url) => `Add <link rel="canonical" href="${url}"> to the page head.`,
  llms_txt_missing_page: (url) => `Add a line for ${url} to /llms.txt.`,
  could_not_read: null,
};

function withFix(f: SiteGraphFinding): SiteGraphFinding {
  const fix = FIX_BY_LABEL[f.label];
  return fix ? { ...f, fix: fix(f.url) } : f;
}

export type SiteGraphInput = {
  pages: FetchedPage[];
  sitemap_paths: string[];
  sitemap_query_only_paths?: string[];
  sitemap_complete: boolean;
  llms_txt_paths: string[] | null;
  linked_paths: string[];
};

export type SiteGraphReport = {
  findings: SiteGraphFinding[];
  skipped: string[];
  omitted: number;
};

const MAX_FINDINGS = 60;

export function normPath(path: string): string {
  const p = (path.startsWith("/") ? path : `/${path}`).replace(/\/{2,}/g, "/");
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : "/";
}

const SIGNUP_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:sign-?up|register)(?:\/|$)/i;

export function isLoginPath(path: string): boolean {
  return isPrivatePath(path) || SIGNUP_PATH.test(path);
}

function pathOf(url: string, base?: string): string | null {
  try {
    return normPath(new URL(url, base).pathname);
  } catch {
    return null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isRefusal(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

const ENTITIES: Record<string, string> = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ",
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "...",
};

function codePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
}

function comparable(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => codePoint(Number(d)))
    .replace(/&([a-z])(?:acute|grave|circ|uml|tilde|cedil|ring|slash|caron);/gi, "$1")
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? " ")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function faqQuestionsOf(html: string): string[] {
  const out: string[] = [];
  const re = /<script[^>]+type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      const t = o["@type"];
      const isFaq = t === "FAQPage" || (Array.isArray(t) && t.includes("FAQPage"));
      if (isFaq) {
        const entities = Array.isArray(o.mainEntity) ? o.mainEntity : [o.mainEntity];
        for (const q of entities) {
          const name = q && typeof q === "object" ? (q as Record<string, unknown>).name : null;
          if (typeof name === "string" && name.trim()) out.push(name.trim());
        }
        return;
      }
      for (const v of Object.values(o)) visit(v);
    };
    visit(parsed);
  }
  return out;
}

export function analyzeSiteGraph(input: SiteGraphInput): SiteGraphReport {
  const findings: SiteGraphFinding[] = [];
  const skipped: string[] = [];
  const sitemap = new Set(input.sitemap_paths);
  const queryOnly = new Set(input.sitemap_query_only_paths ?? []);
  const linked = new Set(input.linked_paths);
  const llms = input.llms_txt_paths === null ? null : new Set(input.llms_txt_paths);

  const canJudgeOrphans = sitemap.size > 0 && input.sitemap_complete;
  if (sitemap.size === 0) skipped.push("orphan: no readable sitemap to compare against");
  else if (!input.sitemap_complete) skipped.push("orphan: the sitemap was only partly read, so absence from it is unknown");
  const canJudgeLlms = llms !== null && llms.size > 0;
  if (llms !== null && llms.size === 0) skipped.push("llms_txt_missing_page: llms.txt lists no same-site URL we could read");

  for (const p of input.pages) {
    const path = pathOf(p.url);
    if (path === null) continue;
    const inSitemap = sitemap.has(path);
    const listedBare = inSitemap && !queryOnly.has(path);
    const inLlms = llms?.has(path) ?? false;

    if (p.status === 0 || isRefusal(p.status)) {
      findings.push({ label: "could_not_read", url: p.url, detail: p.status === 0 ? "no response" : `HTTP ${p.status}` });
      continue;
    }

    const finalPath = p.final_url ? pathOf(p.final_url) : path;
    const leftSite = p.final_url ? hostOf(p.final_url) !== hostOf(p.url) : false;
    const movedTo = leftSite
      ? `${hostOf(p.final_url!) ?? "another site"}${finalPath ?? ""}`
      : finalPath !== null && finalPath !== path ? finalPath : null;
    if (movedTo && finalPath !== null && isLoginPath(finalPath) && (listedBare || inLlms)) {
      findings.push({ label: "redirects_to_login", url: p.url, detail: `redirects to ${movedTo}` });
      continue;
    }
    if (listedBare && movedTo) {
      findings.push({ label: "sitemap_unreachable", url: p.url, detail: `redirects to ${movedTo}` });
      continue;
    }
    if (listedBare && p.status >= 400) {
      findings.push({ label: "sitemap_unreachable", url: p.url, detail: `HTTP ${p.status}` });
      continue;
    }

    const ok = p.status >= 200 && p.status < 300 && p.html.length > 0 && movedTo === null;
    if (!ok || isNoindex(p)) continue;

    const canonical = canonicalOf(p.html);
    const canonicalPath = canonical ? pathOf(canonical, p.url) : null;
    const isVariant = canonicalPath !== null && canonicalPath !== path;
    const html = isHtmlPage(p);

    if (canJudgeOrphans && html && !inSitemap && !isVariant && (linked.has(path) || inLlms)) {
      findings.push({
        label: "orphan",
        url: p.url,
        detail: inLlms && !linked.has(path) ? "listed in llms.txt, not in the sitemap" : "linked from the site, not in the sitemap",
      });
    }

    if (canJudgeLlms && html && !inLlms && !isVariant && path !== "/" && (inSitemap || linked.has(path))) {
      findings.push({ label: "llms_txt_missing_page", url: p.url });
    }

    if (p.truncated) continue;
    if (!canonical && html) findings.push({ label: "missing_canonical", url: p.url });

    const questions = faqQuestionsOf(p.html);
    if (questions.length > 0) {
      const text = ` ${comparable(stripTags(p.html))} `;
      const hidden = questions.filter((q) => {
        const c = comparable(q);
        return c.length > 0 && !text.includes(` ${c} `);
      });
      if (hidden.length > 0) {
        findings.push({
          label: "schema_without_visible_content",
          url: p.url,
          detail:
            `FAQPage JSON-LD: ${hidden.length} of ${questions.length} questions are not in the page's HTML text: ` +
            hidden
              .slice(0, 3)
              .map((q) => `"${q.length > 100 ? `${q.slice(0, 99)}…` : q}"`)
              .join("; ") +
            (hidden.length > 3 ? `; and ${hidden.length - 3} more` : ""),
        });
      }
    }
  }

  return {
    findings: findings.slice(0, MAX_FINDINGS).map(withFix),
    skipped,
    omitted: Math.max(0, findings.length - MAX_FINDINGS),
  };
}
