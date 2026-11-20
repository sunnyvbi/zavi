import { emailFinalRefusal } from "@/services/channels/top-actions";

export type DraftRun = { status: string; finished_at: string | null; enqueued_at?: string | null; payload: unknown; tool_calls: unknown };

const TRANSIENT = new Set(["bulk_sending_paused", "email_card_cap_reached", "email_card_count_unavailable", "email_campaign_propose_unavailable", "top_action_cap", "email_audience_size_unknown"]);

type Trace = { name?: unknown; status?: unknown; code?: unknown; output_preview?: unknown };

function planOf(payload: unknown): { route: string; list_id: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = (payload as { email_plan?: unknown }).email_plan;
  if (!p || typeof p !== "object") return null;
  const { route, list_id } = p as { route?: unknown; list_id?: unknown };
  return typeof route === "string" && typeof list_id === "string" && list_id.length > 0 ? { route, list_id } : null;
}

function everyToolRead(audiences: unknown[], notes: unknown, route: string): { ids: string[]; partial: boolean } | null {
  const ofRoute = (v: unknown) => !!v && typeof v === "object" && (v as { tool?: unknown }).tool === route;
  const rows = audiences.filter(ofRoute);
  const ids = rows.map((a) => (a as { id?: unknown }).id).filter((id): id is string => typeof id === "string");
  if (ids.length !== rows.length) return null;
  const noted = Array.isArray(notes) && notes.some(ofRoute);
  if (ids.length === 0 && !noted) return null;
  return { ids, partial: noted && ids.length > 0 };
}

function audiencesRead(c: Trace, route: string): { ids: string[]; partial: boolean } | null {
  if (typeof c.name !== "string" || !/(?:^|_)email_campaign__list_audiences$/.test(c.name)) return null;
  if (c.status !== "ok" || typeof c.output_preview !== "string") return null;
  let blocks: unknown;
  try {
    blocks = JSON.parse(c.output_preview);
  } catch {
    return null;
  }
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (!b || typeof b !== "object" || (b as { type?: unknown }).type !== "text") continue;
    let out: unknown;
    try {
      out = JSON.parse(String((b as { text?: unknown }).text));
    } catch {
      return null;
    }
    if (!out || typeof out !== "object") return null;
    const o = out as { tool?: unknown; audiences?: unknown; note?: unknown; notes?: unknown };
    if (!Array.isArray(o.audiences)) return null;
    if (o.tool === undefined) return everyToolRead(o.audiences, o.notes, route);
    if (o.tool !== route) return null;
    const ids = o.audiences.map((a) => (a && typeof a === "object" ? (a as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === "string");
    if (ids.length !== o.audiences.length) return null;
    return { ids, partial: o.note !== undefined && ids.length > 0 };
  }
  return null;
}

function listMissing(calls: Trace[], plan: { route: string; list_id: string }): boolean {
  if (plan.route === "zavi_list") return false;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const read = audiencesRead(calls[i], plan.route);
    if (!read) continue;
    return !read.partial && !read.ids.includes(plan.list_id);
  }
  return false;
}

export function draftBlocker(run: DraftRun | null): string | null {
  if (!run || run.status !== "success" || !run.finished_at) return null;
  const plan = planOf(run.payload);
  if (!plan) return null;
  const calls = Array.isArray(run.tool_calls) ? (run.tool_calls as Trace[]) : [];
  const refusal = emailFinalRefusal(calls, plan);
  if (refusal && !TRANSIENT.has(refusal.code)) return refusal.code;
  if (refusal) return null;
  return listMissing(calls, plan) ? "email_audience_missing" : null;
}

export function draftVersionOf(jobKey: string): number | null {
  const m = /:v(\d+)(?::|$)/.exec(jobKey);
  return m ? Number(m[1]) : null;
}
