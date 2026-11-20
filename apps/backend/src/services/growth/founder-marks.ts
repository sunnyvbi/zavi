
export type ServerFounder = { group: string | null; unverified: boolean } | null;

const NEVER_STAMPED: ReadonlySet<string> = new Set(["meta_ads.pause_past_cut_guard", "meta_ads.replace_ad_set_geo_review"]);

export const FOUNDER_STAMPED_CLASS = /^(meta_ads|google_ads)\./;
const MARKS = ["founder_chat_order", "founder_order_unverified", "move_group"] as const;
export const SERVER_ONLY = ["move_after", "budget_choice", "retry_of"] as const;

export function serverFounderMarks(decision_class: string, body: unknown, founder: ServerFounder): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const stamp = founder !== null && FOUNDER_STAMPED_CLASS.test(decision_class) && !NEVER_STAMPED.has(decision_class);
  if (!stamp && !MARKS.some((k) => k in b) && !SERVER_ONLY.some((k) => k in b)) return body;
  const out: Record<string, unknown> = { ...b };
  for (const k of MARKS) delete out[k];
  for (const k of SERVER_ONLY) delete out[k];
  if (!stamp) return out;
  delete out.authorized_effective_cap;
  if (out.origin !== "user_initiated_ledger") out.origin = "user_initiated_chat";
  out.founder_chat_order = true;
  if (founder!.unverified) out.founder_order_unverified = true;
  if (founder!.group) out.move_group = founder!.group;
  return out;
}
