
import * as parse5 from "parse5";
import { OPSEC_FOOTER } from "./opsec-footer";
import { CITATION_INSTRUCTION } from "./citation-parser";
import { agentCapabilities } from "./agent-capabilities";
import { INTERNAL_TOOL_NAMES } from "@/services/mcp/internal-tool-names";
import { ENCODED_EMAIL_RE, OBFUSCATED_EMAIL_RE, keptEmailsFor, replaceEmails } from "./egress-email-provenance";

export type EgressSurface =
  | "chat"
  | "persist"
  | "mcp"
  | "error"
  | "slack"
  | "batch"
  | "other";

export type ScrubResult = {
  text: string;
  hits: number;
  families: Array<"system_prompt_fragment" | "impl_symbol" | "pii" | "transient_failure">;
};

export type ScrubOpts = {
  agentSlug?: string;
  surface: EgressSurface;
  scrubPii?: boolean;
  artifactIdDenylist?: readonly string[];
  keepEmails?: readonly string[];
};

export const PII_SCRUB_AGENT_SLUGS: ReadonlySet<string> = new Set([
  "cgo",
  "pm",
  "chief-of-staff",
  "support-lead",
  "dispute-response",
  "growth-lead",
  "performance-marketer",
  "email_marketing",
]);

const PII_SCRUB_DERIVE_EXCLUDE: ReadonlySet<string> = new Set([
  "operator",
  "advisor",
]);

export function isPiiScrubAgent(slug: string): boolean {
  if (PII_SCRUB_AGENT_SLUGS.has(slug)) return true;
  if (PII_SCRUB_DERIVE_EXCLUDE.has(slug)) return false;
  return agentCapabilities(slug).reads_operator_db === true;
}

const PII_SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const PII_CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PII_PHONE = /(?:\+?\d[\d ().-]{8,}\d)/g;

function piiDigits(s: string): string {
  return s.replace(/\D/g, "");
}

function luhnValid(d: string): boolean {
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function scrubPiiPatterns(
  text: string,
  keep?: ReadonlySet<string>,
): { text: string; hits: number } {
  if (!text) return { text, hits: 0 };
  let hits = 0;
  const bump = () => {
    hits++;
    return PII_REDACTION;
  };
  const email = (m: string) => (keep?.has(m.toLowerCase()) ? m : bump());
  const out = replaceEmails(text, email)
    .replace(ENCODED_EMAIL_RE, bump)
    .replace(OBFUSCATED_EMAIL_RE, bump)
    .replace(PII_SSN, bump)
    .replace(PII_CARD, (m) => (luhnValid(piiDigits(m)) ? bump() : m))
    .replace(PII_PHONE, (m) => {
      const n = piiDigits(m).length;
      if (n < 10) return m;
      if (n <= 15) return bump();
      const seps = (m.match(/[ .()\-]/g) || []).length;
      return /[+()]/.test(m) || seps >= 2 ? bump() : m;
    });
  return { text: out, hits };
}

const REDACTION = "a tool";

const PII_REDACTION = "[redacted]";

const ATTRIBUTION_LEAD =
  /^(?:via|from|using|used|per|source|sourced\s+from|through|data\s+from|based\s+on|pulled\s+from|according\s+to)\b/i;

const NESTED_PARENTHETICAL = /\((?:[^()]|\([^()]*\))*\)/g;

function suppressRedactionMarkerRendering(text: string): string {
  if (!text) return text;
  const markerEsc = REDACTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasMarker = new RegExp("\\b" + markerEsc + "\\b", "i");
  if (!hasMarker.test(text)) return text;

  const markerWithCall = new RegExp("\\b" + markerEsc + "\\b(?:\\([^()]*\\))?", "gi");

  let out = text.replace(NESTED_PARENTHETICAL, (m) => {
    const inner = m.slice(1, -1).trim().replace(/^[`*_\s]+/, "");
    if (!hasMarker.test(inner)) return m;
    if (!ATTRIBUTION_LEAD.test(inner)) return m;

    const residue = inner
      .replace(ATTRIBUTION_LEAD, "")
      .replace(markerWithCall, "")
      .replace(/[`*_+,;:—–-]/g, " ")
      .trim();
    const words = residue.split(/\s+/).filter(Boolean);
    const carriesContent = /\d/.test(residue) || words.length >= 4;
    return carriesContent ? m : "";
  });

  out = out.replace(new RegExp("`\\s*" + markerEsc + "\\s*`", "gi"), REDACTION);

  return out
    .replace(/[ \t]+([),.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "");
}

const CORPUS_SHINGLE_N = 12;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "that",
  "this", "is", "are", "be", "as", "at", "by", "it", "your", "you", "do", "not",
  "if", "any", "no", "we", "i", "so", "but", "from", "into", "out", "up",
]);
const MIN_DISTINCT_TOKENS = 4;

const INTERNAL_TOOL_SYMBOL_RE = new RegExp(
  `\\b(?:${[...INTERNAL_TOOL_NAMES]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\b`,
  "gi",
);

const IMPL_SYMBOL_DENYLIST: RegExp[] = [
  /\bbuildStablePromptPrefix\b/gi,
  /\bbuildSystemPromptForTest\b/gi,
  /\bscrubAgentEgress\b/gi,
  /\bpersistTerminal\b/gi,
  /\brecord_agent_chat_reply\b/gi,
  /\bmapRowToAgentRun\b/gi,
  /\bgetAgentRunById\b/gi,
  /\bgeneric-dispatcher(?:\.ts)?\b/gi,
  /\bchat-dispatcher(?:\.ts)?\b/gi,
  /\bOPSEC_FOOTER\b/g,
  /\bprompt_snapshot\b/gi,
  /\braw_response_text\b/gi,
  /\bapps\/backend\/src\/services\/agents\b/gi,
  /@modelcontextprotocol\/sdk/gi,
  /@anthropic-ai\/sdk/gi,
  /\bclaude-(?:opus|sonnet|haiku)-[0-9][\w.-]*/gi,
  /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)*praxis\.(?:build|ai)\b/gi,
  /\b(?:operator_db|memory|slack|stripe|github|jira|linear|meta_ads|google_ads|chatgpt_ads|web_search|web_fetch|praxis|composio|paid_acquisition|qa_engineer|growth|report)__[a-z_]+\b/gi,
  INTERNAL_TOOL_SYMBOL_RE,
  /mcp__[a-z0-9_]+__[a-z0-9_]+/gi,
  /\bToolSearch\b/g,
];

export const NEVER_REDACT_TERMS: readonly string[] = [
  "operator", "chief-of-staff", "engineer", "pm", "qa", "research", "advisor",
  "growth-lead", "performance-marketer", "dispute-response", "support-lead",
  "handoff", "hand off", "specialist", "delegate",
  "Slack", "GitHub", "Stripe", "Supabase", "Inngest",
];

function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function buildCorpusShingles(): Set<string> {
  const set = new Set<string>();
  const corpus = `${OPSEC_FOOTER}\n${CITATION_INSTRUCTION}`;
  const toks = normalizeTokens(corpus);
  for (let i = 0; i + CORPUS_SHINGLE_N <= toks.length; i++) {
    const window = toks.slice(i, i + CORPUS_SHINGLE_N);
    set.add(window.join(" "));
  }
  return set;
}
const CORPUS_SHINGLES = buildCorpusShingles();

function distinctNonStopwordCount(tokens: string[]): number {
  const seen = new Set<string>();
  for (const t of tokens) if (!STOPWORDS.has(t)) seen.add(t);
  return seen.size;
}

function scrubSystemPromptFragments(text: string): { text: string; hits: number } {
  if (!text) return { text, hits: 0 };
  const tokenRe = /[A-Za-z0-9]+/g;
  const toks: { norm: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    toks.push({ norm: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  if (toks.length < CORPUS_SHINGLE_N) return { text, hits: 0 };

  const ranges: Array<[number, number]> = [];
  for (let i = 0; i + CORPUS_SHINGLE_N <= toks.length; i++) {
    const windowToks = toks.slice(i, i + CORPUS_SHINGLE_N);
    const key = windowToks.map((t) => t.norm).join(" ");
    if (!CORPUS_SHINGLES.has(key)) continue;
    if (distinctNonStopwordCount(windowToks.map((t) => t.norm)) < MIN_DISTINCT_TOKENS) continue;
    ranges.push([windowToks[0].start, windowToks[windowToks.length - 1].end]);
  }
  if (ranges.length === 0) return { text, hits: 0 };

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }

  let out = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    out += text.slice(cursor, start) + REDACTION;
    cursor = end;
  }
  out += text.slice(cursor);
  return { text: out, hits: merged.length };
}

function scrubImplSymbols(text: string): { text: string; hits: number } {
  if (!text) return { text, hits: 0 };
  let out = text;
  let hits = 0;
  for (const re of IMPL_SYMBOL_DENYLIST) {
    re.lastIndex = 0;
    out = out.replace(re, () => {
      hits++;
      return REDACTION;
    });
  }
  return { text: out, hits };
}

export const INTERNAL_TOOL_SERVER_PREFIXES: readonly string[] = [
  "slack", "youtube", "x_social", "instagram", "youtube_insights", "reddit", "pinterest",
  "pinterest_insights", "github", "stripe", "email", "support_inbox", "google_ads", "google_analytics",
  "google_search_console", "posthog", "reddit_ads", "email_campaign", "tiktok_ads", "linkedin_ads",
  "snapchat_ads", "spotify_ads", "pinterest_ads", "microsoft_ads", "x_ads", "apple_ads", "sentry", "figma",
  "google_sheets", "google_calendar", "supabase", "meta_ads", "buffer", "tiktok", "report", "artifacts",
  "growth", "social", "outbound", "generated_video", "creator", "seo", "geo", "memory", "brain",
  "onboarding_discovery", "operator_db", "investor_db", "investor_discovery", "paid_acquisition",
  "chatgpt_ads", "web_search", "connectors", "apify", "web_fetch", "competitor_intel", "product", "browser",
  "extension", "praxis_corpus", "jira", "linear", "qa_engineer", "code_index", "praxis", "skill",
];
const BARE_TOOL_NAME_RE = new RegExp(`\\b(?:${INTERNAL_TOOL_SERVER_PREFIXES.join("|")})__[a-z0-9_]+\\b`, "g");
const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STORAGE_PATH_RE = new RegExp(`\`?\\b${UUID_SRC}/${UUID_SRC}\\.[a-z0-9]{2,5}\\b\`?`, "gi");
const PROSE_ONLY_SPLIT_RE = /(```[\s\S]*?```|https?:\/\/\S+)/g;
const INLINE_CODE_SPLIT_RE = /(`[^`\n]+`)/g;

export function scrubToolNamesAndStoragePaths(text: string): { text: string; hits: number } {
  if (!text) return { text, hits: 0 };
  let hits = 0;
  const out = text
    .split(PROSE_ONLY_SPLIT_RE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(STORAGE_PATH_RE, () => {
              hits++;
              return "the image file";
            })
            .split(INLINE_CODE_SPLIT_RE)
            .map((piece, j) =>
              j % 2 === 1
                ? piece
                : piece.replace(BARE_TOOL_NAME_RE, () => {
                    hits++;
                    return REDACTION;
                  }),
            )
            .join(""),
    )
    .join("");
  return { text: out, hits };
}

const ARTIFACT_ANCHOR_RE =
  /\b(artifacts?(?:[_\s-]?id)?\s*[:#]?\s*|artifacts?\s+tab\b[^\n]*?\b)((?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})|(?:[0-9a-f]{8,}))\b/gi;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scrubArtifactIds(
  text: string,
  denylist?: readonly string[],
): { text: string; hits: number } {
  if (!text) return { text, hits: 0 };
  let out = text;
  let hits = 0;

  if (denylist && denylist.length > 0) {
    for (const raw of denylist) {
      const id = String(raw ?? "").trim();
      if (id.length < 8) continue;
      const re = new RegExp(`\\b${escapeRegExp(id)}\\b`, "gi");
      out = out.replace(re, () => {
        hits++;
        return REDACTION;
      });
    }
  }

  ARTIFACT_ANCHOR_RE.lastIndex = 0;
  out = out.replace(ARTIFACT_ANCHOR_RE, (_m, anchor: string) => {
    hits++;
    return `${anchor}${REDACTION}`;
  });

  return { text: out, hits };
}

type HealthRule = { re: RegExp; repl: string; scope: "all" | "slack" };

const HEALTH_PHRASE_RULES: HealthRule[] = [
  {
    re: /\b\d+\+?\s*(?:consecutive\s+)?(?:errors?|failures?)(?:\s+in\s+a\s+row)?\b/gi,
    repl: "prior issues",
    scope: "slack",
  },
  {
    re: /\b(?:error(?:ed|ing)?|fail(?:ed|ing)?)\s+(?:\d+\+?\s*times|repeatedly|continuously|over and over)\b/gi,
    repl: "prior issues",
    scope: "slack",
  },
  {
    re: /\b(?:the|a)\s+sandbox\s+(?:is\s+|keeps\s+|kept\s+|has\s+been\s+)?(?:error(?:ed|ing)?|fail(?:ed|ing)?)\b/gi,
    repl: "a prior issue",
    scope: "all",
  },
  {
    re: /\bsandbox\s+(?:is\s+|keeps\s+|kept\s+|has\s+been\s+)?(?:error(?:ed|ing)?|fail(?:ed|ing)?)\b/gi,
    repl: "a prior issue",
    scope: "all",
  },
];

export function scrubHealthPhrases(
  text: string,
  opts?: { surface?: string },
): { text: string; hits: number } {
  if (!text) return { text, hits: 0 };
  const surface = opts?.surface ?? "slack";
  const rules =
    surface === "slack"
      ? HEALTH_PHRASE_RULES
      : HEALTH_PHRASE_RULES.filter((r) => r.scope === "all");
  let out = text;
  let hits = 0;
  for (const { re, repl } of rules) {
    re.lastIndex = 0;
    out = out.replace(re, () => {
      hits++;
      return repl;
    });
  }
  if (hits > 0) {
    out = out
      .replace(/\b(an?|the)\s+(a\s+prior\s+issue)\b/gi, "$2")
      .replace(/\b(an?|the)\s+(prior\s+issues)\b/gi, "$2")
      .replace(/[ \t]{2,}/g, " ");
    out = out.replace(
      /(^|[.!?]\s+)(a prior issue|prior issues)/g,
      (_m, lead: string, frag: string) =>
        `${lead}${frag.charAt(0).toUpperCase()}${frag.slice(1)}`,
    );
  }
  return { text: out, hits };
}

const BUILD_MACHINERY_PHRASE_RULES: Array<{ re: RegExp; repl: string }> = [
  {
    re: /\b(?:internal tooling (?:confirms?|verified|shows?|says?)|(?:i )?(?:checked|verified)(?: this| that)? via internal tooling)\b/gi,
    repl: "I verified",
  },
  { re: /\b(?:an?|the)\s+e2b\s+sandbox\b/gi, repl: "the build environment" },
  { re: /\be2b\s+sandbox\b/gi, repl: "the build environment" },
  { re: /\be2b\b/gi, repl: "the build service" },
  { re: /\bapp_verify\b/gi, repl: "the smoke-test check" },
  {
    re: /\b(?:boot_reap|stale_reap|watchdog_reap)\b/gi,
    repl: "an internal recovery step",
  },
  {
    re: /\b(?:deps|dependencies)\s+(?:were\s+)?(?:not|n'?t)\s+installed\s+in\s+the\s+sandbox\b/gi,
    repl: "the environment wasn't fully set up",
  },
  { re: /\bstanding\s+sandbox\s+constraints?\b/gi, repl: "environment limits" },
];

export function scrubBuildMachineryNarration(
  text: string,
): { text: string; hits: number } {
  if (!text) return { text, hits: 0 };
  let out = text;
  let hits = 0;
  for (const { re, repl } of BUILD_MACHINERY_PHRASE_RULES) {
    re.lastIndex = 0;
    out = out.replace(re, () => {
      hits++;
      return repl;
    });
  }
  if (hits > 0) out = out.replace(/\bthe\s+the\b/gi, "the").replace(/[ \t]{2,}/g, " ");
  return { text: out, hits };
}

function transientScrubMode(): "rewrite" | "log" | "off" {
  const v = (process.env.EGRESS_TRANSIENT_SCRUB ?? "rewrite").toLowerCase();
  return v === "rewrite" || v === "off" ? v : "log";
}

const TRANSIENT_FAILURE_PHRASE_RULES: Array<{ re: RegExp; repl: string }> = [
  {
    re: /\s*\((?:the\s+)?(?:github\s+)?(?:code\s+)?search[^)]*?\b(?:rate.?limit(?:ed)?|budget|mid-run)\b[^)]*\)/gi,
    repl: "",
  },
  {
    re: /\b(?:I|we)(?:'ve)?\s+(?:hit|reached|ran into|got)\s+(?:the|my|our)?\s*(?:github\s+)?(?:code\s+)?(?:search|read|file-read|tool|iteration)?\s*(?:budget(?:\s+(?:limit|ceiling|cap))?|rate.?limit)[^.;\n]*/gi,
    repl: "I couldn't finish a code search for that part",
  },
  {
    re: /\b(?:github\s+)?(?:code\s+)?search\s+(?:was\s+|got\s+|is\s+)?rate.?limited(?:\s+mid-run)?/gi,
    repl: "code search was briefly unavailable",
  },
  {
    re: /\b(?:search_code|code\s+search)\b[^.;\n]*?\bHTTP\s+4\d\d\b[^.;\n]*/gi,
    repl: "a connected-repo lookup didn't complete",
  },
  {
    re: /\bsearch\s+budget\s+(?:limit|exhausted|cap(?:ped)?)[^.;\n]*/gi,
    repl: "a code-search limit",
  },
];

export function scrubTransientFailurePhrases(text: string): { text: string; hits: number } {
  if (!text) return { text, hits: 0 };
  let out = text;
  let hits = 0;
  for (const { re, repl } of TRANSIENT_FAILURE_PHRASE_RULES) {
    re.lastIndex = 0;
    out = out.replace(re, () => {
      hits++;
      return repl;
    });
  }
  if (hits > 0) {
    out = out
      .replace(/\(\s*\)/g, "")
      .replace(/\s+([.,;:])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }
  return { text: out, hits };
}

export { rewriteBrandLeak } from "./brand-rewrite";
import { rewriteBrandLeak, redactZaviArchitectureLeak } from "./brand-rewrite";

const CHAR_REF_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

function decodeNamedRef(ref: string): string | undefined {
  const node = parse5.parseFragment(ref).childNodes[0] as { nodeName?: string; value?: string } | undefined;
  return node?.nodeName === "#text" && typeof node.value === "string" && node.value !== ref ? node.value : undefined;
}

export function decodePlainCharRefs(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHAR_REF_RE, (m, dec, hex, name) => {
    let ch: string | undefined;
    if (name) ch = decodeNamedRef(m);
    else {
      const cp = dec ? Number(dec) : parseInt(hex, 16);
      if (cp > 0 && cp <= 0x10ffff) ch = String.fromCodePoint(cp);
    }
    if (ch === undefined) return m;
    if (/^\p{Cf}$/u.test(ch)) return "";
    if (/^[\s\p{Zs}]$/u.test(ch)) return " ";
    if (/^[\p{Pd}\u2212]$/u.test(ch)) return "-";
    return /^[\p{L}\p{N}@._%+\-[\]()]$/u.test(ch) ? ch : m;
  });
}

function decodeIfItHidesPii(text: string, kept: ReturnType<typeof keptEmailsFor>): string {
  if (!text.includes("&")) return text;
  const decoded = decodePlainCharRefs(text);
  return decoded !== text && scrubPiiPatterns(decoded, kept).hits > scrubPiiPatterns(text, kept).hits ? decoded : text;
}

export function scrubAgentEgress(
  text: string | null | undefined,
  opts: ScrubOpts,
): ScrubResult {
  const families: ScrubResult["families"] = [];
  if (!text) return { text: text ?? "", hits: 0, families };

  if (opts.scrubPii) text = decodeIfItHidesPii(text, keptEmailsFor(opts.agentSlug, opts.keepEmails));

  const frag = scrubSystemPromptFragments(text);
  let working = frag.text;
  let hits = frag.hits;
  if (frag.hits > 0) families.push("system_prompt_fragment");

  const sym = scrubImplSymbols(working);
  working = sym.text;
  hits += sym.hits;
  if (sym.hits > 0) families.push("impl_symbol");

  if (opts.surface === "slack" || (opts.artifactIdDenylist?.length ?? 0) > 0) {
    const art = scrubArtifactIds(working, opts.artifactIdDenylist);
    working = art.text;
    hits += art.hits;
    if (art.hits > 0) families.push("impl_symbol");
  }
  if (opts.surface === "slack" || opts.surface === "chat") {
    const health = scrubHealthPhrases(working, { surface: opts.surface });
    working = health.text;
    hits += health.hits;
    if (health.hits > 0) families.push("impl_symbol");
    const machinery = scrubBuildMachineryNarration(working);
    working = machinery.text;
    hits += machinery.hits;
    if (machinery.hits > 0) families.push("impl_symbol");
  }

  if (
    opts.agentSlug !== "engineer" &&
    (opts.surface === "chat" ||
      opts.surface === "persist" ||
      opts.surface === "slack")
  ) {
    const brand = rewriteBrandLeak(working);
    working = brand.text;
    hits += brand.hits;
    if (brand.hits > 0) families.push("impl_symbol");

    const arch = redactZaviArchitectureLeak(working);
    working = arch.text;
    hits += arch.hits;
    if (arch.hits > 0) families.push("impl_symbol");

    const internal = scrubToolNamesAndStoragePaths(working);
    working = internal.text;
    hits += internal.hits;
    if (internal.hits > 0) families.push("impl_symbol");
  }

  const tMode = transientScrubMode();
  if (tMode !== "off") {
    const tf = scrubTransientFailurePhrases(working);
    if (tf.hits > 0) {
      families.push("transient_failure");
      hits += tf.hits;
      if (tMode === "rewrite") working = tf.text;
    }
  }

  if (opts.scrubPii) {
    working = decodeIfItHidesPii(working, keptEmailsFor(opts.agentSlug, opts.keepEmails));
    const pii = scrubPiiPatterns(working, keptEmailsFor(opts.agentSlug, opts.keepEmails));
    working = pii.text;
    hits += pii.hits;
    if (pii.hits > 0) families.push("pii");
  }

  if (hits > 0) {
    const markerEsc = REDACTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const adjacentMarkers = new RegExp(
      `${markerEsc}(?:\\s*,?\\s*(?:and\\s+)?${markerEsc})+`,
      "gi",
    );
    working = working
      .replace(adjacentMarkers, REDACTION)
      .replace(/\b(an?)\s+(a tool)\b/gi, "$2")
      .replace(/[ \t]{2,}/g, " ");

    working = suppressRedactionMarkerRendering(working);
  }

  return { text: working, hits, families };
}

export function scrubParsedOverflow(parsed: unknown, opts: ScrubOpts): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const p = parsed as Record<string, unknown>;
  const meta = p.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return parsed;
  const m = meta as Record<string, unknown>;
  const full = m.full_reply_markdown;
  if (typeof full !== "string" || full.length === 0) return parsed;
  return {
    ...p,
    metadata: { ...m, full_reply_markdown: scrubAgentEgress(full, opts).text },
  };
}

export function scrubAgentEgressWithNote(
  text: string | null | undefined,
  opts: ScrubOpts,
): ScrubResult {
  return scrubAgentEgress(text, opts);
}
