
import type { SiteGatePageBlock, SiteGatePageText } from "./contract";
import { PRIVATE_PATH } from "./design-fidelity";
import type { SiteVisionFinding, SiteVisionSeverity } from "./site-vision-review";

export const SUBSTANTIAL_BLOCK = 300;
const BLOCK_MIN = 60;
const LINE_MIN = 60;
const PAGE_MIN_BLOCKS = 3;
export const PAGE_COPY_SHARE = 0.8;
const FINDINGS_MAX = 8;
const QUOTE_MAX = 80;
const LINES_PER_PAGE = 2;

export type SiteCopyCheck = { status: "checked"; pages: number; findings: SiteVisionFinding[] };

function blockKey(b: SiteGatePageBlock): string {
  return `${b.len}:${b.head.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

function quote(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX)}...` : t);
}

function finding(path: string, severity: SiteVisionSeverity, confidence: number, evidence: string, suggestion: string): SiteVisionFinding {
  return {
    screenshot: `page ${path}`,
    page: path,
    category: "repetition",
    severity,
    class: "defect",
    confidence,
    evidence,
    suggestion,
    source: "page",
  };
}

function pageFindings(page: SiteGatePageText): SiteVisionFinding[] {
  const out: SiteVisionFinding[] = [];
  const blocks = page.blocks ?? [];
  const byKey = new Map<string, { block: SiteGatePageBlock; n: number }>();
  for (const b of blocks) {
    if (b.len < BLOCK_MIN) continue;
    const k = blockKey(b);
    const seen = byKey.get(k);
    if (seen) seen.n += 1;
    else byKey.set(k, { block: b, n: 1 });
  }
  const repeated = [...byKey.values()].filter((v) => v.n > 1);
  for (const { block, n } of repeated) {
    const big = block.len >= SUBSTANTIAL_BLOCK;
    out.push(
      finding(
        page.path,
        big ? "high" : "medium",
        big ? 0.9 : 0.7,
        `the same section (${block.len} characters) appears ${n} times on ${page.path}, starting ${quote(block.head)}`,
        "Show this section once: remove the repeated render, or give the second one its own content.",
      ),
    );
  }
  const markCounts = new Map<string, number>();
  for (const b of blocks) if (b.mark) markCounts.set(b.mark, (markCounts.get(b.mark) ?? 0) + 1);
  if (repeated.length === 0) {
    for (const [id, n] of markCounts) {
      if (n < 2) continue;
      out.push(
        finding(
          page.path,
          "medium",
          0.7,
          `the planned section "${id}" is rendered ${n} times on ${page.path}`,
          `Render the "${id}" section once (keep data-zavi-section="${id}" on one element).`,
        ),
      );
    }
  }
  const inBlock = (line: string) => repeated.some((r) => r.block.head.toLowerCase().includes(line.slice(0, 40).toLowerCase()));
  const lines = new Map<string, number>();
  for (const raw of page.text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length >= LINE_MIN) lines.set(line, (lines.get(line) ?? 0) + 1);
  }
  let reported = 0;
  for (const [line, n] of lines) {
    if (n < 2 || inBlock(line) || reported >= LINES_PER_PAGE) continue;
    reported += 1;
    out.push(
      finding(
        page.path,
        "low",
        0.6,
        `the same sentence appears ${n} times on ${page.path}: ${quote(line)}`,
        "Say it once, or rewrite one of them for its own place on the page.",
      ),
    );
  }
  return out;
}

function copyOfHome(home: SiteGatePageText, page: SiteGatePageText): SiteVisionFinding | null {
  const a = new Set((home.blocks ?? []).filter((b) => b.len >= BLOCK_MIN).map(blockKey));
  const b = new Set((page.blocks ?? []).filter((x) => x.len >= BLOCK_MIN).map(blockKey));
  if (a.size < PAGE_MIN_BLOCKS || b.size < PAGE_MIN_BLOCKS) return null;
  let same = 0;
  for (const k of b) if (a.has(k)) same += 1;
  const union = a.size + b.size - same;
  if (union === 0 || same / union < PAGE_COPY_SHARE) return null;
  return finding(
    page.path,
    "high",
    0.9,
    `${page.path} repeats the home page: ${same} of its ${b.size} sections are the home page's sections word for word`,
    `Give ${page.path} its own content for what that page is for, instead of the home page's sections.`,
  );
}

const SEVERITY_RANK: Record<SiteVisionSeverity, number> = { high: 0, medium: 1, low: 2 };

export function checkSiteCopy(pages: readonly SiteGatePageText[]): SiteCopyCheck {
  const visitor = pages.filter((p) => !PRIVATE_PATH.test(p.path));
  const findings: SiteVisionFinding[] = [];
  for (const page of visitor) findings.push(...pageFindings(page));
  const home = visitor.find((p) => p.path === "/");
  if (home) {
    for (const page of visitor) {
      if (page.path === "/") continue;
      const f = copyOfHome(home, page);
      if (f) findings.push(f);
    }
  }
  const sorted = findings
    .map((f, i) => ({ f, i }))
    .sort((x, y) => SEVERITY_RANK[x.f.severity] - SEVERITY_RANK[y.f.severity] || y.f.confidence - x.f.confidence || x.i - y.i)
    .slice(0, FINDINGS_MAX)
    .map(({ f }) => f);
  return { status: "checked", pages: visitor.length, findings: sorted };
}
