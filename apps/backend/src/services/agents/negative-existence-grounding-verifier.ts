
import {
  assertReadRepoMembership,
  resolveInstallationId,
  searchCodeImpl,
  readFileImpl,
} from "@/services/mcp/internal/github";
import { serviceClient } from "@/services/supabase";
import { removeClaimSentences } from "./side-effect-claim-reconciler";
import { getScopedRepoFullNames } from "@/services/connectors/github/scoped-repos";
import { readConnectorList } from "@/services/connectors/metadata";
import type { ToolCallTrace } from "@/services/tools/types";

const NON_BACKEND_EXTENSIONS = [
  ".swift",
  ".kt",
  ".kts",
  ".m",
  ".mm",
  ".java",
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte",
  ".dart",
  ".storyboard",
  ".xib",
] as const;

const NON_BACKEND_DIR_SEGMENTS = new Set<string>([
  "ios",
  "android",
  "mobile",
  "web",
  "frontend",
  "client",
  "__tests__",
  "__mocks__",
  "fixtures",
  "test",
  "tests",
  "e2e",
  "stories",
  "storybook",
]);

export function isBackendSubsystemPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  const lower = path.toLowerCase();
  for (const ext of NON_BACKEND_EXTENSIONS) {
    if (lower.endsWith(ext)) return false;
  }
  const segments = lower.split(/[\\/]+/).filter(Boolean);
  for (const seg of segments) {
    if (NON_BACKEND_DIR_SEGMENTS.has(seg)) return false;
    if (/\.(test|spec)\.[a-z]+$/.test(seg)) return false;
  }
  return true;
}

export type NegativeExistenceKind =
  | "endpoint"
  | "route"
  | "field"
  | "model"
  | "function"
  | "file"
  | "table"
  | "symbol";

export type NegativeExistenceClaim = {
  claim: string;
  symbol: string;
  kind: NegativeExistenceKind;
};

const CODE_CONTEXT_WORDS = [
  "endpoint",
  "route",
  "api",
  "function",
  "method",
  "handler",
  "model",
  "field",
  "column",
  "file",
  "table",
  "schema",
  "controller",
  "component",
  "module",
] as const;

const CODE_CONTEXT_RE = new RegExp(
  `\\b(${CODE_CONTEXT_WORDS.join("|")})s?\\b`,
  "i",
);

const NEGATIVE_EXISTENCE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcould\s+not\s+(?:locate|find)\b/i, "could-not-locate"],
  [/\bcouldn'?t\s+(?:locate|find)\b/i, "couldnt-find"],
  [/\b(?:is|was|are|were)?\s*not\s+implemented\b/i, "not-implemented"],
  [
    new RegExp(
      `\\bno\\s+(?:\`[^\`]+\`|[A-Za-z_][\\w./-]*)?\\s*(?:${CODE_CONTEXT_WORDS.join("|")})s?\\b`,
      "i",
    ),
    "no-kind",
  ],
  [/\bno\s+(?:`[A-Za-z_][\w./-]*`|[A-Za-z_][A-Za-z0-9_]*(?:[./-][A-Za-z0-9_]+)+|[A-Za-z_][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)\b/, "no-symbol"],
  [/\bthere\s+(?:is|are|was|were)\s+(?:also\s+)?no\b/i, "there-is-no"],
  [/\bdo(?:es)?\s+not\s+exist\b/i, "does-not-exist"],
  [/\bdoesn'?t\s+exist\b/i, "doesnt-exist"],
  [/\b(?:is|was|are|were)\s+(?:missing|absent)\b/i, "is-missing"],
  [/\bunable\s+to\s+(?:locate|find)\b/i, "unable-to-find"],
];

const AFFIRMATIVE_VERB_RE =
  /\b(confirms?|confirmed|exists?|stored|stores|returns?|returned|has|have|lists?|listed|contains?|contained|found|provides?|defines?|defined|implements?|implemented|present)\b/i;

const BACKTICK_TOKEN_RE = /`([A-Za-z_][\w./-]{1,80})`/g;
const BARE_TOKEN_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:[./-][A-Za-z0-9_]+)+|[A-Za-z_][A-Za-z0-9_]{2,80})\b/g;

const STOPWORD_TOKENS = new Set<string>([
  ...CODE_CONTEXT_WORDS,
  "the",
  "this",
  "that",
  "there",
  "could",
  "not",
  "locate",
  "find",
  "exist",
  "exists",
  "missing",
  "absent",
  "implemented",
  "rating",
  "review",
  "host",
  "reply",
  "response",
  "request",
  "current",
  "existing",
  "backend",
  "frontend",
  "repo",
  "repository",
  "codebase",
  "any",
  "such",
  "user",
  "users",
  "data",
  "config",
  "configuration",
  "value",
  "values",
  "item",
  "items",
  "object",
  "entity",
  "record",
  "records",
  "info",
  "name",
  "names",
  "type",
  "types",
  "status",
  "gate",
  "ownership",
  "owner",
  "auth",
  "permission",
  "permissions",
]);

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|;\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function kindForContext(sentence: string): NegativeExistenceKind {
  const s = sentence.toLowerCase();
  if (/\bendpoint(s)?\b/.test(s)) return "endpoint";
  if (/\broute(s)?\b/.test(s)) return "route";
  if (/\bfield(s)?\b|\bcolumn(s)?\b/.test(s)) return "field";
  if (/\bmodel(s)?\b|\bschema(s)?\b/.test(s)) return "model";
  if (/\bfunction(s)?\b|\bmethod(s)?\b|\bhandler(s)?\b/.test(s)) return "function";
  if (/\bfile(s)?\b|\bcomponent(s)?\b|\bmodule(s)?\b|\bcontroller(s)?\b/.test(s))
    return "file";
  if (/\btable(s)?\b/.test(s)) return "table";
  return "symbol";
}

function extractSymbol(sentence: string): string | null {
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  BACKTICK_TOKEN_RE.lastIndex = 0;
  while ((m = BACKTICK_TOKEN_RE.exec(sentence)) !== null) {
    const tok = m[1];
    const lower = tok.toLowerCase();
    if (STOPWORD_TOKENS.has(lower)) continue;
    candidates.push(tok);
  }
  if (candidates.length === 0) {
    BARE_TOKEN_RE.lastIndex = 0;
    while ((m = BARE_TOKEN_RE.exec(sentence)) !== null) {
      const tok = m[1];
      const lower = tok.toLowerCase();
      if (STOPWORD_TOKENS.has(lower)) continue;
      const looksLikeIdentifier =
        /[._]/.test(tok) ||
        /[a-z][A-Z]/.test(tok) ||
        /\d/.test(tok) ||
        tok.length >= 6;
      if (looksLikeIdentifier) candidates.push(tok);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

export function detectNegativeExistenceClaims(
  text: string,
): NegativeExistenceClaim[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const out: NegativeExistenceClaim[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentences(text)) {
    if (!CODE_CONTEXT_RE.test(sentence)) continue;
    const hasNegative = NEGATIVE_EXISTENCE_PATTERNS.some(([re]) => re.test(sentence));
    if (!hasNegative) continue;
    const symbol = extractSymbol(sentence);
    if (!symbol) continue;
    if (isAffirmativeSubject(sentence, symbol)) continue;
    if (!isSymbolGovernedByNegation(sentence, symbol)) continue;
    const kind = kindForContext(sentence);
    const dedupeKey = `${kind}:${symbol.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ claim: sentence.slice(0, 400), symbol, kind });
  }
  return out;
}

function isAffirmativeSubject(sentence: string, symbol: string): boolean {
  const affirmativeMatches = sentence.match(AFFIRMATIVE_VERB_RE);
  if (!affirmativeMatches) return false;
  if (/\bnot\s+implemented\b/i.test(sentence)) {
    const stripped = sentence.replace(/\b(?:is|was|are|were)?\s*not\s+implemented\b/gi, " ");
    if (!AFFIRMATIVE_VERB_RE.test(stripped)) return false;
  }
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const symbolNegated =
    new RegExp(`\\bno\\s+\`?${esc}\`?\\b`, "i").test(sentence) ||
    new RegExp(`\`?${esc}\`?\\s+(?:endpoint|route|field|model|function|method|column|table|schema)?\\s*(?:does\\s+not\\s+exist|doesn'?t\\s+exist|is\\s+(?:missing|absent)|(?:is|was|are|were)?\\s*not\\s+implemented)`, "i").test(sentence) ||
    new RegExp(`(?:could\\s+not|couldn'?t|unable\\s+to)\\s+(?:locate|find)\\s+(?:the\\s+|a\\s+|an\\s+)?\`?${esc}\``, "i").test(sentence);
  if (symbolNegated) return false;
  return true;
}

function isSymbolGovernedByNegation(sentence: string, symbol: string): boolean {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sBt = `\`?${esc}\`?`;

  if (
    new RegExp(`\\b(?:on|in|for|to|of|from|with|within|inside|under)\\s+(?:the\\s+|that\\s+|a\\s+|an\\s+|this\\s+)?${sBt}\\b`, "i").test(
      sentence,
    )
  ) {
    return false;
  }

  if (
    new RegExp(`(?:could\\s+not|couldn'?t|unable\\s+to|cannot|can'?t)\\s+(?:locate|find)\\s+(?:the\\s+|a\\s+|an\\s+|any\\s+)?${sBt}`, "i").test(
      sentence,
    )
  ) {
    return true;
  }
  const kindOpt = `(?:\\s+(?:${CODE_CONTEXT_WORDS.join("|")}))?`;
  if (
    new RegExp(`${sBt}${kindOpt}\\s+(?:does\\s+not\\s+exist|doesn'?t\\s+exist|is\\s+(?:missing|absent)|was\\s+(?:missing|absent)|is\\s+not\\s+implemented)`, "i").test(
      sentence,
    )
  ) {
    return true;
  }
  if (new RegExp(`\\bno\\s+${sBt}${kindOpt}\\b`, "i").test(sentence)) {
    return true;
  }
  if (
    new RegExp(
      `\\bno\\s+(?:${CODE_CONTEXT_WORDS.join("|")})s?\\b[^.]*?\\b(?:named|called|for|matching)?\\s*${sBt}`,
      "i",
    ).test(sentence)
  ) {
    return true;
  }
  if (new RegExp(`\\bno\\s+(?:also\\s+)?${sBt}\\b`, "i").test(sentence)) {
    return true;
  }
  return false;
}

export type NegativeExistenceEvidence = {
  claimed_absent: string;
  matched_symbol: string;
  repo: string;
  path: string;
  line: number;
  hit_type: "route" | "field" | "function" | "symbol";
  checked_ref: string;
  match_mode?: "literal" | "semantic";
  action_match?: string;
  object_match?: string;
};

export type GroundedClaim = {
  claim: string;
  exists: boolean | undefined;
  evidence?: NegativeExistenceEvidence;
};

export interface GroundingGithubDeps {
  assertReadRepoMembership?: typeof assertReadRepoMembership;
  resolveInstallationId?: typeof resolveInstallationId;
  searchCode?: typeof searchCodeImpl;
  readFile?: typeof readFileImpl;
  listConnectedRepos?: (tenant_id: string) => Promise<string[]>;
}

async function defaultListConnectedRepos(tenant_id: string): Promise<string[]> {
  return getScopedRepoFullNames(tenant_id);
}

type SearchHit = { name: string; path: string };

async function searchSymbol(
  tenant_id: string,
  installation_id: number,
  repos: string[],
  symbol: string,
  searchCode: NonNullable<GroundingGithubDeps["searchCode"]>,
  assertMembership: NonNullable<GroundingGithubDeps["assertReadRepoMembership"]>,
): Promise<{ repo: string; owner: string; name: string; hits: SearchHit[] } | null> {
  for (const full of repos) {
    const [owner, repo] = full.split("/");
    if (!owner || !repo) continue;
    try {
      await assertMembership(tenant_id, owner, repo);
      const res = (await searchCode(tenant_id, installation_id, {
        owner,
        repo,
        query: symbol,
        per_page: 20,
      })) as { total: number; items: SearchHit[] };
      if (res && Array.isArray(res.items) && res.items.length > 0) {
        return { repo: full, owner, name: repo, hits: res.items };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function confirmExistsInFile(
  body: string,
  symbol: string,
  kind: NegativeExistenceKind,
): { line: number; hit_type: NegativeExistenceEvidence["hit_type"] } | null {
  const lines = body.split("\n");
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const leaf = symbol.split(/[./]/).pop() ?? symbol;
  const leafEsc = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const routeRe = new RegExp(
    `\\b(?:get|post|put|patch|delete|router\\.\\w+|app\\.\\w+)\\b.*${leafEsc}|` +
      `${leafEsc}.*\\b(?:get|post|put|patch|delete)\\b`,
    "i",
  );
  const fnRe = new RegExp(
    `(?:function\\s+${leafEsc}\\b|` +
      `\\b${leafEsc}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\()|` +
      `\\b(?:async\\s+)?${leafEsc}\\s*\\([^)]*\\)\\s*(?:=>|\\{|:))`,
  );
  const fieldRe = new RegExp(
    `(^|[\\s{,])${leafEsc}\\s*[:?]|` +
      `\\b${leafEsc}\\s*=\\s*(?:DataTypes|Schema|\\{)|` +
      `["']${leafEsc}["']\\s*:`,
  );
  const bareRe = new RegExp(`\\b${esc}\\b|\\b${leafEsc}\\b`);

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (kind === "endpoint" || kind === "route") {
      if (routeRe.test(ln)) return { line: i + 1, hit_type: "route" };
    } else if (kind === "field") {
      if (fieldRe.test(ln)) return { line: i + 1, hit_type: "field" };
    } else if (kind === "function") {
      if (fnRe.test(ln)) return { line: i + 1, hit_type: "function" };
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const codePart = ln.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    if (!codePart.trim()) continue;
    if (bareRe.test(codePart)) {
      if (kind === "endpoint" || kind === "route" || kind === "field" || kind === "function") {
        continue;
      }
      return { line: i + 1, hit_type: "symbol" };
    }
  }
  return null;
}

const ACTION_CLASSES: Readonly<Record<string, readonly string[]>> = {
  respond: ["reply", "replies", "respond", "responds", "response", "responses", "answer", "answers"],
  delete: ["delete", "deletes", "remove", "removes", "removal", "destroy", "destroys"],
  create: ["create", "creates", "add", "adds", "submit", "submits"],
  update: ["update", "updates", "edit", "edits", "patch", "patches", "modify", "modifies", "change", "changes"],
  read: ["list", "lists", "get", "gets", "fetch", "fetches", "read", "reads", "view", "views", "show", "shows"],
};

const GENERIC_OBJECT_STOPWORDS = new Set<string>([
  ...CODE_CONTEXT_WORDS,
  "to", "of", "for", "on", "in", "by", "with", "from", "and", "or",
  "the", "this", "that", "there", "without", "also", "into", "onto",
  "could", "cannot", "locate", "find", "found", "exist", "exists", "missing",
  "absent", "implement", "implemented", "investigate", "investigated", "build",
  "built", "provide", "provided", "added", "located",
  "user", "users", "data", "config", "configuration", "item", "items",
  "value", "values", "name", "names", "type", "types", "status",
  "info", "detail", "details", "object", "entity", "record", "records",
  "feature", "features", "support", "supported", "current", "existing",
  "backend", "frontend", "repo", "repository", "codebase", "any", "such",
  "thing", "things",
]);

function atomize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

function actionClassOf(tokens: readonly string[]): string | null {
  for (const t of tokens) {
    for (const [cls, words] of Object.entries(ACTION_CLASSES)) {
      if (words.includes(t)) return cls;
    }
  }
  return null;
}

function objectTermsOf(tokens: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.length < 4) continue;
    if (GENERIC_OBJECT_STOPWORDS.has(t)) continue;
    if (actionClassOf([t])) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function extractContainer(sentence: string): string | null {
  const m =
    sentence.match(/\bon\s+(?:the\s+)?([A-Z][A-Za-z0-9_]+)\s+(?:model|schema|table|entity)\b/) ||
    sentence.match(/\b([A-Z][A-Za-z0-9_]+)\s+(?:model|schema|table|entity)\b/);
  return m ? m[1] : null;
}

type CapabilitySignature = { action: string | null; objects: string[] };

function claimSignature(c: NegativeExistenceClaim): CapabilitySignature {
  const tokens = [...atomize(c.claim), ...atomize(c.symbol)];
  return { action: actionClassOf(tokens), objects: objectTermsOf(tokens) };
}

const ANY_ROUTE_RE =
  /\b[A-Za-z_]\w*\.(?:get|post|put|patch|delete)\s*\(\s*["'`]\/|\b(?:get|post|put|patch|delete)\s*\(\s*["'`]\//i;
const ANY_FN_RE =
  /\b(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_]\w*|\b[A-Za-z_]\w*\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*(?:=>|\{)/;

function semanticConfirmInFile(
  body: string,
  sig: CapabilitySignature,
  kind: NegativeExistenceKind,
): { line: number; matched_symbol: string; action_match: string; object_match: string } | null {
  if (!sig.action || sig.objects.length === 0) return null;
  const isRouteKind = kind === "endpoint" || kind === "route";
  const declRe = isRouteKind ? ANY_ROUTE_RE : ANY_FN_RE;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/\/\/.*$/, "");
    if (!code.trim() || !declRe.test(code)) continue;
    const atoms = atomize(code);
    if (actionClassOf(atoms) !== sig.action) continue;
    const objHit = sig.objects.find((o) => atoms.includes(o));
    if (!objHit) continue;
    const idTokens = code.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
    let matched_symbol = "";
    for (const tok of idTokens) {
      const a = atomize(tok);
      if (actionClassOf(a) === sig.action && a.includes(objHit) && tok.length > matched_symbol.length) {
        matched_symbol = tok;
      }
    }
    if (!matched_symbol) {
      for (const tok of idTokens) {
        if (atomize(tok).includes(objHit) && tok.length > matched_symbol.length) matched_symbol = tok;
      }
    }
    if (!matched_symbol) continue;
    return { line: i + 1, matched_symbol, action_match: sig.action, object_match: objHit };
  }
  return null;
}

const MAX_SEMANTIC_SEARCHES = Number(process.env.NEG_EXISTENCE_MAX_SEMANTIC_SEARCHES ?? 2);
const MAX_SEMANTIC_READS = Number(process.env.NEG_EXISTENCE_MAX_SEMANTIC_READS ?? 3);

export async function groundNegativeExistence(
  tenant_id: string,
  claims: NegativeExistenceClaim[],
  deps: GroundingGithubDeps = {},
): Promise<GroundedClaim[]> {
  if (!tenant_id || claims.length === 0) return [];
  const assertMembership = deps.assertReadRepoMembership ?? assertReadRepoMembership;
  const resolveId = deps.resolveInstallationId ?? resolveInstallationId;
  const searchCode = deps.searchCode ?? searchCodeImpl;
  const readFile = deps.readFile ?? readFileImpl;
  const listRepos = deps.listConnectedRepos ?? defaultListConnectedRepos;

  const repos = await listRepos(tenant_id);
  if (repos.length === 0) {
    return claims.map((c) => ({ claim: c.claim, exists: undefined }));
  }

  let installation_id: number;
  try {
    installation_id = await resolveId(tenant_id);
  } catch {
    return claims.map((c) => ({ claim: c.claim, exists: undefined }));
  }

  const out: GroundedClaim[] = [];
  let semSearches = 0;
  let semReads = 0;
  let anyConfirmed = false;

  for (const c of claims) {
    let confirmed: NegativeExistenceEvidence | undefined;

    let hit:
      | { repo: string; owner: string; name: string; hits: SearchHit[] }
      | null = null;
    try {
      hit = await searchSymbol(
        tenant_id,
        installation_id,
        repos,
        c.symbol,
        searchCode,
        assertMembership,
      );
    } catch {
      out.push({ claim: c.claim, exists: undefined });
      continue;
    }

    if (hit) {
      for (const item of hit.hits.slice(0, 5)) {
        let body: string;
        try {
          const read = (await readFile(tenant_id, installation_id, {
            owner: hit.owner,
            repo: hit.name,
            ref: "HEAD",
            path: item.path,
          })) as { content: string };
          body = typeof read?.content === "string" ? read.content : "";
        } catch {
          continue;
        }
        if (!body) continue;
        const match = confirmExistsInFile(body, c.symbol, c.kind);
        if (!match) continue;
        if (
          (c.kind === "field" ||
            c.kind === "model" ||
            c.kind === "table" ||
            c.kind === "symbol") &&
          !isBackendSubsystemPath(item.path)
        ) {
          continue;
        }
        if (match.hit_type === "field") {
          const container = extractContainer(c.claim);
          if (container) {
            const cAtoms = atomize(container);
            const bodyAtoms = new Set(atomize(body));
            const pathAtoms = new Set(atomize(item.path));
            const inBody = body.includes(container) || cAtoms.every((a) => bodyAtoms.has(a));
            const inPath = cAtoms.length > 0 && cAtoms.every((a) => pathAtoms.has(a));
            if (!inBody && !inPath) {
              continue;
            }
          }
        }
        confirmed = {
          claimed_absent: c.symbol,
          matched_symbol: c.symbol,
          repo: hit.repo,
          path: item.path,
          line: match.line,
          hit_type: match.hit_type,
          checked_ref: "HEAD",
          match_mode: "literal",
        };
        break;
      }
    }

    const semKindOk = c.kind === "endpoint" || c.kind === "route" || c.kind === "function";
    if (!confirmed && semKindOk && !anyConfirmed && semSearches < MAX_SEMANTIC_SEARCHES) {
      const sig = claimSignature(c);
      if (sig.action && sig.objects.length > 0) {
        const objTerm = [...sig.objects].sort((a, b) => b.length - a.length)[0];
        semSearches += 1;
        let semHit:
          | { repo: string; owner: string; name: string; hits: SearchHit[] }
          | null = null;
        try {
          semHit = await searchSymbol(
            tenant_id,
            installation_id,
            repos,
            objTerm,
            searchCode,
            assertMembership,
          );
        } catch {
          semHit = null;
        }
        if (semHit) {
          for (const item of semHit.hits.slice(0, 5)) {
            if (semReads >= MAX_SEMANTIC_READS) break;
            semReads += 1;
            let body: string;
            try {
              const read = (await readFile(tenant_id, installation_id, {
                owner: semHit.owner,
                repo: semHit.name,
                ref: "HEAD",
                path: item.path,
              })) as { content: string };
              body = typeof read?.content === "string" ? read.content : "";
            } catch {
              continue;
            }
            if (!body) continue;
            const sm = semanticConfirmInFile(body, sig, c.kind);
            if (sm) {
              confirmed = {
                claimed_absent: c.symbol,
                matched_symbol: sm.matched_symbol,
                repo: semHit.repo,
                path: item.path,
                line: sm.line,
                hit_type: c.kind === "function" ? "function" : "route",
                checked_ref: "HEAD",
                match_mode: "semantic",
                action_match: sm.action_match,
                object_match: sm.object_match,
              };
              break;
            }
          }
        }
      }
    }

    if (confirmed) {
      anyConfirmed = true;
      out.push({ claim: c.claim, exists: true, evidence: confirmed });
    } else {
      out.push({ claim: c.claim, exists: false });
    }
  }
  return out;
}

const CONNECTOR_NAME_TO_SLUG: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bslack\b/i, "slack"],
  [/\bgit\s?hub\b/i, "github"],
  [/\bgoogle\s+ads\b/i, "google_ads"],
  [/\bmeta(?:\s+ads)?\b/i, "meta_ads"],
  [/\bfacebook(?:\s+ads)?\b/i, "meta_ads"],
  [/\bstripe\b/i, "stripe"],
  [/\bjira\b/i, "jira"],
  [/\blinear\b/i, "linear"],
  [/\bintercom\b/i, "intercom"],
  [/\b(?:operator[\s_-]?db|operations?\s+database)\b/i, "operator_db"],
];

const CONNECTOR_SLUG_LABEL: Readonly<Record<string, string>> = {
  slack: "Slack",
  github: "GitHub",
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  stripe: "Stripe",
  jira: "Jira",
  linear: "Linear",
  intercom: "Intercom",
  operator_db: "your operations database",
};

const CONNECTOR_ABSENCE_PHRASES: readonly RegExp[] = [
  /\b(?:is|are|isn'?t|aren'?t|was|were|'s)?\s*(?:not|never|no\s+longer|n'?t)\s+connected\b/i,
  /\bno\b[^.?!]{0,30}\bconnect(?:ion|ed)?\b/i,
  /\bnot\s+(?:set\s?up|configured|linked|integrated|authorized|authenticated)\b/i,
  /\bhaven'?t\s+(?:yet\s+)?connected\b/i,
  /\bnot\s+been\s+connected\b/i,
];

export type ConnectorAbsenceClaim = {
  connector: string;
  claim: string;
};

function splitSentencesForConnector(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|;\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function detectConnectorAbsenceClaims(
  text: string,
): ConnectorAbsenceClaim[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const out: ConnectorAbsenceClaim[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentencesForConnector(text)) {
    if (!CONNECTOR_ABSENCE_PHRASES.some((re) => re.test(sentence))) continue;
    for (const [nameRe, slug] of CONNECTOR_NAME_TO_SLUG) {
      if (seen.has(slug)) continue;
      if (!nameRe.test(sentence)) continue;
      seen.add(slug);
      out.push({ connector: slug, claim: sentence.slice(0, 400) });
    }
  }
  return out;
}

function hasNotConnectedToolError(
  toolCalls: readonly ToolCallTrace[],
): boolean {
  return toolCalls.some((t) => {
    if (typeof t?.name !== "string") return false;
    if (t.name.startsWith("memory__")) return false;
    const out = typeof t.output_preview === "string" ? t.output_preview : "";
    return /\bnot_connected\b|\b[a-z_]*_not_(?:connected|installed|authorized)\b/i.test(
      out,
    );
  });
}

function buildConnectorHedgeBanner(slugs: readonly string[]): string {
  const labels = slugs.map((s) => CONNECTOR_SLUG_LABEL[s] ?? s);
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  const verb = labels.length === 1 ? "is" : "are";
  return [
    `> ⚠️ **Correction** — this reply says a connector is not connected, but ${list} ${verb} actually connected to your workspace right now.`,
    "> Re-check the live connection before treating it as unavailable.",
    "",
    "",
  ].join("\n");
}

export type ConnectorAbsenceFlags = {
  has_connector_absence_claim: boolean;
  connectors_claimed_absent: string[];
  connectors_falsely_claimed_absent: string[];
  grounded_by_tool_error: boolean;
};

export type ConnectorAbsenceResult = {
  hedged: boolean;
  text: string;
  flags: ConnectorAbsenceFlags;
};

export interface ConnectorAbsenceDeps {
  listConnected?: (tenant_id: string) => Promise<Array<{ slug: string }>>;
}

export async function verifyConnectorAbsence(args: {
  tenant_id: string;
  reply: string;
  toolCalls?: readonly ToolCallTrace[];
  deps?: ConnectorAbsenceDeps;
}): Promise<ConnectorAbsenceResult> {
  const reply = typeof args.reply === "string" ? args.reply : "";
  const claims = detectConnectorAbsenceClaims(reply);
  const flags: ConnectorAbsenceFlags = {
    has_connector_absence_claim: claims.length > 0,
    connectors_claimed_absent: claims.map((c) => c.connector),
    connectors_falsely_claimed_absent: [],
    grounded_by_tool_error: false,
  };
  if (claims.length === 0 || !args.tenant_id) {
    return { hedged: false, text: reply, flags };
  }
  if (hasNotConnectedToolError(args.toolCalls ?? [])) {
    flags.grounded_by_tool_error = true;
    return { hedged: false, text: reply, flags };
  }
  const listConnected =
    args.deps?.listConnected ?? ((t: string) => readConnectorList(t));
  let connected: Array<{ slug: string }>;
  try {
    connected = await listConnected(args.tenant_id);
  } catch {
    return { hedged: false, text: reply, flags };
  }
  const connectedSlugs = new Set(
    (connected ?? []).map((c) => c?.slug).filter(Boolean),
  );
  const falselyAbsent = claims
    .map((c) => c.connector)
    .filter((slug) => connectedSlugs.has(slug));
  flags.connectors_falsely_claimed_absent = falselyAbsent;
  if (falselyAbsent.length === 0) {
    return { hedged: false, text: reply, flags };
  }
  return {
    hedged: true,
    text: buildConnectorHedgeBanner(falselyAbsent) + reply,
    flags,
  };
}

export const CONNECTOR_ABSENCE_VALIDATOR_AGENTS: ReadonlySet<string> = new Set([
  "operator",
  "support-lead",
  "performance-marketer",
  "growth-lead",
  "chief-of-staff",
  "pm",
]);

export const NEGATIVE_EXISTENCE_VALIDATOR_AGENTS: ReadonlySet<string> = new Set([
  "engineer",
]);

const NEG_EXISTENCE_BANNER_MARKER = "<!--engineer-neg-existence-correction-->";

const NEG_EXISTENCE_REPLY_TIMEOUT_MS = Number(
  process.env.NEG_EXISTENCE_REPLY_TIMEOUT_MS ?? 4000,
);
const NEG_EXISTENCE_CACHE_TTL_MS = Number(
  process.env.NEG_EXISTENCE_CACHE_TTL_MS ?? 5 * 60_000,
);

type CachedVerdict = {
  exists: boolean;
  evidence?: NegativeExistenceEvidence;
  expiresAt: number;
};
const negExistenceCache = new Map<string, CachedVerdict>();

function claimKey(c: NegativeExistenceClaim): string {
  return `${c.kind}::${c.symbol.toLowerCase()}`;
}
function cacheKey(tenant_id: string, c: NegativeExistenceClaim): string {
  return `${tenant_id}::${claimKey(c)}`;
}

export function __clearNegExistenceCache(): void {
  negExistenceCache.clear();
}

export type NegativeExistenceReplyResult = {
  hedged: boolean;
  text: string;
  without_false_claims: string;
  flags: {
    has_claim: boolean;
    claims_checked: number;
    corrected_symbols: string[];
    false_claim_symbols: string[];
    false_claims: Array<{ kind: NegativeExistenceKind; symbol: string }>;
  };
};

export interface NegativeExistenceReplyDeps {
  ground?: (
    tenant_id: string,
    claims: NegativeExistenceClaim[],
  ) => Promise<GroundedClaim[]>;
  now?: () => number;
  timeoutMs?: number;
}

export function removeFalseAbsenceSentences(
  text: string,
  targets: ReadonlyArray<string | { kind: NegativeExistenceKind; symbol: string }>,
): string {
  const anyKind = new Set<string>();
  const keyed = new Set<string>();
  for (const t of targets) {
    if (typeof t === "string") anyKind.add(t.toLowerCase());
    else keyed.add(claimKey({ claim: "", kind: t.kind, symbol: t.symbol }));
  }
  if (anyKind.size === 0 && keyed.size === 0) return text;
  return removeClaimSentences(text, (sentence) =>
    detectNegativeExistenceClaims(sentence).some(
      (c) => anyKind.has(c.symbol.toLowerCase()) || keyed.has(claimKey(c)),
    ),
  ).text;
}

function whereItIsSentence(proven: GroundedClaim[]): string {
  const items = proven.slice(0, 3).map((g) => {
    const e = g.evidence as NegativeExistenceEvidence;
    return `\`${e.matched_symbol}\` (${e.path}:${e.line})`;
  });
  return `I found it in your repo: ${items.join("; ")}.`;
}

function buildNegExistenceBanner(proven: GroundedClaim[]): string {
  const items = proven.slice(0, 3).map((g) => {
    const e = g.evidence as NegativeExistenceEvidence;
    const via =
      e.match_mode === "semantic" &&
      e.matched_symbol.toLowerCase() !== e.claimed_absent.toLowerCase()
        ? ` — it exists as \`${e.matched_symbol}\``
        : "";
    return `\`${e.claimed_absent}\`${via} (${e.path}:${e.line})`;
  });
  return [
    `> ⚠️ **Correction:** this reply says something isn't in your repo, but I found it — ${items.join("; ")}. Please double-check before treating it as missing.`,
    "",
    NEG_EXISTENCE_BANNER_MARKER,
    "",
    "",
  ].join("\n");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("neg_existence_timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function verifyNegativeExistence(args: {
  tenant_id: string;
  reply: string;
  deps?: NegativeExistenceReplyDeps;
}): Promise<NegativeExistenceReplyResult> {
  const reply = typeof args.reply === "string" ? args.reply : "";
  const flags = {
    has_claim: false,
    claims_checked: 0,
    corrected_symbols: [] as string[],
    false_claim_symbols: [] as string[],
    false_claims: [] as Array<{ kind: NegativeExistenceKind; symbol: string }>,
  };

  if (reply.includes(NEG_EXISTENCE_BANNER_MARKER)) {
    return { hedged: false, text: reply, without_false_claims: reply, flags };
  }
  const claims = detectNegativeExistenceClaims(reply);
  flags.has_claim = claims.length > 0;
  if (claims.length === 0 || !args.tenant_id) {
    return { hedged: false, text: reply, without_false_claims: reply, flags };
  }

  const ground =
    args.deps?.ground ??
    ((t: string, cs: NegativeExistenceClaim[]) => groundNegativeExistence(t, cs));
  const now = args.deps?.now ?? Date.now;
  const timeoutMs = args.deps?.timeoutMs ?? NEG_EXISTENCE_REPLY_TIMEOUT_MS;
  const nowMs = now();

  const verdicts = new Map<string, GroundedClaim>();
  const toGround: NegativeExistenceClaim[] = [];
  for (const c of claims) {
    const hit = negExistenceCache.get(cacheKey(args.tenant_id, c));
    if (hit && hit.expiresAt > nowMs) {
      verdicts.set(claimKey(c), {
        claim: c.claim,
        exists: hit.exists,
        evidence: hit.evidence,
      });
    } else {
      toGround.push(c);
    }
  }

  if (toGround.length > 0) {
    let fresh: GroundedClaim[] = [];
    try {
      fresh = await withTimeout(ground(args.tenant_id, toGround), timeoutMs);
    } catch {
      fresh = [];
    }
    for (let i = 0; i < toGround.length; i++) {
      const c = toGround[i];
      const g = fresh[i];
      if (!g) continue;
      verdicts.set(claimKey(c), g);
      if (g.exists === true || g.exists === false) {
        negExistenceCache.set(cacheKey(args.tenant_id, c), {
          exists: g.exists,
          evidence: g.evidence,
          expiresAt: nowMs + NEG_EXISTENCE_CACHE_TTL_MS,
        });
      }
    }
  }

  flags.claims_checked = verdicts.size;
  const provenClaims = claims.filter((c) => {
    const g = verdicts.get(claimKey(c));
    return !!g && g.exists === true && !!g.evidence;
  });
  const proven = provenClaims.map((c) => verdicts.get(claimKey(c)) as GroundedClaim);
  if (proven.length === 0) {
    return { hedged: false, text: reply, without_false_claims: reply, flags };
  }
  flags.corrected_symbols = proven.map(
    (g) => (g.evidence as NegativeExistenceEvidence).matched_symbol,
  );
  flags.false_claim_symbols = provenClaims.map((c) => c.symbol);
  flags.false_claims = provenClaims.map((c) => ({ kind: c.kind, symbol: c.symbol }));
  const removed = removeFalseAbsenceSentences(reply, flags.false_claims);
  return {
    hedged: true,
    text: buildNegExistenceBanner(proven) + reply,
    without_false_claims: removed.length > 0 ? removed : whereItIsSentence(proven),
    flags,
  };
}
