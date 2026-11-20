
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { assertReadOnlyReads } from "@/services/tools/operator-db/codeact-sql";
import { EMBED_DIM, VoyageDimError, embedOne } from "@/services/memory/embed";

export type VerifiedQuery = {
  id: string;
  question: string;
  sql_reads: string[];
  created_at: string;
};

export type VerifiedQueryMatch = VerifiedQuery & { similarity: number };

const MAX_ROWS_SCANNED = 50;
export const MIN_COSINE = 0.72;
export const MIN_WORD_OVERLAP = 0.5;

export type VerifiedQueryDeps = {
  embed: (text: string, kind: "document" | "query") => Promise<number[]>;
};

const realDeps: VerifiedQueryDeps = { embed: embedOne };

async function tryEmbed(deps: VerifiedQueryDeps, text: string, kind: "document" | "query"): Promise<number[] | null> {
  try {
    const v = await deps.embed(text, kind);
    return Array.isArray(v) && v.length === EMBED_DIM ? v : null;
  } catch (e) {
    if (e instanceof VoyageDimError) console.error("[PRAXIS_EMBED_OUTAGE] verified-query embed dim mismatch:", e.message);
    return null;
  }
}

export async function saveVerifiedQuery(
  tenant_id: string,
  input: { question: string; sql_reads: string[]; created_by: string | null },
  deps: VerifiedQueryDeps = realDeps,
): Promise<{ id: string; embedded: boolean }> {
  const question = input.question.trim();
  if (!question) throw new Error("question is empty");
  assertReadOnlyReads(input.sql_reads);
  const embedding = await tryEmbed(deps, question, "document");
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_verified_queries")
    .insert({
      question: question.slice(0, 500),
      sql_reads: input.sql_reads,
      question_embedding: embedding,
      created_by: input.created_by,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`verified query not saved: ${error?.message ?? "no row"}`);
  return { id: (data as { id: string }).id, embedded: embedding !== null };
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

export function wordOverlap(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit / Math.min(wa.size, wb.size);
}

function stillReadOnly(sql_reads: unknown): sql_reads is string[] {
  try {
    assertReadOnlyReads(sql_reads);
    return true;
  } catch {
    return false;
  }
}

export async function findSimilarVerifiedQueries(
  tenant_id: string,
  question: string,
  opts: { limit?: number } = {},
  deps: VerifiedQueryDeps = realDeps,
): Promise<VerifiedQueryMatch[]> {
  const q = question.trim();
  if (!q) return [];
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_verified_queries")
    .select("id, question, sql_reads, question_embedding, created_at")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS_SCANNED);
  if (error) throw new Error(`verified queries not read: ${error.message}`);
  const rows = (data ?? []) as Array<VerifiedQuery & { question_embedding: number[] | null }>;
  if (!rows.length) return [];

  const qEmb = await tryEmbed(deps, q, "query");
  const scored: VerifiedQueryMatch[] = [];
  for (const r of rows) {
    if (!stillReadOnly(r.sql_reads)) continue;
    const emb = Array.isArray(r.question_embedding) ? r.question_embedding : null;
    let similarity: number;
    let pass: boolean;
    if (qEmb && emb) {
      similarity = cosine(qEmb, emb);
      pass = similarity >= MIN_COSINE;
    } else {
      similarity = wordOverlap(q, r.question);
      pass = similarity >= MIN_WORD_OVERLAP;
    }
    if (pass) {
      scored.push({ id: r.id, question: r.question, sql_reads: r.sql_reads, created_at: r.created_at, similarity });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, opts.limit ?? 2);
}
