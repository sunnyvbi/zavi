
export const MODEL_REFUSAL_CODE = "model_refusal";

export type SdkRefusal = { category: string | null };

type Msg = {
  type?: string;
  subtype?: string;
  scope?: string;
  stop_reason?: string | null;
  api_refusal_category?: string | null;
  message?: { stop_reason?: string | null; stop_details?: { category?: string | null } | null };
};

export function refusalSignal(message: unknown): SdkRefusal | "cleared" | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Msg;
  if (m.type === "system" && m.subtype === "model_refusal_fallback") {
    return m.scope === undefined || m.scope === "session" ? "cleared" : null;
  }
  if (m.type === "system" && m.subtype === "model_refusal_no_fallback") {
    return { category: normCategory(m.api_refusal_category) };
  }
  if (m.type === "assistant" && m.message?.stop_reason === "refusal") {
    return { category: normCategory(m.message.stop_details?.category) };
  }
  if (m.type === "result" && m.stop_reason === "refusal") return { category: null };
  return null;
}

export function nextRefusalState(
  prev: SdkRefusal | null,
  message: unknown,
): SdkRefusal | null {
  const s = refusalSignal(message);
  if (s === null) return prev;
  if (s === "cleared") return null;
  return { category: s.category ?? prev?.category ?? null };
}

function normCategory(c: unknown): string | null {
  return typeof c === "string" && /^[a-z0-9_-]{1,32}$/i.test(c) ? c.toLowerCase() : null;
}

export function modelRefusalMessage(category: string | null): string {
  return `The model declined this request (${category ?? "policy"}).`;
}

export function modelRefusalError(r: SdkRefusal): Error {
  return new Error(`${MODEL_REFUSAL_CODE}: ${modelRefusalMessage(r.category)}`);
}

export function parseModelRefusal(rawError: string | null | undefined): string | null {
  if (!rawError) return null;
  const m = /model_refusal: (The model declined this request \([a-z0-9_-]{1,32}\)\.)/i.exec(rawError);
  return m ? m[1] : null;
}
