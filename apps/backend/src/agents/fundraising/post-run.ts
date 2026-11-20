
import type { PostProcessorFn } from "@/agents/index";
import { deliverCsv } from "@/services/reports/deliver-csv";
import { csvField } from "@/services/reports/csv";
import { serviceClient } from "@/services/supabase";
import {
  materializeInvestors,
  identityKey as materializeIdentityKey,
  type MaterializeSummary,
} from "./materialize";
import { getCapturedText } from "@/services/agents/engine/capture-ledger";
import { classifySourceKind } from "@/services/tools/investor-discovery/extract";
import {
  canonicalFirm,
  normalizeName,
  isFromInvestorDb,
  investorDbLedgerSize,
} from "@/services/agents/engine/investor-db-ledger";
import {
  ADVICE_TOPICS,
  DEEP_NO_PERSON_REFUSAL,
  fundraisingEnvelopeSchema,
  type FundraisingAdvice,
  type FundraisingAdviceTopicValue,
  type FundraisingDeepDossier,
  type FundraisingDeepSource,
  type FundraisingInvestor,
} from "./output-schema";

const CSV_HEADERS = [
  "Tier",
  "Firm",
  "Name",
  "Focus",
  "Stage",
  "Check Size",
  "Fit Rationale",
  "Contact",
  "Suggested Message",
] as const;

function normalizeText(s: string): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

const MIN_EVIDENCE_LEN = 12;

function dedupKey(inv: FundraisingInvestor): string {
  return `${canonicalFirm(inv.firm)}|${normalizeName(inv.name ?? "")}`;
}

const MIN_FIRM_MATCH_LEN = 4;
const MIN_NAME_MATCH_LEN = 5;

const MIN_PERSON_NAME_TOKENS = 2;
const MIN_PERSON_NAME_TOKEN_LEN = 2;

function isMultiTokenPersonName(nameNorm: string): boolean {
  const tokens = nameNorm.split(" ").filter((t) => t.length >= MIN_PERSON_NAME_TOKEN_LEN);
  return tokens.length >= MIN_PERSON_NAME_TOKENS;
}

const ANGEL_NAME_STOP_TOKENS = new Set([
  "round",
  "fund",
  "funds",
  "capital",
  "ventures",
  "venture",
  "partners",
  "syndicate",
  "seed",
  "angel",
  "angels",
  "investors",
  "investment",
  "equity",
  "fellowship",
  "group",
  "accelerator",
]);

function nameHasFinanceStopToken(nameNorm: string): boolean {
  return nameNorm.split(" ").some((t) => ANGEL_NAME_STOP_TOKENS.has(t));
}

function boundedIncludes(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx === 0 ? "" : haystack[idx - 1];
    const after =
      idx + needle.length >= haystack.length ? "" : haystack[idx + needle.length];
    const beforeOk = before === "" || !/[a-z0-9]/.test(before);
    const afterOk = after === "" || !/[a-z0-9]/.test(after);
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
}

function boundedIndexOf(haystack: string, needle: string): number {
  if (!needle) return -1;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return -1;
    const before = idx === 0 ? "" : haystack[idx - 1];
    const after =
      idx + needle.length >= haystack.length ? "" : haystack[idx + needle.length];
    const beforeOk = before === "" || !/[a-z0-9]/.test(before);
    const afterOk = after === "" || !/[a-z0-9]/.test(after);
    if (beforeOk && afterOk) return idx;
    from = idx + 1;
  }
}

const FIRM_SUFFIX_TOKENS = new Set([
  "capital",
  "ventures",
  "venture",
  "vc",
  "partners",
  "partner",
  "fund",
  "funds",
  "management",
  "group",
  "labs",
  "company",
  "foundation",
  "llc",
  "lp",
]);

const GENERIC_DISTINCTIVE_TOKENS = new Set([
  ...FIRM_SUFFIX_TOKENS,
  "first",
  "round",
  "signal",
  "kindred",
  "homebrew",
  "general",
  "global",
  "north",
  "south",
  "east",
  "west",
  "new",
  "next",
  "true",
  "core",
  "base",
  "main",
  "prime",
]);

const INVESTOR_CONTEXT_TERMS = [
  "venture",
  "capital",
  "fund",
  "invest",
  "portfolio",
  "seed",
  "series",
  "partner",
  "founder",
  "startup",
  "angel",
  "fundraise",
  "lead",
  "vc",
  "firm",
  "investor",
  "investors",
  "investment",
  "investments",
  "check",
  "writes",
  "writer",
  "gp",
  "lp",
  "managing",
  "led by",
  "backs",
  "accelerator",
  "syndicate",
  "micro",
  "early-stage",
  "fund profile",
];

const MIN_DISTINCTIVE_TOKEN_LEN = 5;

const LOCAL_CONTEXT_RADIUS = 300;

type FirmDistinctiveness = {
  token: string;
  generic: boolean;
};

function firmDistinctiveness(firm: string): FirmDistinctiveness {
  const cleaned = (firm ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return { token: "", generic: true };
  const tokens = cleaned.split(" ");
  while (tokens.length > 1 && FIRM_SUFFIX_TOKENS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  const remaining = tokens;
  let token = "";
  for (const t of remaining) {
    if (t.length > token.length) token = t;
  }
  const generic =
    token.length < MIN_DISTINCTIVE_TOKEN_LEN ||
    GENERIC_DISTINCTIVE_TOKENS.has(token) ||
    token.length === 0;
  return { token, generic };
}

function distinctiveTokenInHost(distinctive: string, sourceUrl: string): boolean {
  if (!distinctive || distinctive.length < 3) return false;
  let host = "";
  try {
    const u = new URL(
      sourceUrl.includes("://") ? sourceUrl : `https://${sourceUrl}`,
    );
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  const lastDot = host.lastIndexOf(".");
  if (lastDot > 0) host = host.slice(0, lastDot);
  const segments = host
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .flatMap((piece) =>
      piece
        .replace(/([a-z])([0-9])/g, "$1 $2")
        .replace(/([0-9])([a-z])/g, "$1 $2")
        .split(" ")
        .filter(Boolean),
    );
  return segments.some(
    (seg) => seg === distinctive || seg.startsWith(distinctive),
  );
}

function blankFirmTokens(text: string, firm: string): string {
  const firmTokens = (firm ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  let out = text;
  for (const tok of firmTokens) {
    let from = 0;
    for (;;) {
      const idx = out.indexOf(tok, from);
      if (idx === -1) break;
      const before = idx === 0 ? "" : out[idx - 1];
      const after = idx + tok.length >= out.length ? "" : out[idx + tok.length];
      const beforeOk = before === "" || !/[a-z0-9]/.test(before);
      const afterOk = after === "" || !/[a-z0-9]/.test(after);
      if (beforeOk && afterOk) {
        out = out.slice(0, idx) + " ".repeat(tok.length) + out.slice(idx + tok.length);
        from = idx + tok.length;
      } else {
        from = idx + 1;
      }
    }
  }
  return out;
}

function firmHasLocalInvestorContext(
  normPage: string,
  firmCanon: string,
  firm: string,
): boolean {
  const at = boundedIndexOf(normPage, firmCanon);
  if (at === -1) return false;
  const start = Math.max(0, at - LOCAL_CONTEXT_RADIUS);
  const end = Math.min(
    normPage.length,
    at + firmCanon.length + LOCAL_CONTEXT_RADIUS,
  );
  const window = blankFirmTokens(normPage.slice(start, end), firm);
  return INVESTOR_CONTEXT_TERMS.some((term) => window.includes(term));
}

function passesFirmContextGuard(
  firm: string,
  firmCanon: string,
  sourceUrl: string,
  normPage: string,
): boolean {
  const { token, generic } = firmDistinctiveness(firm);
  const officialDomain = distinctiveTokenInHost(token, sourceUrl);
  const localContext = firmHasLocalInvestorContext(normPage, firmCanon, firm);
  return generic
    ? officialDomain && localContext
    : officialDomain || localContext;
}

const INVESTOR_SOURCE_KINDS = new Set([
  "investor_directory",
  "investor_listicle",
  "fund_profile",
]);

const MIN_EVIDENCE_SPAN_LEN = 20;

const NON_INVESTOR_MARKERS = [
  "wrote",
  "author",
  "byline",
  "comments",
  "©",
  "footer",
  "portfolio company",
  "backed by",
  "our portfolio",
  "founded",
  "ceo of",
  "report abuse",
  "portfolio highlights",
  "portfolio:",
  "customers include",
  "backed companies",
  "sponsored by",
];

const INVESTOR_ROLE_CUES = [
  "invests",
  "invest in",
  "investor",
  "vc",
  "venture",
  "ventures",
  "capital",
  "fund",
  "funds",
  "partners",
  "leads rounds",
  "leads",
  "check size",
  "writes checks",
  "backs",
  "early-stage",
  "early stage",
];

const FUNDRAISING_RECEIPT_BEFORE_CUES = [
  "raised",
  "raises",
  "raising",
  "backed by",
  "backed",
  "founded",
  "ceo of",
  "we invested in",
  "invested in",
  "portfolio:",
  "portfolio company",
  "funding from",
  "investment from",
];

const FUNDRAISING_RECEIPT_AFTER_CUES = [
  "raised",
  "raises",
  "raising",
  "closed a",
  "closed its",
  "secured",
  "announced a",
  "backed by",
  "founded by",
  "founded in",
  "is a startup",
  "is a company",
];

const WEAK_RECEIPT_AFTER_CUES = ["is a startup", "is a company"];

const INVESTOR_SOURCE_PREPOSITIONS = [
  "from",
  "led by",
  "backed by",
  "investors include",
  "investor:",
  "investors:",
  "investor",
];

const FIRM_BIND_BEFORE_RADIUS = 40;
const FIRM_BIND_AFTER_RADIUS = 40;
const FIRM_PREPOSITION_TAIL = 20;

function containsAnyCue(text: string, cues: string[]): boolean {
  return cues.some((c) => text.includes(c));
}

function firmIsFundingSource(before: string): boolean {
  const tail = before.slice(Math.max(0, before.length - FIRM_PREPOSITION_TAIL)).trimEnd();
  return INVESTOR_SOURCE_PREPOSITIONS.some(
    (p) => tail === p || tail.endsWith(` ${p}`),
  );
}

function investorRoleBoundToFirm(normSpan: string, firmAt: number, firmLen: number): boolean {
  const beforeStart = Math.max(0, firmAt - FIRM_BIND_BEFORE_RADIUS);
  const before = normSpan.slice(beforeStart, firmAt);
  const afterStart = firmAt + firmLen;
  const after = normSpan.slice(afterStart, afterStart + FIRM_BIND_AFTER_RADIUS);
  const fundingSource = firmIsFundingSource(before);

  if (fundingSource) return true;
  if (containsAnyCue(before, FUNDRAISING_RECEIPT_BEFORE_CUES)) return false;
  const afterTrimmed = after.replace(/^\s+/, "");
  if (FUNDRAISING_RECEIPT_AFTER_CUES.some((c) => afterTrimmed.startsWith(c))) return false;

  if (containsAnyCue(before, INVESTOR_ROLE_CUES)) return true;
  if (containsAnyCue(after, INVESTOR_ROLE_CUES)) return true;

  return false;
}

function spanReadsLikeInvestorEntry(
  normSpan: string,
  firmCanon: string,
  firm: string = "",
): boolean {
  const firmAt =
    firmCanon.length >= MIN_FIRM_MATCH_LEN ? boundedIndexOf(normSpan, firmCanon) : -1;

  if (firmAt !== -1) {
    const beforeStart = Math.max(0, firmAt - FIRM_BIND_BEFORE_RADIUS);
    const before = normSpan.slice(beforeStart, firmAt);
    const after = normSpan.slice(
      firmAt + firmCanon.length,
      firmAt + firmCanon.length + FIRM_BIND_AFTER_RADIUS,
    );
    const afterTrimmed = after.replace(/^\s+/, "");

    if (firmIsFundingSource(before)) return true;

    const recipientBefore = containsAnyCue(before, FUNDRAISING_RECEIPT_BEFORE_CUES);
    const afterStrongRecipient = FUNDRAISING_RECEIPT_AFTER_CUES.filter(
      (c) => !WEAK_RECEIPT_AFTER_CUES.includes(c),
    ).some((c) => afterTrimmed.startsWith(c));
    const afterWeakRecipient = WEAK_RECEIPT_AFTER_CUES.some((c) =>
      afterTrimmed.startsWith(c),
    );
    if (recipientBefore || afterStrongRecipient) return false;
    if (afterWeakRecipient) {
      const sansFirm = blankFirmTokens(normSpan, firm || firmCanon);
      return containsAnyCue(sansFirm, INVESTOR_ROLE_CUES);
    }

    if (investorRoleBoundToFirm(normSpan, firmAt, firmCanon.length)) return true;
  }

  const hasInvestorCue = containsAnyCue(normSpan, INVESTOR_ROLE_CUES);
  if (hasInvestorCue) return true;
  const hasNonInvestorMarker = NON_INVESTOR_MARKERS.some((c) => normSpan.includes(c));
  return !hasNonInvestorMarker;
}

function passesRolePredicate(
  sourceKind: string | undefined,
  evidenceSpan: string,
  normPage: string,
  firmCanon: string,
  firm: string,
): boolean {
  if (!sourceKind || !INVESTOR_SOURCE_KINDS.has(sourceKind)) return false;
  if (normPage && classifySourceKind(normPage) === "portfolio_or_news") {
    return false;
  }
  const span = (evidenceSpan ?? "").trim();
  if (span.length < MIN_EVIDENCE_SPAN_LEN) return false;
  const normSpan = normalizeText(span);
  if (!normPage.includes(normSpan)) return false;
  if (firmCanon.length >= MIN_FIRM_MATCH_LEN && !boundedIncludes(normSpan, firmCanon)) {
    return false;
  }
  if (NON_INVESTOR_MARKERS.some((m) => normSpan.includes(m))) return false;
  const spanSansFirm = blankFirmTokens(normSpan, firm);
  if (!INVESTOR_CONTEXT_TERMS.some((t) => spanSansFirm.includes(t))) return false;
  return spanReadsLikeInvestorEntry(normSpan, firmCanon, firm);
}

const EVIDENCE_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "at",
  "by",
  "is",
  "are",
  "was",
  "were",
  "with",
  "as",
  "that",
  "this",
  "it",
  "its",
  "from",
  "led",
  "has",
  "have",
  "had",
]);

function evidenceSoftMatch(
  normEvidence: string,
  normPage: string,
  firmCanon: string,
  distinctiveToken: string,
): { matched: boolean; exact: boolean } {
  const exact = normPage.includes(normEvidence);
  if (exact) return { matched: true, exact: true };
  if (firmCanon && normPage.includes(firmCanon)) {
    return { matched: true, exact: false };
  }
  if (distinctiveToken && normPage.includes(distinctiveToken)) {
    return { matched: true, exact: false };
  }
  const evTokens = normEvidence
    .split(" ")
    .filter((t) => t.length >= 3 && !EVIDENCE_STOPWORDS.has(t));
  let shared = 0;
  for (const t of evTokens) {
    if (boundedIncludes(normPage, t)) {
      shared += 1;
      if (shared >= 2) return { matched: true, exact: false };
    }
  }
  return { matched: false, exact: false };
}

export type GroundingResult = {
  kept: FundraisingInvestor[];
  dbCount: number;
  webVerified: number;
  webDropped: number;
  provenanceDropped: number;
  evidenceParaphrased: number;
  merged: number;
  dropped: string[];
  frozenIdentityKeys: ReadonlyMap<FundraisingInvestor, string>;
};

const DROP_REASON = {
  web: "couldn't confirm it on a page this run actually fetched",
  provenance:
    "claimed the investor database, which never returned it — and no fetched page confirmed it either",
} as const;

function droppedLabel(inv: FundraisingInvestor, reason: string): string {
  const firm = (inv.firm ?? "").toString().trim().slice(0, 120);
  const name = (inv.name ?? "").toString().trim().slice(0, 80);
  return `${firm || name || "an unnamed row"} — ${reason}`;
}

export function groundAndDedupInvestors(
  investors: FundraisingInvestor[],
  getText: (url: string) => string | null,
  isDbVerified: (firm: string, name: string) => boolean = () => false,
): GroundingResult {
  let dbCount = 0;
  let webVerified = 0;
  let webDropped = 0;
  let provenanceDropped = 0;
  let evidenceParaphrased = 0;
  const dropped: string[] = [];

  const passesWebEvidence = (
    inv: FundraisingInvestor,
  ): { ok: boolean; paraphrased: boolean } => {
    const url = (inv.source_url ?? "").trim();
    if (!url) return { ok: false, paraphrased: false };
    const pageText = getText(url);
    if (pageText === null) return { ok: false, paraphrased: false };
    const evidence = (inv.evidence_text ?? "").trim();
    if (evidence.length < MIN_EVIDENCE_LEN) return { ok: false, paraphrased: false };
    const normEvidence = normalizeText(evidence);
    const normPage = normalizeText(pageText);

    const haystack = normalizeText(`${evidence} ${pageText}`);
    const firmCanon = canonicalFirm(inv.firm ?? "");
    const nameNorm = normalizeName(inv.name ?? "");
    const isFirmRow = (inv.firm ?? "").trim().length > 0;

    if (isFirmRow) {
      const firmHit =
        firmCanon.length >= MIN_FIRM_MATCH_LEN && boundedIncludes(normPage, firmCanon);
      if (!firmHit) return { ok: false, paraphrased: false };
      if (!passesFirmContextGuard(inv.firm ?? "", firmCanon, url, normPage)) {
        return { ok: false, paraphrased: false };
      }
      if (!passesRolePredicate(inv.source_kind, inv.evidence_span ?? "", normPage, firmCanon, inv.firm ?? "")) {
        return { ok: false, paraphrased: false };
      }
      if (nameNorm.length >= MIN_NAME_MATCH_LEN) {
        const partnerOnPage = boundedIncludes(normPage, nameNorm);
        if (!partnerOnPage) inv.name = "";
      } else if ((inv.name ?? "").trim().length > 0) {
        inv.name = "";
      }
      const distinctive = firmDistinctiveness(inv.firm ?? "").token;
      const ev = evidenceSoftMatch(normEvidence, normPage, firmCanon, distinctive);
      if (!ev.matched) return { ok: false, paraphrased: false };
      return { ok: true, paraphrased: !ev.exact };
    }

    if (!normPage.includes(normEvidence)) return { ok: false, paraphrased: false };
    const nameHit =
      nameNorm.length >= MIN_NAME_MATCH_LEN &&
      isMultiTokenPersonName(nameNorm) &&
      !nameHasFinanceStopToken(nameNorm) &&
      boundedIncludes(haystack, nameNorm);
    return { ok: nameHit, paraphrased: false };
  };

  const grounded: FundraisingInvestor[] = [];
  const preBlankKey = new Map<FundraisingInvestor, string>();
  const frozenIdentityKeys = new Map<FundraisingInvestor, string>();
  for (const inv of investors) {
    preBlankKey.set(inv, dedupKey(inv));
    frozenIdentityKeys.set(
      inv,
      materializeIdentityKey(inv.firm ?? "", inv.name ?? ""),
    );
    if (inv.source !== "web") {
      if (isDbVerified(inv.firm ?? "", inv.name ?? "")) {
        dbCount += 1;
        grounded.push(inv);
        continue;
      }
      const ev = passesWebEvidence(inv);
      if (ev.ok) {
        webVerified += 1;
        if (ev.paraphrased) evidenceParaphrased += 1;
        grounded.push(inv);
      } else {
        provenanceDropped += 1;
        dropped.push(droppedLabel(inv, DROP_REASON.provenance));
      }
      continue;
    }
    const ev = passesWebEvidence(inv);
    if (ev.ok) {
      webVerified += 1;
      if (ev.paraphrased) evidenceParaphrased += 1;
      grounded.push(inv);
    } else {
      webDropped += 1;
      dropped.push(droppedLabel(inv, DROP_REASON.web));
    }
  }

  const byKey = new Map<string, FundraisingInvestor>();
  let merged = 0;
  for (const inv of grounded) {
    const key = preBlankKey.get(inv) ?? dedupKey(inv);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, inv);
      continue;
    }
    merged += 1;
    const existingIsDb = existing.source !== "web";
    const incomingIsDb = inv.source !== "web";
    if (!existingIsDb && incomingIsDb) {
      byKey.set(key, inv);
    }
  }

  const kept = Array.from(byKey.values());
  const keptFrozenKeys = new Map<FundraisingInvestor, string>();
  for (const inv of kept) {
    const k = frozenIdentityKeys.get(inv);
    if (k !== undefined) keptFrozenKeys.set(inv, k);
  }

  return {
    kept,
    dbCount,
    webVerified,
    webDropped,
    provenanceDropped,
    evidenceParaphrased,
    merged,
    dropped,
    frozenIdentityKeys: keptFrozenKeys,
  };
}

function investorRow(inv: FundraisingInvestor): string {
  const cells = [
    String(inv.tier),
    inv.firm ?? "",
    inv.name ?? "",
    inv.focus ?? "",
    inv.stage_focus ?? "",
    inv.check_size ?? "",
    inv.fit_rationale ?? "",
    inv.contact_hint ?? "",
    inv.suggested_message ?? "",
  ];
  return cells.map(csvField).join(",");
}

function buildCsv(investors: FundraisingInvestor[]): string {
  const sorted = [...investors].sort((a, b) => a.tier - b.tier);
  const lines = [
    CSV_HEADERS.map(csvField).join(","),
    ...sorted.map(investorRow),
  ];
  return lines.join("\r\n");
}

function mdEscape(s: string): string {
  return (s ?? "").replace(/([\\`*_[\]<>])/g, "\\$1").replace(/\s+/g, " ").trim();
}

function renderTieredMarkdown(
  kept: FundraisingInvestor[],
  droppedCount: number,
  stage?: string,
  stageRationale?: string,
): string {
  const TIER_LABEL: Record<number, string> = {
    1: "Tier 1 — best fit",
    2: "Tier 2 — solid",
    3: "Tier 3 — broad / long-shot",
  };
  const lines: string[] = [];
  const stageClean = mdEscape(stage ?? "");
  if (stageClean) {
    const rationale = mdEscape(stageRationale ?? "");
    lines.push(
      `**Stage: ${stageClean}**${rationale ? ` — ${rationale}` : ""}`,
      "_If this isn't the round you're raising, tell me and I'll re-tier the list._",
      "",
    );
  }
  lines.push("## Investor shortlist", "");
  for (const tier of [1, 2, 3] as const) {
    const rows = kept.filter((i) => i.tier === tier);
    if (rows.length === 0) continue;
    lines.push(`### ${TIER_LABEL[tier]}`, "");
    for (const inv of rows) {
      const firm = mdEscape(inv.firm ?? "") || "(unnamed firm)";
      const name = mdEscape(inv.name ?? "");
      const who = name ? `${firm} — ${name}` : firm;
      const rationale = mdEscape(inv.fit_rationale ?? "");
      const tail = rationale ? ` — ${rationale}` : "";
      lines.push(`- **${who}**${tail}`);
    }
    lines.push("");
  }
  lines.push(
    `_(${droppedCount} web-discovered investor${droppedCount === 1 ? " was" : "s were"} dropped — could not verify on a real page.)_`,
  );
  return lines.join("\n").trim();
}

const EMAIL_TOKEN_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const GENERIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "ymail.com",
  "proton.me",
  "protonmail.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "gmx.com",
  "mail.com",
]);

function emailMatchToSiteOrDrop(match: string): string {
  const at = match.lastIndexOf("@");
  if (at < 0) return " ";
  const domain = match
    .slice(at + 1)
    .toLowerCase()
    .replace(/[.,;:]+$/, "");
  if (!domain || GENERIC_MAIL_DOMAINS.has(domain)) return " ";
  return ` ${domain} `;
}

export function stripFabricatedEmails(value: string): string {
  const v0 = value ?? "";
  if (v0.indexOf("@") === -1) return v0;
  let v = v0.replace(EMAIL_TOKEN_RE, (m) => emailMatchToSiteOrDrop(m));
  v = v.replace(/\s+/g, " ");
  v = v
    .replace(/\s*[\/,;|]\s*[\/,;|]\s*/g, " / ")
    .replace(/^\s*[\/,;|]+\s*/, "")
    .replace(/\s*[\/,;|]+\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return v;
}

const EXCLUDED_HEADING_RE =
  /(^|\n)(#{2,4})\s*[^\n]*(exclud|did not qualify|didn'?t qualify|not a fit|do not fit|skip)[^\n]*\n[\s\S]*?(?=\n#{1,4}\s|\n*$)/i;

function extractExcludedSection(originalMd: string): string {
  const m = (originalMd ?? "").match(EXCLUDED_HEADING_RE);
  if (!m) return "";
  return m[0].replace(/^\n+/, "").trim();
}

async function fundraisingPipelineEnabled(): Promise<boolean> {
  try {
    const { data, error } = await serviceClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    return (data?.blob ?? {}).fundraising_pipeline === true;
  } catch {
    return false;
  }
}

export function resolveAdviceTopic(
  advice: FundraisingAdvice | undefined,
  payload: unknown,
): FundraisingAdviceTopicValue | undefined {
  if (!advice) return undefined;

  const present: FundraisingAdviceTopicValue[] = [];
  if ((advice.readiness?.length ?? 0) > 0) present.push("readiness");
  if (advice.round_design) present.push("round_design");
  if (advice.meeting_prep) present.push("meeting_prep");
  if (advice.objection_answer) present.push("objection");

  if (present.length > 1) return undefined;

  const blockTopic = present.length === 1 ? present[0] : undefined;
  const agrees = (t: FundraisingAdviceTopicValue) => !blockTopic || blockTopic === t;

  if (advice.topic) return agrees(advice.topic) ? advice.topic : undefined;

  const raw = (payload as { advice_topic?: unknown } | null | undefined)?.advice_topic;
  const fromPayload = ADVICE_TOPICS.find((t) => t === raw);
  if (fromPayload) return agrees(fromPayload) ? fromPayload : undefined;

  return blockTopic;
}

export type DeepDossierResult = {
  personVerified: boolean;
  sourcesKept: number;
  sourcesDropped: number;
  draftStripped: boolean;
  emailScrubbed: boolean;
};

export function processDeepDossier(
  dossier: FundraisingDeepDossier,
  getText: (url: string) => string | null,
): DeepDossierResult {
  const pages: string[] = [];
  const keptSources: FundraisingDeepSource[] = [];
  let sourcesDropped = 0;
  for (const s of dossier.sources ?? []) {
    const url = (s.url ?? "").trim();
    const text = url ? getText(url) : null;
    if (text === null) {
      sourcesDropped += 1;
      continue;
    }
    pages.push(normalizeText(text));
    keptSources.push({ url, claim: stripFabricatedEmails(s.claim ?? "") });
  }
  dossier.sources = keptSources;

  const nameNorm = normalizeName(dossier.name ?? "");
  const personVerified =
    nameNorm.length >= MIN_NAME_MATCH_LEN &&
    isMultiTokenPersonName(nameNorm) &&
    !nameHasFinanceStopToken(nameNorm) &&
    pages.some((p) => boundedIncludes(p, nameNorm));

  let draftStripped = false;
  const before = {
    who: dossier.who_they_are ?? "",
    why: dossier.why_this_company ?? "",
    draft: dossier.draft_message ?? "",
  };
  if (!personVerified) {
    draftStripped = before.draft.trim().length > 0;
    dossier.name = "";
    dossier.draft_message = "";
    dossier.no_draft_reason = DEEP_NO_PERSON_REFUSAL;
  } else {
    dossier.draft_message = stripFabricatedEmails(before.draft);
    dossier.no_draft_reason = "";
  }

  dossier.who_they_are = stripFabricatedEmails(before.who);
  dossier.why_this_company = stripFabricatedEmails(before.why);
  if (dossier.how_to_reach) {
    dossier.how_to_reach.warm_path = stripFabricatedEmails(
      dossier.how_to_reach.warm_path ?? "",
    );
    dossier.how_to_reach.best_channel = stripFabricatedEmails(
      dossier.how_to_reach.best_channel ?? "",
    );
    dossier.how_to_reach.who_to_go_through = stripFabricatedEmails(
      dossier.how_to_reach.who_to_go_through ?? "",
    );
  }
  dossier.pushbacks = (dossier.pushbacks ?? []).map((p) => ({
    objection: stripFabricatedEmails(p.objection ?? ""),
    honest_answer: stripFabricatedEmails(p.honest_answer ?? ""),
  }));

  const emailScrubbed =
    dossier.who_they_are !== before.who ||
    dossier.why_this_company !== before.why ||
    (personVerified && dossier.draft_message !== before.draft);

  return {
    personVerified,
    sourcesKept: keptSources.length,
    sourcesDropped,
    draftStripped,
    emailScrubbed,
  };
}

export function renderDeepDossierMarkdown(
  dossier: FundraisingDeepDossier,
): string {
  const firm = mdEscape(dossier.firm ?? "");
  const name = mdEscape(dossier.name ?? "");
  const heading = name ? `${name} — ${firm}` : firm || "Investor";
  const out: string[] = [`# Deep dossier: ${heading}`];

  const section = (title: string, body: string) => {
    out.push(`\n## ${title}\n\n${body.trim() || "_Nothing verified on this._"}`);
  };

  section("Who they are", dossier.who_they_are ?? "");
  section("Why this company", dossier.why_this_company ?? "");

  const reach = dossier.how_to_reach;
  const reachLines: string[] = [];
  if ((reach?.warm_path ?? "").trim()) {
    reachLines.push(`- Warm path: ${reach?.warm_path?.trim()}`);
  }
  if ((reach?.best_channel ?? "").trim()) {
    reachLines.push(`- Best channel: ${reach?.best_channel?.trim()}`);
  }
  if ((reach?.who_to_go_through ?? "").trim()) {
    reachLines.push(`- Who to go through: ${reach?.who_to_go_through?.trim()}`);
  }
  section(
    "How to reach them",
    reachLines.length ? reachLines.join("\n") : "No warm path found.",
  );

  const draft = (dossier.draft_message ?? "").trim();
  section(
    "Draft first message",
    draft || (dossier.no_draft_reason ?? "").trim() || DEEP_NO_PERSON_REFUSAL,
  );

  const pushbacks = (dossier.pushbacks ?? []).filter(
    (p) => (p.objection ?? "").trim() || (p.honest_answer ?? "").trim(),
  );
  section(
    "What they'll push back on",
    pushbacks.length
      ? pushbacks
          .map(
            (p) =>
              `- **${(p.objection ?? "").trim() || "Pushback"}** — ${(p.honest_answer ?? "").trim() || "No honest answer grounded yet."}`,
          )
          .join("\n")
      : "Nothing specific surfaced.",
  );

  const sources = dossier.sources ?? [];
  section(
    "Sources",
    sources.length
      ? sources
          .map((s) => {
            const claim = (s.claim ?? "").trim();
            const url = mdEscape(s.url ?? "");
            return claim ? `- ${url} — ${claim}` : `- ${url}`;
          })
          .join("\n")
      : "No page cited here was fetched this run, so nothing here is sourced.",
  );

  return out.join("\n");
}

function dispatchedDeep(payload: unknown): boolean {
  return (payload as { mode?: unknown } | null | undefined)?.mode === "deep";
}

export const fundraisingPostProcess: PostProcessorFn = async (ctx, result, payload) => {
  if (!result.parse_ok || !result.parsed) return;

  const parsed = fundraisingEnvelopeSchema.safeParse(result.parsed);
  if (!parsed.success) {
    console.warn(
      `[fundraising post-run] block re-parse failed (run_id=${ctx.runId}); skipping CSV`,
    );
    return;
  }
  const env = parsed.data;

  const effectiveMode = dispatchedDeep(payload) ? "deep" : env.mode;

  if (effectiveMode === "strategy") {
    let scrubbed = 0;
    for (const inv of env.investors) {
      const beforeContact = inv.contact_hint ?? "";
      const afterContact = stripFabricatedEmails(beforeContact);
      if (afterContact !== beforeContact) {
        inv.contact_hint = afterContact;
        scrubbed += 1;
      }
      inv.suggested_message = stripFabricatedEmails(inv.suggested_message ?? "");
      const cv = inv.copy_variants;
      if (cv) {
        if (cv.cold_email) {
          cv.cold_email.subject = stripFabricatedEmails(cv.cold_email.subject ?? "");
          cv.cold_email.body = stripFabricatedEmails(cv.cold_email.body ?? "");
        }
        cv.warm_intro_blurb = stripFabricatedEmails(cv.warm_intro_blurb ?? "");
        cv.linkedin_dm = stripFabricatedEmails(cv.linkedin_dm ?? "");
        cv.followup_1 = stripFabricatedEmails(cv.followup_1 ?? "");
        cv.followup_2 = stripFabricatedEmails(cv.followup_2 ?? "");
      }
    }
    (result.parsed as { investors?: unknown; gated?: boolean }).investors = env.investors;
    (result.parsed as { gated?: boolean }).gated = true;
    console.log(
      `[fundraising post-run] strategy mode (run_id=${ctx.runId}): ` +
        `investors=${env.investors.length} email_scrubbed=${scrubbed}; ` +
        `skipping CSV + materialize (display-only)`,
    );
    return;
  }

  if (effectiveMode === "advise") {
    const advice = env.advice;
    const topic = resolveAdviceTopic(advice, payload);
    if (advice && topic) advice.topic = topic;

    (result.parsed as { advice?: unknown }).advice = advice ?? null;
    (result.parsed as { investors?: unknown; gated?: boolean }).investors = [];
    (result.parsed as { gated?: boolean }).gated = true;

    const readinessJson =
      topic === "readiness" && advice && (advice.readiness?.length ?? 0) > 0
        ? {
            dimensions: advice.readiness,
            dos: advice.dos ?? [],
            donts: advice.donts ?? [],
          }
        : null;
    const roundDesignJson =
      topic === "round_design" && advice?.round_design ? advice.round_design : null;

    let snapshotPersisted = false;
    if (readinessJson || roundDesignJson) {
      try {
        const { error } = await serviceClient().rpc("fundraising_set_raise_snapshot", {
          p_tenant_id: ctx.tenant_id,
          p_readiness: readinessJson,
          p_round_design: roundDesignJson,
          p_run_id: ctx.runId,
        });
        if (error) {
          console.warn(
            `[fundraising post-run] advise snapshot persist failed (run_id=${ctx.runId}): ${error.message}`,
          );
        } else {
          snapshotPersisted = true;
        }
      } catch (e) {
        console.warn(
          `[fundraising post-run] advise snapshot persist threw (run_id=${ctx.runId}): ${(e as Error).message}`,
        );
      }
    }

    console.log(
      `[fundraising post-run] advise mode (run_id=${ctx.runId}): topic=${topic ?? "none"} ` +
        `readiness_dims=${advice?.readiness?.length ?? 0} snapshot_persisted=${snapshotPersisted}; ` +
        `skipping grounding gate + CSV + materialize (guidance-only)`,
    );
    return;
  }

  if (effectiveMode === "deep") {
    const dossier = env.deep;
    if (!dossier) {
      (result.parsed as { deep?: unknown }).deep = null;
      (result.parsed as { investors?: unknown; gated?: boolean }).investors = [];
      (result.parsed as { gated?: boolean }).gated = true;
      console.log(
        `[fundraising post-run] deep mode (run_id=${ctx.runId}): no deep block in envelope; nothing rendered`,
      );
      return;
    }

    const deepResult = processDeepDossier(dossier, (url) =>
      getCapturedText(ctx.runId, url),
    );

    const md = renderDeepDossierMarkdown(dossier);
    (result.parsed as { rendered_markdown?: unknown }).rendered_markdown = md;
    result.output_text = md;

    (result.parsed as { deep?: unknown }).deep = dossier;
    (result.parsed as { investors?: unknown; gated?: boolean }).investors = [];
    (result.parsed as { gated?: boolean }).gated = true;

    console.log(
      `[fundraising post-run] deep mode (run_id=${ctx.runId}): ` +
        `person_verified=${deepResult.personVerified} sources_kept=${deepResult.sourcesKept} ` +
        `sources_dropped=${deepResult.sourcesDropped} draft_stripped=${deepResult.draftStripped} ` +
        `email_scrubbed=${deepResult.emailScrubbed}; skipping CSV + materialize (dossier-only)`,
    );
    return;
  }

  if (env.investors.length === 0) {
    console.log(
      `[fundraising post-run] no investors in block (run_id=${ctx.runId}); skipping CSV`,
    );
    return;
  }

  const gate = groundAndDedupInvestors(
    env.investors,
    (url) => getCapturedText(ctx.runId, url),
    (firm, name) => isFromInvestorDb(ctx.runId, firm, name),
  );

  const ledgerEmpty = investorDbLedgerSize(ctx.runId) === 0;
  const hadDbLabeledRows = env.investors.some((i) => i.source !== "web");

  console.log(
    `[fundraising post-run] grounding gate (run_id=${ctx.runId}): ` +
      `db=${gate.dbCount} web_verified=${gate.webVerified} web_dropped=${gate.webDropped} ` +
      `provenance_dropped=${gate.provenanceDropped} evidence_paraphrased=${gate.evidenceParaphrased} ` +
      `merged=${gate.merged}` +
      (ledgerEmpty && hadDbLabeledRows
        ? " [WARN: investor_db result ledger EMPTY but block had investor_db-labeled rows — possible recorder misfire; rows were NOT trusted, they ran the web-evidence gate]"
        : ""),
  );

  const totalDropped = gate.webDropped + gate.provenanceDropped;

  if (gate.kept.length === 0) {
    const safeMsg =
      "No investors could be verified against a real source for this search. Nothing was added to the list.";
    const p = result.parsed as { rendered_markdown?: unknown };
    p.rendered_markdown = safeMsg;
    result.output_text = safeMsg;
    (result.parsed as { investors?: unknown; gated?: boolean }).investors = [];
    (result.parsed as { gated?: boolean }).gated = true;
    (result.parsed as { merge?: unknown }).merge = {
      added: 0,
      already_saved: 0,
      dropped: gate.dropped,
    };
    console.log(
      `[fundraising post-run] no investors survived the grounding gate (run_id=${ctx.runId}); ` +
        `scrubbed chat (dropped=${totalDropped}); skipping CSV`,
    );
    return;
  }

  let emailScrubbed = 0;
  for (const inv of gate.kept) {
    const beforeContact = inv.contact_hint ?? "";
    const afterContact = stripFabricatedEmails(beforeContact);
    if (afterContact !== beforeContact) {
      inv.contact_hint = afterContact;
      emailScrubbed += 1;
    }
    const beforeMsg = inv.suggested_message ?? "";
    const afterMsg = stripFabricatedEmails(beforeMsg);
    if (afterMsg !== beforeMsg) inv.suggested_message = afterMsg;
  }
  if (emailScrubbed > 0) {
    console.log(
      `[fundraising post-run] scrubbed fabricated emails from ${emailScrubbed} contact hint(s) (run_id=${ctx.runId})`,
    );
  }

  (result.parsed as { investors?: unknown; gated?: boolean }).investors = gate.kept;
  (result.parsed as { gated?: boolean }).gated = true;

  if (totalDropped > 0) {
    const p = result.parsed as { rendered_markdown?: unknown };
    const excluded = extractExcludedSection(
      typeof p.rendered_markdown === "string" ? p.rendered_markdown : "",
    );
    let rebuilt = renderTieredMarkdown(
      gate.kept,
      totalDropped,
      env.stage,
      env.stage_rationale,
    );
    if (excluded) rebuilt = `${rebuilt}\n\n${excluded}`;
    p.rendered_markdown = rebuilt;
    result.output_text = rebuilt;
  }

  const date = new Date().toISOString().slice(0, 10);
  const filename = `investor-list-${date}.csv`;
  const csv = buildCsv(gate.kept);

  try {
    await deliverCsv({ tenant_id: ctx.tenant_id, run_id: ctx.runId }, { filename, csv });
    console.log(
      `[fundraising post-run] stored CSV of ${gate.kept.length} investors (run_id=${ctx.runId})`,
    );
  } catch (e) {
    console.warn(
      `[fundraising post-run] deliverCsv failed (run_id=${ctx.runId}): ${(e as Error).message}`,
    );
  }

  let mergeCounts: MaterializeSummary | null = null;
  try {
    if (await fundraisingPipelineEnabled()) {
      mergeCounts = await materializeInvestors(
        ctx.tenant_id,
        gate.kept,
        undefined,
        gate.frozenIdentityKeys,
      );
    }
  } catch (e) {
    mergeCounts = null;
    console.warn(
      `[fundraising post-run] materialize failed (run_id=${ctx.runId}): ${(e as Error).message}`,
    );
  }

  if (mergeCounts) {
    (result.parsed as { merge?: unknown }).merge = {
      added: mergeCounts.added,
      already_saved: mergeCounts.already_saved,
      dropped: gate.dropped,
    };
  }
};

export const __test__ = {
  buildCsv,
  csvField,
  groundAndDedupInvestors,
  canonicalFirm,
  dedupKey,
  normalizeText,
  renderTieredMarkdown,
  firmDistinctiveness,
  passesFirmContextGuard,
  evidenceSoftMatch,
  passesRolePredicate,
  spanReadsLikeInvestorEntry,
  stripFabricatedEmails,
  extractExcludedSection,
  processDeepDossier,
  renderDeepDossierMarkdown,
};
