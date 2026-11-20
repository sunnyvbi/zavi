
import { ATTACHMENT_ONLY_TEXT, FILE_TEXT_PREFIX } from "./chat-history";
import { emailsIn } from "./egress-email-provenance";

export function messageText(content: unknown, opts: { withoutFiles?: boolean } = {}): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!b || typeof b !== "object" || (b as { type?: unknown }).type !== "text") return "";
      const t = String((b as { text?: unknown }).text ?? "");
      return opts.withoutFiles && t.startsWith(FILE_TEXT_PREFIX) ? "" : t;
    })
    .join("\n");
}

type Row = { sender_role: string; body: string; meta?: unknown; content_kind?: unknown };

const TYPED_ROW_META_KEYS: ReadonlySet<string> = new Set(["superseded_at", "superseded_by"]);

function typedByTheUser(r: Row): boolean {
  if (r.sender_role !== "user") return false;
  if (r.content_kind != null && r.content_kind !== "text") return false;
  if (r.meta == null) return true;
  if (typeof r.meta !== "object" || Array.isArray(r.meta)) return false;
  return Object.keys(r.meta as Record<string, unknown>).every((k) => TYPED_ROW_META_KEYS.has(k));
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function ownWords(body: string): string {
  const out: string[] = [];
  let open: { ch: string; len: number } | null = null;
  for (const line of body.split("\n")) {
    const m = line.match(FENCE);
    if (open) {
      if (m && m[1][0] === open.ch && m[1].length >= open.len && /^\s*$/.test(m[2])) open = null;
      continue;
    }
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { ch: m[1][0], len: m[1].length };
      continue;
    }
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

export function ownerTextsFromRows(prior: Row[], current: Row | null): string[] {
  const out: string[] = [];
  for (const r of [...prior, ...(current ? [current] : [])]) {
    if (!typedByTheUser(r)) continue;
    const body = typeof r.body === "string" ? r.body : "";
    if (body === ATTACHMENT_ONLY_TEXT || !body.trim()) continue;
    out.push(body);
  }
  return out;
}

export function hasBlockStructure(body: string): boolean {
  if (/<(pre|code|blockquote)\b|<!--/i.test(body)) return true;
  return body.split(/\r?\n/).some((line) => /^\s*(```|~~~|>)/.test(line) || /^(\t| {4,})/.test(line));
}

export function isThreadUsersOwnTurn(
  actor: { actor_source?: unknown; actor_user_id?: unknown } | null | undefined,
  threadUserId: unknown,
): boolean {
  return (
    !!actor &&
    actor.actor_source === "chat" &&
    typeof actor.actor_user_id === "string" &&
    actor.actor_user_id.length > 0 &&
    actor.actor_user_id === threadUserId
  );
}

export function ownerTurnTexts(payload: unknown, trigger: string | undefined): string[] {
  if (trigger !== "chat") return [];
  const list = ((payload ?? {}) as Record<string, unknown>).owner_turn_texts;
  return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string" && t.length > 0) : [];
}

const MAX_OWNER_EMAILS = 2_000;

export function ownerEmailAllowlist(payload: unknown, trigger: string | undefined): string[] {
  const out = new Set<string>();
  for (const t of ownerTurnTexts(payload, trigger)) {
    if (hasBlockStructure(t)) continue;
    for (const e of emailsIn(t)) {
      if (out.size >= MAX_OWNER_EMAILS) return [...out];
      out.add(e);
    }
  }
  return [...out];
}

export function chatVisiblePayload(payload: object, hasChannelPlaybook: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (
      k !== "prior_messages" &&
      k !== "prior_had_attachments" &&
      k !== "owner_turn_texts" &&
      k !== "view_context" &&
      k !== "current_user_text_raw" &&
      k !== "current_message" &&
      k !== "current_message_content" &&
      !(hasChannelPlaybook && k === "recipe_body")
    ) {
      out[k] = v;
    }
  }
  return out;
}
