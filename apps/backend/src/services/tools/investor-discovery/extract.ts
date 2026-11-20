
export type SourceKind =
  | "investor_directory"
  | "investor_listicle"
  | "fund_profile"
  | "portfolio_or_news"
  | "other";

type QueryParts = {
  region?: string;
  stage?: string;
  sector?: string;
  comparables?: string[];
};

export function buildDiscoveryQueries(parts: QueryParts): string[] {
  const region = (parts.region ?? "").trim();
  const stage = (parts.stage ?? "").trim();
  const sector = (parts.sector ?? "").trim();
  const comparables = (parts.comparables ?? [])
    .map((c) => (c ?? "").trim())
    .filter((c) => c.length > 0)
    .slice(0, 6);

  const clean = (s: string) => s.replace(/\s+/g, " ").trim();

  const out: string[] = [];
  const push = (s: string) => {
    const c = clean(s);
    if (c.length >= 8) out.push(c);
  };

  if (sector) {
    push(`top ${region} ${sector} ${stage} investors list`);
    push(`${sector} VC firms ${region}`);
    push(`${region} angel investors ${sector}`);
    push(`${sector} ${stage} funds list ${region}`);
    push(`${sector} VC firms that lead ${stage} rounds`);
    push(`best ${stage} investors for ${sector} startups ${region}`);
    push(`list of ${sector} venture capital firms`);
  }
  for (const comp of comparables) {
    push(`investors who backed ${comp}`);
    push(`${comp} investors list`);
  }
  if (out.length === 0 && stage) {
    push(`${region} ${stage} investors list`);
    push(`${stage} venture capital firms ${region}`);
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const q of out) {
    const k = q.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(q);
    if (deduped.length >= 12) break;
  }
  return deduped;
}

const DEPRIORITIZED_DOMAINS = [
  "linkedin.com",
  "crunchbase.com",
  "signal.nfx.com",
  "nfx.com",
  "openvc.app",
  "openvc.com",
  "pitchbook.com",
  "cbinsights.com",
  "dealroom.co",
];

const LIST_SIGNAL_TOKENS = [
  "list",
  "directory",
  "top-",
  "best-",
  "investors",
  "vc-firms",
  "funds",
  "angels",
  "/vcs",
];

function hostOf(url: string): string {
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return u.hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function rankCandidateUrls(urls: string[]): string[] {
  const scored = urls
    .map((url, idx) => ({ url, idx, score: scoreUrl(url) }))
    .filter((s) => s.score > -Infinity);
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return scored.map((s) => s.url);
}

function scoreUrl(url: string): number {
  const lower = url.toLowerCase();
  if (!/^https?:\/\//.test(lower) && !lower.includes(".")) return -Infinity;
  const host = hostOf(url);
  if (!host) return -Infinity;
  let score = 0;
  if (DEPRIORITIZED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    score -= 100;
  }
  for (const tok of LIST_SIGNAL_TOKENS) {
    if (lower.includes(tok)) {
      score += 5;
      break;
    }
  }
  return score;
}

const INVESTOR_ENTRY_CUES = [
  "invests",
  "investor",
  "investors",
  "venture",
  "ventures",
  "capital",
  "fund",
  "funds",
  "seed",
  "series",
  "pre-seed",
  "check size",
  "partner",
  "partners",
  "portfolio",
  "leads rounds",
  "lead investor",
  "angel",
  "vc",
];

const DIRECTORY_CUES = ["directory", "browse investors", "filter by", "investor database", "openvc"];
const LISTICLE_CUES = ["top ", "best ", "list of", " investors to", "20 ", "25 ", "30 ", "50 "];
const FUND_PROFILE_CUES = ["our portfolio", "we invest", "our thesis", "our team", "we back", "we lead"];
const NEWS_PORTFOLIO_CUES = ["read more", "by ", "published", "press release", "min read", "comments"];

const FIRM_NAME_RE =
  /\b([A-Z][A-Za-z0-9&'-]+(?:\s+[A-Z][A-Za-z0-9&'-]+){0,3}\s+(?:Ventures|Venture|Capital|Partners|Partner|Fund|Funds|VC|Equity|Advisors))\b/g;

const FIRM_STOPWORDS = new Set([
  "the",
  "investors",
  "investor",
  "portfolio",
  "companies",
  "company",
  "about",
  "team",
  "contact",
  "home",
  "menu",
  "read more",
  "learn more",
  "sign in",
  "log in",
  "subscribe",
  "newsletter",
  "privacy policy",
  "terms",
  "cookie",
  "all rights reserved",
  "seed",
  "series a",
  "series b",
  "pre-seed",
  "venture capital",
]);

const EVIDENCE_SPAN_MIN = 40;
const EVIDENCE_SPAN_MAX = 200;
const PER_PAGE_CANDIDATE_CAP = 60;

function lc(s: string): string {
  return s.toLowerCase();
}

export function classifySourceKind(bodyText: string): SourceKind {
  const t = lc(bodyText);
  const has = (cues: string[]) => cues.some((c) => t.includes(c));
  if (has(DIRECTORY_CUES)) return "investor_directory";
  const investorCueCount = INVESTOR_ENTRY_CUES.filter((c) => t.includes(c)).length;
  if (has(LISTICLE_CUES) && investorCueCount >= 2) return "investor_listicle";
  if (has(FUND_PROFILE_CUES) && investorCueCount >= 1) return "fund_profile";
  if (has(NEWS_PORTFOLIO_CUES) && investorCueCount < 2) return "portfolio_or_news";
  if (investorCueCount >= 3) return "investor_listicle";
  return "other";
}

function evidenceSpanAround(text: string, matchIdx: number, matchLen: number): string {
  const half = Math.floor((EVIDENCE_SPAN_MAX - matchLen) / 2);
  let start = Math.max(0, matchIdx - half);
  let end = Math.min(text.length, matchIdx + matchLen + half);
  let span = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (span.length < EVIDENCE_SPAN_MIN) {
    start = Math.max(0, matchIdx - (EVIDENCE_SPAN_MAX - matchLen));
    end = Math.min(text.length, matchIdx + matchLen + (EVIDENCE_SPAN_MAX - matchLen));
    span = text.slice(start, end).replace(/\s+/g, " ").trim();
  }
  if (span.length > EVIDENCE_SPAN_MAX) span = span.slice(0, EVIDENCE_SPAN_MAX);
  return span;
}

type Candidate = {
  firm: string;
  source_url: string;
  evidence_span: string;
  source_kind: SourceKind;
};

export function extractCandidatesFromPage(bodyText: string, sourceUrl: string): Candidate[] {
  if (!bodyText) return [];
  const source_kind = classifySourceKind(bodyText);
  const text = bodyText;
  const lowerText = lc(text);

  const out: Candidate[] = [];
  const seenFirm = new Set<string>();

  FIRM_NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIRM_NAME_RE.exec(text)) !== null) {
    if (out.length >= PER_PAGE_CANDIDATE_CAP) break;
    const firm = m[1].trim();
    const firmLc = lc(firm);
    if (firm.length < 3) continue;
    if (FIRM_STOPWORDS.has(firmLc)) continue;
    const idx = m.index;
    const winStart = Math.max(0, idx - 160);
    const winEnd = Math.min(lowerText.length, idx + firm.length + 160);
    const window = lowerText.slice(winStart, winEnd);
    const nearCue = INVESTOR_ENTRY_CUES.some((c) => window.includes(c));
    if (!nearCue) continue;
    if (seenFirm.has(firmLc)) continue;
    seenFirm.add(firmLc);
    const evidence_span = evidenceSpanAround(text, idx, firm.length);
    if (evidence_span.length < EVIDENCE_SPAN_MIN) continue;
    out.push({ firm, source_url: sourceUrl, evidence_span, source_kind });
  }
  return out;
}
