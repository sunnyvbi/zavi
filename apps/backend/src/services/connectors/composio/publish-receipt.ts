import type { ComposioExecResult } from "@/services/connectors/composio/api";

export type PublishResult = { ok: boolean; status: number; raw: Record<string, unknown> };

const obj = (v: unknown): Record<string, unknown> | null => {
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
};

export function composioFailure(r: ComposioExecResult, fallback: string): PublishResult {
  const status = r.status >= 500 || r.status === 0 ? r.status : r.outcome_unknown ? 0 : 400;
  return { ok: false, status, raw: { error: typeof r.error === "string" ? r.error : JSON.stringify(r.error ?? fallback) } };
}

export function composioReceipt(data: unknown): { id: string; record: Record<string, unknown>; response: Record<string, unknown> } {
  const response = obj(data) ?? {};
  const record = [response, obj(response.data), obj(response.response_data)].find((o) => o && o.id != null) ?? response;
  const raw = record.id;
  return { id: typeof raw === "string" || typeof raw === "number" ? String(raw) : "", record, response };
}
