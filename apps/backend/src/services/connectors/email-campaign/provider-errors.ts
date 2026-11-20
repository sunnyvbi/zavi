
import { KLAVIYO_KEY_INSTRUCTION } from "./klaviyo-scopes";

export class EmailToolError extends Error {
  constructor(
    message: string,
    public readonly outcome_unknown = false,
    public readonly status: number | null = null,
    public readonly retry_after_s: number | null = null,
    public readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "EmailToolError";
  }
}

const SAYS_KEY_INVALID = /\b(api|private)[ _-]?key\b[\s\S]{0,80}\b(invalid|not valid|revoked|expired|disabled|deactivated|incorrect)\b|\b(invalid|incorrect|revoked|expired)\b[\s\S]{0,40}\b(api|private)[ _-]?key\b/i;

const SAYS_NO_PERMISSION = /\bpermissions?\b|\bscopes?\b|\baccess denied\b|\bdo(es)? not have access\b/i;

const ACCOUNT_HELD = /\bsuspend|\bcompliance\b|\bunder review\b|\bin review\b|\baccount (has been |is )?(disabled|deactivated|closed|locked|paused|on hold)\b|\buser disabled\b/i;

export function isKeyRejected(e: unknown): boolean {
  if (!(e instanceof EmailToolError)) return false;
  const said = toolSaid(e);
  return e.status === 401 || (e.status === 403 && (SAYS_KEY_INVALID.test(said) || SAYS_NO_PERMISSION.test(said)) && !ACCOUNT_HELD.test(said));
}

export function toolSaid(e: EmailToolError): string {
  return e.detail ? `${e.message} ${e.detail}` : e.message;
}

export function isAccountHeld(text: string | null | undefined): boolean {
  return ACCOUNT_HELD.test(text ?? "");
}

export function accountHeldReason(label: string): string {
  return `your ${label} account is on hold, suspended or under a compliance review; check your account status and any message from ${label}, then approve it again`;
}

export function vendorRefusal(data: unknown): { status: number | null; said: string } | null {
  const queue: unknown[] = [data];
  for (let i = 0; i < queue.length && i < 8; i++) {
    const d = queue[i];
    if (!d || typeof d !== "object" || Array.isArray(d)) continue;
    const o = d as Record<string, unknown>;
    const n = Number(o.status ?? o.status_code ?? o.http_status);
    const status = Number.isInteger(n) && n >= 400 && n < 600 ? n : null;
    const errObj = o.error && typeof o.error === "object" && !Array.isArray(o.error) ? (o.error as Record<string, unknown>) : null;
    const words = [o.detail, o.title, o.error, errObj?.message, o.message].find((w): w is string => typeof w === "string" && w.trim() !== "");
    const refused =
      status !== null ||
      o.successful === false ||
      String(o.status).toLowerCase() === "error" ||
      (Array.isArray(o.errors) && o.errors.length > 0) ||
      (typeof o.detail === "string" && (typeof o.title === "string" || typeof o.type === "string")) ||
      (typeof o.error === "string" && o.error.trim() !== "") ||
      errObj !== null;
    if (refused) return { status, said: (words ?? "").trim().slice(0, 300) };
    for (const k of ["data", "response_data"]) if (k in o) queue.push(o[k]);
  }
  return null;
}

function parsedBody(error: unknown): unknown {
  if (typeof error !== "string") return error;
  try {
    return JSON.parse(error);
  } catch {
    return null;
  }
}

function firstErrorWords(body: unknown): string | null {
  const errors = (body as { errors?: unknown } | null)?.errors;
  const first = Array.isArray(errors) ? (errors[0] as Record<string, unknown> | undefined) : undefined;
  const words = [first?.detail, first?.title, first?.message].find((w): w is string => typeof w === "string" && w.trim() !== "");
  return words ?? null;
}

export function vendorReason(label: string, data: unknown, error: unknown): string | null {
  const body = parsedBody(error);
  const text = typeof error === "string" ? error : "";
  const candidates = [vendorRefusal(data)?.said, firstErrorWords(data), vendorRefusal(body)?.said, firstErrorWords(body), /\bDetail:\s*(.+)$/s.exec(text)?.[1], text];
  for (const c of candidates) {
    const s = c?.trim();
    if (!s) continue;
    const said = plainToolSentence(/[.!?]$/.test(s) ? s : `${s}.`, label);
    if (said) return said.replace(/[.!?]+$/, "");
  }
  return null;
}

export const RECONNECT_ANY_EMAIL_TOOL = "reconnect it: sign in again for Mailchimp, or paste a new API key for SendGrid or Klaviyo";

export const REDRAFT_AFTER_RECONNECT = "Emails drafted before you reconnect will not send, even approved or scheduled ones: ask Zavi to draft them again.";

function reconnectStep(label: string): string {
  if (label === "Mailchimp") return "connect it again and sign in";
  if (label === "SendGrid" || label === "Klaviyo") return "reconnect it with a new API key that has every permission Zavi needs";
  return RECONNECT_ANY_EMAIL_TOOL;
}

export const KEY_REJECTED_WHY = "(it was revoked, is no longer valid, or lacks a permission Zavi needs)";

export function keyRejectedText(label: string): string {
  const klaviyo = label === "Klaviyo" ? ` ${KLAVIYO_KEY_INSTRUCTION}` : "";
  return `${label} rejected the key Zavi has saved for it ${KEY_REJECTED_WHY}. Waiting will not fix this: go to Connectors, disconnect ${label}, then ${reconnectStep(label)}. ${REDRAFT_AFTER_RECONNECT}${klaviyo}`;
}

export function toolErrorText(error: unknown, status: number): string {
  const text = typeof error === "string" ? error : error ? JSON.stringify(error) : `HTTP ${status}`;
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[an email address]").slice(0, 300);
}

const AUDIENCE_GONE = /recipients(\.|__)list(_|__)id/;

const RAW_TOOL_TEXT = /\bHTTP\b|[Ss]tatus code \d|\d{4,}|\b[A-Z]{5,}\b|[A-Za-z]Error:|\b[Aa][Pp][Ii][ _-]?[Kk]ey\b|\b(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{12,}\b/;

const PLAIN_TOOL_TEXT = /^[A-Za-z0-9 ,.;:'\u2018\u2019!?()&%$#+\-\u2013\u2014]+$/;

export function plainToolSentence(message: string, label: string): string | null {
  const s = message.trim();
  if (s.length < 8 || s.length > 200 || !PLAIN_TOOL_TEXT.test(s) || /https?:|^(HTTP|status) \d+$/i.test(s) || RAW_TOOL_TEXT.test(s) || !/[.!?]$/.test(s)) return null;
  return (s.match(/[A-Za-z]*[a-z][A-Z][A-Za-z]*/g) ?? []).every((w) => w === label) ? s : null;
}

export function toolRefusalText(label: string, message: string): string {
  if (AUDIENCE_GONE.test(message)) return `${label} no longer has the list this email was drafted for. Nothing was sent. Ask Zavi to draft it again.`;
  const said = plainToolSentence(message, label);
  return `${label} did not accept this email.${said ? ` ${label} said: "${said}"` : ""} Nothing was sent.`;
}
