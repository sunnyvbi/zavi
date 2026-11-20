
import { ExpectedToolError } from "@/services/tools/types";

const TRANSIENT_GRAPH_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
const isBucCode = (c: number) => c >= 80000 && c <= 80014;

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function networkCode(e: unknown): string | null {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === "object" && depth < 4; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export function isRetryableMetaReadError(e: unknown): boolean {
  if (e instanceof ExpectedToolError) {
    if (e.code === "meta_ads_timeout") return true;
    if (e.code !== "meta_ads_query_failed") return false;
    const m = e.meta ?? {};
    const status = typeof m.http_status === "number" ? m.http_status : null;
    const graph = typeof m.graph_code === "number" ? m.graph_code : null;
    if (m.is_transient === true) return true;
    if (graph !== null && (TRANSIENT_GRAPH_CODES.has(graph) || isBucCode(graph))) return true;
    return status !== null && (status === 408 || status === 429 || status >= 500);
  }
  if (!(e instanceof Error)) return false;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  if (networkCode(e)) return true;
  return e.name === "TypeError" && e.message === "fetch failed";
}
