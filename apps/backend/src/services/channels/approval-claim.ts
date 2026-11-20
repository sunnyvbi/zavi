
const LEAD_CLAUSE = /^\s*(?:the\s+)?(?:founder|owner)[- ]approved\b(?:\s+(?:by|via|in|over|from)\s+[^:\n]{0,160}?)?\s*:\s*/i;
const CLAIM = /\b(?:founder|owner)[- ](?:has\s+|had\s+)?approved\b|\bapproved\s+by\s+(?:the\s+)?(?:founder|owner)\b/i;

export function stripApprovalClaim(text: string): string | null {
  let t = text.replace(LEAD_CLAUSE, "");
  if (t !== text) t = t.charAt(0).toUpperCase() + t.slice(1);
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z(])/);
  const kept = sentences.filter((s) => !CLAIM.test(s));
  const out = (kept.length === sentences.length ? t : kept.join(" ")).trim();
  return out.length > 0 ? out : null;
}

const DISPLAY_KEYS = ["about", "rationale"] as const;

export function withoutApprovalClaim<T extends Record<string, unknown>>(payload: T): T {
  let out: Record<string, unknown> | null = null;
  for (const k of DISPLAY_KEYS) {
    const v = payload[k];
    if (typeof v !== "string" || (!CLAIM.test(v) && !LEAD_CLAUSE.test(v))) continue;
    const clean = stripApprovalClaim(v);
    out = out ?? { ...payload };
    if (clean === null) delete out[k];
    else out[k] = clean;
  }
  return (out ?? payload) as T;
}

function stripProse(text: string): string | null {
  const parts = text.split(/\n\s*\n/);
  const kept = parts.map((p) => (CLAIM.test(p) || LEAD_CLAUSE.test(p) ? stripApprovalClaim(p) : p)).filter((p): p is string => p !== null && p.trim().length > 0);
  return kept.length > 0 ? kept.join("\n\n") : null;
}

export function cardBodyWithoutApprovalClaim<T extends Record<string, unknown>>(body: T): T {
  const step = body.step && typeof body.step === "object" && !Array.isArray(body.step) ? (body.step as Record<string, unknown>) : null;
  let nextStep: Record<string, unknown> | null = null;
  for (const k of ["title", "body"] as const) {
    const v = step?.[k];
    if (typeof v !== "string" || (!CLAIM.test(v) && !LEAD_CLAUSE.test(v))) continue;
    const clean = stripProse(v);
    nextStep = nextStep ?? { ...step };
    if (clean === null) delete nextStep[k];
    else nextStep[k] = clean;
  }
  const sentence = body.change_sentence;
  const cleanSentence = typeof sentence === "string" && (CLAIM.test(sentence) || LEAD_CLAUSE.test(sentence)) ? stripProse(sentence) : undefined;
  if (!nextStep && cleanSentence === undefined) return body;
  const out: Record<string, unknown> = { ...body, ...(nextStep ? { step: nextStep } : {}) };
  if (cleanSentence !== undefined) {
    if (cleanSentence === null) delete out.change_sentence;
    else out.change_sentence = cleanSentence;
  }
  return out as T;
}
