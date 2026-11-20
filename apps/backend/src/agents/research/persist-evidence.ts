
import { extractQuestionText } from "@/services/agents/question-text";
import { createHash } from "node:crypto";
import { serviceClient } from "@/services/supabase";
import {
  getCaptureLedger,
  normalizeUrlForMatch,
  type CaptureLedgerEntry,
} from "@/services/agents/engine/capture-ledger";
import type { DispatcherResult } from "@/services/agents/types";

export const EXCERPT_MAX_BYTES = 64 * 1024;
export const MAX_EVIDENCE_ROWS_PER_RUN = 60;

const TOPIC_STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "is", "are",
  "what", "whats", "how", "why", "who", "when", "where", "which", "do", "does",
  "give", "me", "my", "our", "your", "their", "about", "with", "into", "vs",
  "research", "analyze", "analysis", "report", "teardown", "competitor",
  "competitors", "market", "landscape", "intel", "please", "can", "you",
  "tell", "find", "look", "this", "that", "they", "we", "us", "it", "as",
]);

export function deriveTopicKey(askText: string | null | undefined): string | null {
  if (!askText || typeof askText !== "string") return null;
  const tokens = askText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !TOPIC_STOPWORDS.has(t));
  if (tokens.length === 0) return null;
  const uniq = Array.from(new Set(tokens)).sort();
  return uniq.slice(0, 8).join("-") || null;
}

export const extractAskText = extractQuestionText;

export type EvidenceRow = {
  url: string;
  normalized_url: string;
  capture_status: string;
  http_status: number;
  content_hash: string | null;
  excerpt: string | null;
  excerpt_bytes: number | null;
};

function capBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

export function buildEvidenceRows(entries: CaptureLedgerEntry[]): EvidenceRow[] {
  const byUrl = new Map<string, EvidenceRow>();
  for (const e of entries) {
    const normalized_url = normalizeUrlForMatch(e.final_url || e.requested_url);
    if (!normalized_url) continue;
    const hasText =
      (e.capture === "dom_text" || e.capture === "rendered") &&
      typeof e.text_snippet === "string" &&
      e.text_snippet.length > 0;
    const excerpt = hasText ? capBytes(e.text_snippet as string, EXCERPT_MAX_BYTES) : null;
    byUrl.set(normalized_url, {
      url: e.requested_url || e.final_url,
      normalized_url,
      capture_status: e.capture,
      http_status: typeof e.status === "number" ? e.status : 0,
      content_hash: excerpt ? createHash("sha256").update(excerpt, "utf8").digest("hex") : null,
      excerpt,
      excerpt_bytes: excerpt ? Buffer.byteLength(excerpt, "utf8") : null,
    });
  }
  return Array.from(byUrl.values()).slice(0, MAX_EVIDENCE_ROWS_PER_RUN);
}

export type PersistEvidenceInput = {
  tenant_id: string;
  run_id: string;
  payload: unknown;
  result: DispatcherResult;
};

export async function persistResearchEvidence(
  input: PersistEvidenceInput,
): Promise<{ persisted: number }> {
  try {
    if (!input.result?.parse_ok) return { persisted: 0 };
    if (!input.tenant_id || !input.run_id) return { persisted: 0 };

    const entries = getCaptureLedger(input.run_id);
    if (entries.length === 0) return { persisted: 0 };

    const rows = buildEvidenceRows(entries);
    if (rows.length === 0) return { persisted: 0 };

    const topic_key = deriveTopicKey(extractAskText(input.payload));

    const { data, error } = await serviceClient().rpc("insert_research_evidence", {
      p_tenant_id: input.tenant_id,
      p_run_id: input.run_id,
      p_topic_key: topic_key,
      p_rows: rows,
    });
    if (error) {
      console.warn(
        `[research evidence] insert_research_evidence failed for tenant=${input.tenant_id} run=${input.run_id}: ${error.message}`,
      );
      return { persisted: 0 };
    }
    const persisted = typeof data === "number" ? data : 0;
    console.log(
      `[research evidence] persisted ${persisted}/${rows.length} sources tenant=${input.tenant_id} run=${input.run_id} topic=${topic_key ?? "-"}`,
    );
    return { persisted };
  } catch (e) {
    console.warn(
      `[research evidence] persist threw for run=${input?.run_id}: ${(e as Error).message}`,
    );
    return { persisted: 0 };
  }
}

const INJECT_LIMIT = 12;
const TOPIC_MIN_HITS = 3;

type PriorRow = {
  url: string;
  normalized_url: string;
  capture_status: string;
  accessed_at: string;
  as_of_date: string | null;
};

function isoDay(ts: string): string {
  return (ts || "").slice(0, 10);
}

export async function loadPriorEvidenceContext(
  tenant_id: string,
  topic_key: string | null,
): Promise<string> {
  try {
    if (!tenant_id) return "";
    const sb = serviceClient();

    const rows: PriorRow[] = [];
    const seen = new Set<string>();
    const take = (data: PriorRow[] | null) => {
      for (const r of data ?? []) {
        const key = r.normalized_url;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        rows.push(r);
        if (rows.length >= INJECT_LIMIT) break;
      }
    };

    if (topic_key) {
      const { data, error } = await sb
        .from("research_evidence")
        .select("url, normalized_url, capture_status, accessed_at, as_of_date")
        .eq("tenant_id", tenant_id)
        .eq("topic_key", topic_key)
        .order("accessed_at", { ascending: false })
        .limit(INJECT_LIMIT * 2);
      if (!error) take(data as PriorRow[] | null);
    }

    if (rows.length < TOPIC_MIN_HITS) {
      const { data, error } = await sb
        .from("research_evidence")
        .select("url, normalized_url, capture_status, accessed_at, as_of_date")
        .eq("tenant_id", tenant_id)
        .order("accessed_at", { ascending: false })
        .limit(INJECT_LIMIT * 3);
      if (!error) take(data as PriorRow[] | null);
    }

    if (rows.length === 0) return "";

    const lines = rows.map((r) => {
      const asOf = r.as_of_date ? `, source as-of ${r.as_of_date}` : "";
      return `- ${r.url} — last fetched ${isoDay(r.accessed_at)} (${r.capture_status}${asOf})`;
    });
    return lines.join("\n");
  } catch (e) {
    console.warn(
      `[research evidence] loadPriorEvidenceContext failed for tenant=${tenant_id}: ${(e as Error).message}`,
    );
    return "";
  }
}

export type ResearchWatchBaselineRow = { url: string; excerpt: string };

type BaselineDbRow = {
  url: string;
  normalized_url: string;
  excerpt: string | null;
};

export async function loadResearchWatchBaseline(
  tenant_id: string,
  topic_key: string | null,
): Promise<ResearchWatchBaselineRow[]> {
  try {
    if (!tenant_id) return [];
    const sb = serviceClient();

    const rows: ResearchWatchBaselineRow[] = [];
    const seen = new Set<string>();
    const take = (data: BaselineDbRow[] | null) => {
      for (const r of data ?? []) {
        const key = r.normalized_url;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        rows.push({ url: r.url, excerpt: r.excerpt ?? "" });
        if (rows.length >= INJECT_LIMIT) break;
      }
    };

    if (!topic_key) return [];
    const { data, error } = await sb
      .from("research_evidence")
      .select("url, normalized_url, excerpt")
      .eq("tenant_id", tenant_id)
      .eq("topic_key", topic_key)
      .order("accessed_at", { ascending: false })
      .limit(INJECT_LIMIT * 2);
    if (!error) take(data as BaselineDbRow[] | null);

    return rows;
  } catch (e) {
    console.warn(
      `[research evidence] loadResearchWatchBaseline failed for tenant=${tenant_id}: ${(e as Error).message}`,
    );
    return [];
  }
}
