
export type ContaminationKind =
  | "uuid"
  | "dollar"
  | "percent"
  | "connector_ref"
  | "tenant_token"
  | "url"
  | "email"
  | "handle";

export interface ContaminationHit {
  kind: ContaminationKind;
  match: string;
  index: number;
}

export interface ScanResult {
  clean: boolean;
  hits: ContaminationHit[];
}

export interface ScanOptions {
  tenantTokens?: string[];
}

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const DOLLAR_RE = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s?(?:k|m|bn?))?/gi;

const PERCENT_RE = /\b\d{1,3}(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?[x×]\b/gi;

const CONNECTOR_RE =
  /\b(?:act_\d+|G-[A-Z0-9]{6,}|properties\/\d+|acct_[A-Za-z0-9]+|cus_[A-Za-z0-9]+|du_[A-Za-z0-9]+|ad_account[_\s:=]+\S+|campaign[_\s:=]+\d+)\b/g;

const URL_RE = /\bhttps?:\/\/[^\s)\]]+/gi;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const HANDLE_RE = /(?:^|[\s(])@[A-Za-z0-9_]{2,}\b/g;

function pushHits(
  hits: ContaminationHit[],
  re: RegExp,
  block: string,
  kind: ContaminationKind,
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const raw = m[0];
    const trimmed = raw.replace(/^[\s(]+/, "");
    const offset = m.index + (raw.length - trimmed.length);
    hits.push({ kind, match: trimmed, index: offset });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scanForTenantContamination(
  block: string,
  options: ScanOptions = {},
): ScanResult {
  const text = typeof block === "string" ? block : "";
  const hits: ContaminationHit[] = [];

  pushHits(hits, UUID_RE, text, "uuid");
  pushHits(hits, DOLLAR_RE, text, "dollar");
  pushHits(hits, PERCENT_RE, text, "percent");
  pushHits(hits, CONNECTOR_RE, text, "connector_ref");
  pushHits(hits, URL_RE, text, "url");
  pushHits(hits, EMAIL_RE, text, "email");
  pushHits(hits, HANDLE_RE, text, "handle");

  for (const tokRaw of options.tenantTokens ?? []) {
    const tok = (tokRaw ?? "").trim();
    if (tok.length < 3) continue;
    const wordLike = /^[\w.-]+$/.test(tok);
    const re = wordLike
      ? new RegExp(`\\b${escapeRe(tok)}\\b`, "gi")
      : new RegExp(escapeRe(tok), "gi");
    pushHits(hits, re, text, "tenant_token");
  }

  const seen = new Set<string>();
  const deduped = hits.filter((h) => {
    const key = `${h.kind}|${h.match}|${h.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => a.index - b.index);

  return { clean: deduped.length === 0, hits: deduped };
}
