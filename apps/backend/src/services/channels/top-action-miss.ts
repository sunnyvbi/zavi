import { asTenantId, tenantClient } from "@/services/tenant-client";
import { canCurrentUserReadRun } from "@/services/agents/runner";
import { TOP_ACTIONS, topActionFinalRefusal } from "./top-actions";
import { BULK_REFUSAL_SENTENCES } from "@/services/comms/bulk-outbound/readiness";
import { LIST_GONE_SENTENCE } from "@/services/email-plan/messages";
import { summarizeLedger } from "@/routes/billing/run-credits";
import { emailToolKey, emailToolOf } from "./email-tool-key";

export type TopActionMissRepeat = { title: string; detail: string; credits: string | null; inputs: Record<string, unknown> };
export type TopActionMiss = { run_id: string; key: string; noun: string; reason: string; at: string; repeat?: TopActionMissRepeat };

export const TOP_ACTION_MISS_WINDOW_MS = 24 * 60 * 60 * 1000;
const ENQUEUE_SLACK_MS = 60 * 60 * 1000;
const FALLBACK = "it finished without an email to show you.";
const STOPPED = "it stopped before it finished. Try again.";
const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "timed_out", "dispatch_error", "parse_failed"]);

const REFUSAL_REASONS: Record<string, string> = {
  ...(BULK_REFUSAL_SENTENCES as Record<string, string>),
  zavi_list_not_ready: "Zavi's own sender or this list is not ready to send yet. Finish Sending setup in Email campaigns settings.",
  email_test_list: "That list is marked as a test list, so Zavi never sends a real email to it.",
  email_audience_empty: "That list has nobody on it.",
  email_audience_size_unknown: "Your email tool did not say how many people are on that list.",
  email_sender_unknown: "Zavi could not confirm the sender in your email tool. Check the sender in Email campaigns settings.",
  email_card_cap_reached: "Zavi already filed the most emails it may put up for approval in one day. Try again tomorrow.",
  email_card_count_unavailable: "Zavi could not check how many emails are already waiting for approval. Try again.",
  email_campaign_propose_unavailable: "Zavi could not file an approval card from this run. Try again.",
  top_action_cap: "This action's email was already filed.",
  channel_card_already_done: "You already approved this same email, so Zavi did not file it again. Change the brief to write a new one.",
  channel_card_already_rejected: "You turned this same email down earlier, so Zavi did not file it again. Change the brief to write a new one.",
  email_campaign_body_invalid: "Zavi could not file this email. Try again.",
  channel_action_class_unknown: "Zavi could not file this email. Try again.",
  email_render_missing_postal_address: "Add your business postal address in Email campaigns settings. Every email has to show it.",
  email_render_bad_font: "Your saved email template has a font Zavi cannot use. Fix it in Email campaigns settings.",
  email_render_bad_color: "Your saved email template has a color Zavi cannot use. Fix it in Email campaigns settings.",
  email_tool_not_connected: "No email tool is connected. Connect one in Email campaigns settings.",
  tool_key_rejected: "Your email tool rejected the key Zavi has for it. Connect it again in Email campaigns settings.",
  list_not_found: LIST_GONE_SENTENCE,
  email_audience_missing: LIST_GONE_SENTENCE,
};

export function missReasonFor(payload: unknown, toolCalls: unknown): string {
  const refusal = topActionFinalRefusal(payload, Array.isArray(toolCalls) ? toolCalls : undefined);
  const reason = refusal && REFUSAL_REASONS[refusal.code];
  return reason || FALLBACK;
}

const REPEAT_CHANGE = "Change the brief to write a different one.";
const REPEAT_CODES = new Set(["channel_card_already_done", "channel_card_already_rejected"]);
const CARD_ID = /\(card ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i;

type EarlierCard = { subject: string | null; list: string | null; sent: boolean };

function repeatCode(payload: unknown, toolCalls: unknown): string | null {
  const code = topActionFinalRefusal(payload, Array.isArray(toolCalls) ? toolCalls : undefined)?.code;
  return code && REPEAT_CODES.has(code) ? code : null;
}

function earlierCardId(toolCalls: unknown, code: string): string | null {
  if (!Array.isArray(toolCalls)) return null;
  for (const c of [...toolCalls].reverse()) {
    const t = c as { code?: unknown; output_preview?: unknown };
    if (t.code !== code || typeof t.output_preview !== "string") continue;
    return CARD_ID.exec(t.output_preview)?.[1] ?? null;
  }
  return null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function earlierSubject(p: Record<string, unknown>): string | null {
  const variants = Array.isArray(p.variants) ? (p.variants as Array<{ content?: { subject?: unknown } }>) : [];
  const chosen = typeof p.chosen_variant === "number" ? variants[p.chosen_variant - 1] : undefined;
  return text((chosen ?? variants[0])?.content?.subject);
}

async function readEarlierCard(db: Db, id: string | null): Promise<EarlierCard | null> {
  if (!id) return null;
  try {
    const { data, error } = await db.from("channel_actions").select("exec_status, exec_payload").eq("id", id).maybeSingle();
    if (error || !data) return null;
    const row = data as { exec_status?: unknown; exec_payload?: unknown };
    const p = (row.exec_payload ?? {}) as Record<string, unknown>;
    return { subject: earlierSubject(p), list: text(p.audience_name) ?? text(p.list_name), sent: row.exec_status === "executed" };
  } catch {
    return null;
  }
}

export function repeatWords(code: string, card: EarlierCard | null): Pick<TopActionMissRepeat, "title" | "detail"> {
  const name = card?.subject ?? "This email";
  const list = card?.list ?? null;
  if (code === "channel_card_already_rejected") {
    return { title: "You turned this email down earlier", detail: `${card?.subject && list ? `${card.subject} was for ${list}. ` : ""}${REPEAT_CHANGE}` };
  }
  if (card?.sent) return { title: "You already sent this email", detail: `${list ? `${name} went to ${list}. ` : ""}${REPEAT_CHANGE}` };
  return { title: "You already approved this email", detail: `${card?.subject && list ? `${name} is approved for ${list}. ` : ""}${REPEAT_CHANGE}` };
}

function repeatInputs(def: { inputs: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } }, payload: unknown): Record<string, unknown> | null {
  const parsed = def.inputs.safeParse((payload as { top_action?: { inputs?: unknown } } | null)?.top_action?.inputs);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

type RunRow = { id: string; status: string | null; payload: unknown; tool_calls: unknown; finished_at: string | null };

type LaterCard = { decision_class: string; match: Array<[string, string]> };

function laterCardFor(def: { inputs: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } }, payload: unknown): LaterCard | null {
  const raw = (payload as { top_action?: { inputs?: unknown } } | null)?.top_action?.inputs;
  const parsed = def.inputs.safeParse(raw);
  if (!parsed.success) return null;
  const i = parsed.data as { route?: unknown; list_id?: unknown };
  if (typeof i.route !== "string" || typeof i.list_id !== "string") return null;
  return i.route === "zavi_list"
    ? { decision_class: "bulk_outbound.send", match: [["body->>list_id", i.list_id.toLowerCase()]] }
    : { decision_class: "email_campaign.create_and_send", match: [["body->>tool", i.route], ["body->>audience_id", i.list_id]] };
}

function filedCard(toolCalls: unknown, tool: string): boolean {
  if (!Array.isArray(toolCalls)) return false;
  const want = tool.replace(/_+/g, "_").toLowerCase();
  return toolCalls.some((c) => {
    const t = c as { name?: unknown; status?: unknown };
    return typeof t.name === "string" && t.name.replace(/^mcp__server__/, "").replace(/_+/g, "_").toLowerCase() === want && t.status === "ok";
  });
}

async function keyWorksAgain(tenant_id: string, run: RunRow, now: number): Promise<boolean> {
  if (run.status !== "success") return false;
  const refusal = topActionFinalRefusal(run.payload, Array.isArray(run.tool_calls) ? run.tool_calls : undefined);
  if (refusal?.code !== "tool_key_rejected") return false;
  const tool = emailToolOf((run.payload as { top_action?: { inputs?: { route?: unknown } } } | null)?.top_action?.inputs?.route);
  return tool !== null && (await emailToolKey(tenant_id, tool, { now })).state === "works";
}

export async function readTopActionMiss(tenant_id: string, user_id: string, slug: string, now: number = Date.now()): Promise<TopActionMiss | null> {
  const defs = Object.prototype.hasOwnProperty.call(TOP_ACTIONS, slug) ? TOP_ACTIONS[slug] : {};
  const db = tenantClient(asTenantId(tenant_id));
  let found: TopActionMiss | null = null;
  let foundLater: LaterCard | null = null;
  let foundRepeat: { code: string; card_id: string | null; inputs: Record<string, unknown> } | null = null;
  for (const [key, def] of Object.entries(defs)) {
    if (!def.missNoun || !def.retry) continue;
    const { data, error } = await db
      .from("agent_runs")
      .select("id, status, payload, tool_calls, finished_at")
      .eq("channel_slug", slug)
      .eq("payload->top_action->>key", key)
      .gte("enqueued_at", new Date(now - TOP_ACTION_MISS_WINDOW_MS - ENQUEUE_SLACK_MS).toISOString())
      .order("enqueued_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const run = ((data ?? []) as RunRow[])[0];
    if (!run || !run.finished_at || (run.status !== "success" && !FAILED_STATUSES.has(run.status ?? ""))) continue;
    if (now - Date.parse(run.finished_at) > TOP_ACTION_MISS_WINDOW_MS) continue;
    if (filedCard(run.tool_calls, def.retry.tool)) continue;
    if (found && Date.parse(found.at) >= Date.parse(run.finished_at)) continue;
    if (!(await canCurrentUserReadRun(user_id, run.id))) continue;
    if (await keyWorksAgain(tenant_id, run, now)) continue;
    const reason = run.status === "success" ? missReasonFor(run.payload, run.tool_calls) : STOPPED;
    found = { run_id: run.id, key, noun: def.missNoun, reason, at: run.finished_at };
    foundLater = laterCardFor(def, run.payload);
    const code = run.status === "success" ? repeatCode(run.payload, run.tool_calls) : null;
    const inputs = code ? repeatInputs(def, run.payload) : null;
    foundRepeat = code && inputs ? { code, card_id: earlierCardId(run.tool_calls, code), inputs } : null;
  }
  if (!found) return null;
  if (foundLater) {
    let q = db.from("decisions").select("id").eq("decision_class", foundLater.decision_class);
    for (const [k, v] of foundLater.match) q = q.eq(k, v);
    const later = await q.gt("emitted_at", found.at).limit(1);
    if (later.error) throw new Error(later.error.message);
    if ((later.data ?? []).length > 0) return null;
  }
  const spent = await creditsSentence(db, found.run_id);
  const withCredits = spent ? { ...found, reason: `${withStop(found.reason)} ${spent}` } : found;
  if (!foundRepeat) return withCredits;
  const words = repeatWords(foundRepeat.code, await readEarlierCard(db, foundRepeat.card_id));
  return { ...withCredits, repeat: { ...words, credits: spent === creditsUsedSentence(0) ? null : spent, inputs: foundRepeat.inputs } };
}

function withStop(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

export function creditsUsedSentence(credits: number): string {
  if (credits <= 0) return "This attempt used no credits.";
  return `This attempt used ${credits.toLocaleString("en-US")} ${credits === 1 ? "credit" : "credits"}.`;
}

type Db = ReturnType<typeof tenantClient>;

async function creditsSentence(db: Db, run_id: string): Promise<string | null> {
  const ledger = await db
    .from("tenant_credit_ledger")
    .select("run_id, kind, amount, attempt, debited, debited_daily")
    .in("kind", ["reserve", "settle", "refund"])
    .eq("run_id", run_id);
  if (ledger.error) return null;
  const charges = await db.from("tool_charges").select("run_id, refunded_daily, refunded_included, refunded_purchased").eq("run_id", run_id);
  if (charges.error) return null;
  const back = ((charges.data ?? []) as Array<{ refunded_daily: number | null; refunded_included: number | null; refunded_purchased: number | null }>).reduce(
    (total, c) => total + (c.refunded_daily ?? 0) + (c.refunded_included ?? 0) + (c.refunded_purchased ?? 0),
    0,
  );
  const entry = summarizeLedger(
    (ledger.data ?? []) as Parameters<typeof summarizeLedger>[0],
    new Map([[run_id.toLowerCase(), back]]),
  );
  if (entry.status === "pending" || entry.status === "none") return null;
  return creditsUsedSentence(entry.credits);
}
