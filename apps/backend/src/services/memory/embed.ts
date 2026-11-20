
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3.5-lite";
export const EMBED_DIM = 1024;
const MAX_BATCH = 128;

export class VoyageError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "VoyageError";
  }
}

export class VoyageDimError extends Error {
  constructor(public readonly got: number, public readonly expected: number) {
    super(
      `voyage embed dim mismatch: got ${got}, expected ${expected}. Model="${MODEL}". ` +
        `This is a config regression (Voyage default may have changed) — fix MODEL / EMBED_DIM / schema alignment before continuing.`,
    );
    this.name = "VoyageDimError";
  }
}

type VoyageResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { total_tokens: number };
};

function getApiKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new VoyageError(0, "VOYAGE_API_KEY not set — add to AWS Secrets Manager praxis-envprod-1");
  }
  return key;
}

export async function embedTexts(
  texts: string[],
  input_type: "document" | "query",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > MAX_BATCH) {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const slice = texts.slice(i, i + MAX_BATCH);
      const part = await embedTexts(slice, input_type);
      out.push(...part);
    }
    return out;
  }

  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({ input: texts, model: MODEL, input_type }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new VoyageError(res.status, `voyage embed failed: ${res.status} ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as VoyageResponse;
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  const vectors = sorted.map((d) => d.embedding);

  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== EMBED_DIM) {
      throw new VoyageDimError(Array.isArray(v) ? v.length : 0, EMBED_DIM);
    }
  }

  for (const v of vectors) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    const norm = Math.sqrt(s);
    if (norm < 0.99 || norm > 1.01) {
      console.error(
        `[PRAXIS_VOYAGE_NORM_DRIFT] dim=${v.length} L2=${norm.toFixed(4)} model="${MODEL}" input_type="${input_type}" — ` +
          `cosine math across the stack assumes unit vectors. Investigate Voyage model/normalization.`,
      );
      break;
    }
  }

  return vectors;
}

export async function embedOne(text: string, input_type: "document" | "query"): Promise<number[]> {
  const [v] = await embedTexts([text], input_type);
  return v;
}
