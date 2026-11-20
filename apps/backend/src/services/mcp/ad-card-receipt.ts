
import { CHANNELS } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { McpCallResult } from "./types";

const AD_SERVERS: ReadonlySet<string> = new Set([
  "meta_ads",
  "google_ads",
  "tiktok_ads",
  "reddit_ads",
  "linkedin_ads",
  "x_ads",
  "chatgpt_ads",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AD_CLASS_RE = /^(meta_ads|google_ads|chatgpt_ads|linkedin_ads|reddit_ads|tiktok_ads|x_ads)\./;

const PLATFORM: Record<string, string> = {
  meta_ads: "Meta",
  google_ads: "Google",
  chatgpt_ads: "ChatGPT",
  linkedin_ads: "LinkedIn",
  reddit_ads: "Reddit",
  tiktok_ads: "TikTok",
  x_ads: "X",
};

export const RECEIPT_WAIT_MS = 15_000;
export const RECEIPT_HARD_LIMIT_MS = 18_000;
const POLL_MS = 1_000;
const STALE_PROPOSAL_STATUSES: ReadonlySet<string> = new Set(["waiting_for_founder", "waiting_for_approval", "proposed", "pending"]);

export type CardStatus =
  | "waiting_for_approval"
  | "approved_by_autopilot"
  | "approved_in_progress"
  | "direct_ask_launching"
  | "carried_out"
  | "created_not_live"
  | "uncertain"
  | "failed"
  | "closed";

export type CardRead = {
  table: "decisions" | "channel_actions";
  cls: string;
  phase: "waiting" | "running" | "done" | "failed" | "uncertain" | "held" | "closed" | "auto";
  by_cgo: boolean;
  reason: string | null;
  notice: string | null;
  created_status?: string | null;
  direct_ask?: boolean;
  founder_order?: boolean;
  hold_words?: string[] | null;
  chat_card?: boolean;
  channel_slug?: string | null;
};

type Deps = {
  readCard: (tenant_id: string, id: string) => Promise<CardRead | null>;
  readNewStatus: (tenant_id: string, table: CardRead["table"], id: string) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function decisionPhase(row: { status?: unknown; autonomy_at_emit?: unknown; dispatch_error?: unknown; cgo_hold?: unknown }): CardRead["phase"] {
  const s = String(row.status ?? "");
  if (s === "proposed") {
    if (row.autonomy_at_emit === "auto") return "auto";
    return str(row.dispatch_error) || (row.cgo_hold != null && typeof row.cgo_hold === "object") ? "held" : "waiting";
  }
  if (s === "approved" || s === "dispatching") return "running";
  if (s === "acted") return "done";
  if (s === "dispatch_failed") return "failed";
  return "closed";
}

const OPEN_ACTION_STATUSES: ReadonlySet<string> = new Set(["pending", "snoozed"]);

export function channelActionPhase(row: { status?: unknown; exec_status?: unknown; exec_result?: unknown }): CardRead["phase"] {
  const exec = row.exec_status == null ? null : String(row.exec_status);
  const result = (row.exec_result && typeof row.exec_result === "object" ? row.exec_result : {}) as Record<string, unknown>;
  const open = OPEN_ACTION_STATUSES.has(String(row.status ?? ""));
  if (exec === "queued" || exec === "dispatching") return "running";
  if (exec === "executed") return "done";
  if (exec === "failed") {
    if (result.held_for_founder === true && open) return "held";
    if (result.bucket === "partial_risk" || result.code === "exec_outcome_unknown") return "uncertain";
    return "failed";
  }
  return open ? "waiting" : "closed";
}

export async function readCardDefault(tenant_id: string, id: string): Promise<CardRead | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const dec = await db
    .from("decisions")
    .select("status, decision_class, approved_by_source, autonomy_at_emit, dispatch_error, cgo_hold, origin:body->>origin")
    .eq("id", id)
    .maybeSingle();
  if (dec.error) throw new Error(dec.error.message);
  if (dec.data) {
    const r = dec.data as Record<string, unknown>;
    const te = await db
      .from("thread_event")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("kind", "decision")
      .eq("body->>decision_id", id)
      .limit(1);
    if (te.error) throw new Error(te.error.message);
    const words = (r.cgo_hold as { words?: unknown } | null)?.words;
    return {
      table: "decisions",
      cls: String(r.decision_class ?? ""),
      phase: decisionPhase(r),
      by_cgo: r.approved_by_source === "cgo",
      reason: str(r.dispatch_error),
      notice: null,
      founder_order: r.origin === "user_initiated_chat",
      hold_words: Array.isArray(words) ? words.filter((w): w is string => typeof w === "string" && w.trim().length > 0).slice(0, 2) : null,
      chat_card: ((te.data ?? []) as unknown[]).length > 0,
    };
  }
  const ca = await db
    .from("channel_actions")
    .select("status, exec_status, exec_class, exec_result, approved_by_source, note, approval_envelope, channel_slug")
    .eq("id", id)
    .maybeSingle();
  if (ca.error) throw new Error(ca.error.message);
  if (!ca.data) return null;
  const r = ca.data as Record<string, unknown>;
  const result = (r.exec_result && typeof r.exec_result === "object" ? r.exec_result : {}) as Record<string, unknown>;
  return {
    table: "channel_actions",
    cls: String(r.exec_class ?? ""),
    phase: channelActionPhase(r),
    by_cgo: r.approved_by_source === "cgo",
    reason: str(r.note) ?? str(result.error),
    notice: str(result.notice),
    created_status: str((result.created as { status?: unknown } | undefined)?.status),
    direct_ask: String((r.approval_envelope as { envelope_id?: unknown } | null)?.envelope_id ?? "").startsWith("ask:"),
    channel_slug: str(r.channel_slug),
  };
}

export function whereToApprove(card: Pick<CardRead, "table" | "chat_card" | "channel_slug" | "cls">): string {
  if (card.table === "channel_actions") {
    const slug = card.channel_slug ?? card.cls.split(".")[0];
    const name = CHANNELS.find((c) => c.slug === slug)?.name ?? "channel";
    return `The founder can approve it on the ${name} tile`;
  }
  if (card.chat_card) return "Its card is in the chat now and waits for the founder's tap";
  return "The founder can approve it on the Growth page";
}

const DIRECT_ASK_RUNNING = (platform: string) =>
  `The founder asked for this directly, so it needs no approval card and ${platform} is being set up now. Zavi posts how it ended in this conversation itself, after your reply. Do not describe its status (live, approved, pending, being set up, waiting for approval); say only that Zavi will post the result here.`;
const DIRECT_ASK_POSTED = " Zavi posts this result in the founder's conversation itself, after your reply; do not restate it differently.";

async function readNewStatusDefault(tenant_id: string, table: CardRead["table"], id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("ad_object_changes")
    .select("after_status, occurred_at")
    .eq("action_table", table)
    .eq("action_id", id)
    .eq("change_kind", "status")
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return str(((data ?? []) as Array<{ after_status?: unknown }>)[0]?.after_status);
}

const DEFAULT_DEPS: Deps = {
  readCard: readCardDefault,
  readNewStatus: readNewStatusDefault,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

const CREATES_RE = /\.(create|launch|duplicate)/;
const ON_STATUSES: ReadonlySet<string> = new Set(["ACTIVE", "ENABLED"]);

export function receiptFor(card: CardRead, newStatus: string | null): { card_status: CardStatus; receipt: string } | null {
  const r = baseReceipt(card, newStatus);
  if (r && card.direct_ask && (r.card_status === "carried_out" || r.card_status === "created_not_live" || r.card_status === "failed")) return { ...r, receipt: r.receipt + DIRECT_ASK_POSTED };
  return r;
}

function baseReceipt(card: CardRead, newStatus: string | null): { card_status: CardStatus; receipt: string } | null {
  const platform = PLATFORM[card.cls.split(".")[0]] ?? "the ad platform";
  const who = card.direct_ask ? "The founder asked for it" : card.by_cgo ? "Autopilot approved it" : "It was approved";
  switch (card.phase) {
    case "waiting":
      return {
        card_status: "waiting_for_approval",
        receipt: `${card.founder_order ? "The founder asked for this. " : "Filed and waiting for the founder's approval. "}${whereToApprove(card)}. Nothing has changed in the ad account yet; do not say it is live or applied.`,
      };
    case "held": {
      const why = card.hold_words?.length ? `: ${card.hold_words.join("; ")}` : card.reason ? `: ${card.reason}` : "";
      return {
        card_status: "waiting_for_approval",
        receipt: `Autopilot held this for the founder${why}. ${whereToApprove(card)}; nothing has changed in the ad account.`,
      };
    }
    case "running":
      return {
        card_status: card.direct_ask ? "direct_ask_launching" : card.by_cgo ? "approved_by_autopilot" : "approved_in_progress",
        receipt: card.direct_ask ? DIRECT_ASK_RUNNING(platform) : `${who}; it is still being set up on ${platform}. Check the card before saying it is live.`,
      };
    case "done": {
      const state = newStatus ?? card.created_status ?? null;
      const on = state !== null && ON_STATUSES.has(state.toUpperCase());
      if (state && (on || !CREATES_RE.test(card.cls))) {
        return { card_status: "carried_out", receipt: `${who}; Zavi set it to ${state} on ${platform}.` };
      }
      const line = card.notice ? `${who}; done on ${platform}. ${card.notice}` : `${who}; it was carried out on ${platform}.`;
      if (CREATES_RE.test(card.cls)) {
        return {
          card_status: "created_not_live",
          receipt: `${line} ${
            state === "UNVERIFIED" ? `${platform} has not confirmed the switch-on yet` : state ? `${platform} reports it as ${state} so far` : "Zavi has no record of switching it on"
          }, so do not say it is live.`,
        };
      }
      return { card_status: "carried_out", receipt: line };
    }
    case "uncertain":
      return {
        card_status: "uncertain",
        receipt: `${who}, but it may have only partly gone through on ${platform}${card.reason ? `: ${card.reason}` : ""}. Check the card and the account before saying what changed.`,
      };
    case "failed":
      return { card_status: "failed", receipt: `${who}, but it failed on ${platform}${card.reason ? `: ${card.reason}` : ""}.` };
    case "closed":
      return { card_status: "closed", receipt: "This card is closed; it will not run." };
    case "auto":
      return null;
  }
}

export async function withAdCardReceipt(
  ctx: { tenant_id: string; writes_suppressed?: boolean },
  server_id: string,
  res: McpCallResult,
  deps: Deps = DEFAULT_DEPS,
  hardLimitMs: number = RECEIPT_HARD_LIMIT_MS,
): Promise<McpCallResult> {
  if (!AD_SERVERS.has(server_id) || res.is_error || ctx.writes_suppressed) return res;
  let out: Record<string, unknown>;
  try {
    const parsed = JSON.parse(res.content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return res;
    out = parsed as Record<string, unknown>;
  } catch {
    return res;
  }
  const id = str(out.decision_id) ?? str(out.action_id);
  if (!id || !UUID_RE.test(id)) return res;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<McpCallResult>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[ad-card-receipt] card ${id}: no answer in ${hardLimitMs} ms; tool result left as is`);
      resolve(res);
    }, hardLimitMs);
  });
  try {
    return await Promise.race([enrich(ctx.tenant_id, id, out, res, deps), limit]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function enrich(tenant_id: string, id: string, out: Record<string, unknown>, res: McpCallResult, deps: Deps): Promise<McpCallResult> {
  try {
    let card = await deps.readCard(tenant_id, id);
    if (!card || !AD_CLASS_RE.test(card.cls)) return res;
    const deadline = deps.now() + RECEIPT_WAIT_MS;
    while (card.phase === "running" && deps.now() < deadline) {
      await deps.sleep(POLL_MS);
      const next = await deps.readCard(tenant_id, id);
      if (!next) break;
      card = next;
    }
    const newStatus = card.phase === "done" ? await deps.readNewStatus(tenant_id, card.table, id) : null;
    const r = receiptFor(card, newStatus);
    if (!r) {
      if (card.phase === "auto" && !("will_auto_apply" in out)) {
        return { ...res, content: JSON.stringify({ ...out, will_auto_apply: true }) };
      }
      return res;
    }
    const rest: Record<string, unknown> = { ...out };
    if (card.phase === "closed") rest.will_auto_apply = false;
    if (card.phase === "waiting" || card.phase === "held") {
      rest.will_auto_apply = false;
      if ("decision_class" in rest) rest.decision_class = card.cls;
      delete rest.notice;
    }
    if (r.card_status !== "waiting_for_approval" && r.card_status !== "closed") {
      delete rest.notice;
      delete rest.note;
      delete rest.message;
      if (card.direct_ask && card.phase !== "uncertain") delete rest.say_to_founder;
      if (typeof rest.status === "string" && STALE_PROPOSAL_STATUSES.has(rest.status)) delete rest.status;
      rest.will_auto_apply = card.by_cgo;
      if (card.direct_ask) delete rest.will_auto_apply;
    }
    return { ...res, content: JSON.stringify({ card_status: r.card_status, receipt: r.receipt, checked_at: new Date(deps.now()).toISOString(), ...rest }) };
  } catch (e) {
    console.warn(`[ad-card-receipt] card ${id} not read; tool result left as is: ${(e as Error).message}`);
    return res;
  }
}
