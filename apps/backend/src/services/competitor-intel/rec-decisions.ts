
export const REC_STATUSES = ["act", "snooze", "dismiss"] as const;
export type RecStatus = (typeof REC_STATUSES)[number];

export const MAX_REC_DECISIONS = 200;
export const MAX_REC_KEY_LEN = 200;
export const MAX_REC_TITLE_LEN = 200;

export type RecDecision = { status: RecStatus; title: string; updated_at: string };
export type RecDecisionMap = Record<string, RecDecision>;

export function recKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim().slice(0, MAX_REC_KEY_LEN);
}

export function isRecStatus(v: unknown): v is RecStatus {
  return typeof v === "string" && (REC_STATUSES as readonly string[]).includes(v);
}

export function coerceDecisions(v: unknown): RecDecisionMap {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: RecDecisionMap = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0 || k.length > MAX_REC_KEY_LEN) continue;
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (!isRecStatus(o.status)) continue;
    out[k] = {
      status: o.status,
      title: typeof o.title === "string" ? o.title.slice(0, MAX_REC_TITLE_LEN) : "",
      updated_at: typeof o.updated_at === "string" ? o.updated_at.slice(0, 40) : "",
    };
    if (Object.keys(out).length >= MAX_REC_DECISIONS) break;
  }
  return out;
}

export type ApplyResult =
  | { ok: true; decisions: RecDecisionMap }
  | { ok: false; code: "bad_status" | "bad_key" | "over_cap"; message: string };

export function applyDecision(
  stored: unknown,
  input: { rec_key?: unknown; title?: unknown; status?: unknown },
  now: string,
): ApplyResult {
  const decisions = coerceDecisions(stored);
  const rawKey = typeof input.rec_key === "string" ? input.rec_key.trim().slice(0, MAX_REC_KEY_LEN) : "";
  if (!rawKey) return { ok: false, code: "bad_key", message: "rec_key required" };
  const title = typeof input.title === "string" ? input.title.slice(0, MAX_REC_TITLE_LEN) : "";

  if (input.status === "clear") {
    delete decisions[rawKey];
    return { ok: true, decisions };
  }
  if (!isRecStatus(input.status)) {
    return {
      ok: false,
      code: "bad_status",
      message: `status must be one of ${REC_STATUSES.join("|")} or "clear"`,
    };
  }
  if (!(rawKey in decisions) && Object.keys(decisions).length >= MAX_REC_DECISIONS) {
    return { ok: false, code: "over_cap", message: `too many decisions: max ${MAX_REC_DECISIONS}` };
  }
  decisions[rawKey] = { status: input.status, title, updated_at: now };
  return { ok: true, decisions };
}
