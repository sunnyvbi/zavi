
const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";
const RERANK_MODEL = "rerank-2.5";

export const RERANK_POOL_K = 60;

export const RERANK_MAX_DOC_CHARS = 4000;

const RERANK_MAX_QUERY_CHARS = 8000;

export const RERANK_TIMEOUT_MS = 2500;

export const RERANK_STAGE_MS = RERANK_TIMEOUT_MS + 1000;

export const RERANK_MODEL_NAME = RERANK_MODEL;

export type RerankResult = { index: number; relevance_score: number };

export async function rerankDocuments(
  query: string,
  documents: string[],
  topK: number,
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new Error("VOYAGE_API_KEY not set — add to AWS Secrets Manager praxis-envprod-1");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
  try {
    const res = await fetch(VOYAGE_RERANK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: query.slice(0, RERANK_MAX_QUERY_CHARS),
        documents,
        model: RERANK_MODEL,
        top_k: topK,
        return_documents: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`voyage rerank failed: ${res.status} ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: RerankResult[] };
    return Array.isArray(json.data) ? json.data : [];
  } finally {
    clearTimeout(timer);
  }
}
