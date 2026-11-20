
import { type EmailTool, type ProviderCall, type StoredContent } from "./providers";
import { EMAIL_PROVIDERS } from "./providers";

export type VerifyMode = "shadow" | "enforce";

export type Canonicalizer = {
  name: string;
  fixture: string;
  html?: (stored: string, sealed: string) => string | null;
  text?: (stored: string, sealed: string) => string | null;
};

export const CANONICALIZERS: Readonly<Record<EmailTool, readonly Canonicalizer[]>> = {
  sendgrid: [],
  mailchimp: [],
  klaviyo: [],
};

export function normalizePart(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

const HREF = /href=(["'])(.*?)\1/g;
const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export function trackingRewrite(name: string, fixture: string, pattern: RegExp, decode: (href: string) => string | null): Canonicalizer {
  return {
    name,
    fixture,
    html: (stored, sealed) => {
      const sealedHrefs = [...sealed.matchAll(HREF)].map((m) => m[2]);
      let i = 0;
      let failed = false;
      const out = stored.replace(HREF, (whole, q: string, href: string) => {
        const want = sealedHrefs[i++];
        if (want === undefined) {
          failed = true;
          return whole;
        }
        if (!pattern.test(decodeEntities(href))) return whole;
        const dest = decode(decodeEntities(href));
        if (dest === null || dest !== decodeEntities(want)) {
          failed = true;
          return whole;
        }
        return `href=${q}${want}${q}`;
      });
      return failed || i !== sealedHrefs.length ? null : out;
    },
  };
}

export type CompareVerdict = { status: "match" } | { status: "changed"; parts: Array<"html" | "text">; canonicalized: string[] } | { status: "unprovable"; why: string };

export function compareContent(tool: EmailTool, sealed: { html: string; text: string }, stored: StoredContent, canonicalizers: readonly Canonicalizer[] = CANONICALIZERS[tool]): CompareVerdict {
  if (stored.proof !== "ok") return { status: "unprovable", why: stored.why };
  let html = stored.html;
  let text = stored.text;
  const used: string[] = [];
  for (const c of canonicalizers) {
    const h = c.html ? c.html(html, sealed.html) : html;
    const t = c.text ? c.text(text, sealed.text) : text;
    if (h !== null && t !== null && (h !== html || t !== text)) {
      html = h;
      text = t;
      used.push(c.name);
    }
  }
  const parts: Array<"html" | "text"> = [];
  if (normalizePart(html) !== normalizePart(sealed.html)) parts.push("html");
  if (normalizePart(text) !== normalizePart(sealed.text)) parts.push("text");
  return parts.length === 0 ? { status: "match" } : { status: "changed", parts, canonicalized: used };
}

export const READ_DEADLINE_MS = 20_000;

class ReadTimeout extends Error {}
const READ_RETRIES = 2;

export type UnreadableReason = "read_failed" | "read_timeout";
export type ReadVerdict = CompareVerdict | { status: "unreadable"; why: UnreadableReason };

export async function readAndCompare(
  tool: EmailTool,
  call: ProviderCall,
  campaignId: string,
  sealed: { html: string; text: string },
  opts: { deadlineMs?: number; sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<ReadVerdict> {
  const deadline = Date.now() + (opts.deadlineMs ?? READ_DEADLINE_MS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  let lastWhy: UnreadableReason = "read_failed";
  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stored = await Promise.race([
        EMAIL_PROVIDERS[tool].readContent(call, campaignId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ReadTimeout()), left);
        }),
      ]);
      return compareContent(tool, sealed, stored);
    } catch (e) {
      lastWhy = e instanceof ReadTimeout ? "read_timeout" : "read_failed";
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (attempt < READ_RETRIES) {
      const wait = Math.min(250 + Math.floor(random() * 500) * (attempt + 1), Math.max(0, deadline - Date.now()));
      if (wait > 0) await sleep(wait);
    }
  }
  return { status: "unreadable", why: lastWhy };
}

export function verifyModeFrom(blob: unknown, tool: EmailTool): VerifyMode {
  const v = (blob as { email_content_verify?: Record<string, unknown> } | null)?.email_content_verify?.[tool];
  return v === "enforce" ? "enforce" : "shadow";
}

const MODE_TTL_MS = 60_000;
export const MODE_READ_DEADLINE_MS = 1_500;
const lastKnown = new Map<EmailTool, { mode: VerifyMode; at: number }>();
let inflight: Promise<unknown> | null = null;

export type ReadBlob = (signal: AbortSignal) => Promise<unknown>;

const readConfigBlob: ReadBlob = async (signal) => {
  const { globalClient } = await import("@/services/tenant-client");
  const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).abortSignal(signal).maybeSingle();
  if (error) throw new Error("system_config read failed");
  return (data as { blob?: unknown } | null)?.blob ?? null;
};

function sharedConfigRead(readBlob: ReadBlob): Promise<unknown> {
  if (inflight) return inflight;
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read: Promise<unknown> = Promise.race([
    readBlob(ac.signal),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error("deadline"));
      }, MODE_READ_DEADLINE_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    if (inflight === read) inflight = null;
  });
  inflight = read;
  return read;
}

export async function readVerifyMode(tool: EmailTool, deps: { readBlob?: ReadBlob; now?: () => number } = {}): Promise<VerifyMode> {
  const now = deps.now ?? Date.now;
  const known = lastKnown.get(tool);
  if (known && now() - known.at < MODE_TTL_MS) return known.mode;
  try {
    const blob = await sharedConfigRead(deps.readBlob ?? readConfigBlob);
    const mode = verifyModeFrom(blob, tool);
    lastKnown.set(tool, { mode, at: now() });
    return mode;
  } catch {
    if (known) return known.mode;
    console.warn(`[email-content-verify] mode for ${tool} unreadable and none known yet: shadow`);
    return "shadow";
  }
}

export function resetVerifyModeCache(): void {
  lastKnown.clear();
  inflight = null;
  lastAlertAt.clear();
}

export type VerifyCode = "email_content_changed" | "email_content_unverifiable";

export function verdictCode(v: ReadVerdict): VerifyCode | null {
  if (v.status === "match") return null;
  return v.status === "changed" ? "email_content_changed" : "email_content_unverifiable";
}

const ALERT_EVERY_MS = 60 * 60_000;
const lastAlertAt = new Map<string, number>();
export function verdictDetail(v: ReadVerdict): string {
  if (v.status === "changed") return `changed:${v.parts.join("+")}`;
  if (v.status === "unreadable") return `unreadable:${v.why}`;
  if (v.status === "unprovable") return "unprovable";
  return "match";
}

export async function reportContentVerdict(
  tenantId: string,
  tool: EmailTool,
  stage: "before_send" | "test_send" | "after_send",
  v: ReadVerdict,
  mode: VerifyMode,
): Promise<void> {
  const code = verdictCode(v);
  if (!code) return;
  const event = stage === "after_send" ? (code === "email_content_changed" ? "sent_content_changed" : "sent_content_unverifiable") : code;
  const { sanitizeErrorMessage } = await import("@/services/logging/sanitize").catch(() => ({ sanitizeErrorMessage: (x: string) => x }));
  const why = v.status === "unprovable" ? sanitizeErrorMessage(v.why).slice(0, 160) : "";
  const msg = `${tool} ${stage} ${mode}: ${verdictDetail(v)}`;
  try {
    const { logEvent } = await import("@/services/logging/logEvent");
    await logEvent({
      level: mode === "enforce" || stage === "after_send" ? "error" : "warn",
      source: "email-content-verify",
      code: `email_send.${event}`,
      message: why ? `${msg} (${why})` : msg,
      tenant_id: tenantId,
      meta: { stage, tool_name: tool },
    });
  } catch {
  }
  const now = Date.now();
  const limitKey = `${tenantId}:${tool}`;
  const last = lastAlertAt.get(limitKey);
  if (last !== undefined && now - last < ALERT_EVERY_MS) return;
  try {
    const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
    const { error } = await tenantRpc(asTenantId(tenantId), "enqueue_ops_alert_windowed", {
      p_key: `email_content:${tenantId}:${tool}`,
      p_window_s: ALERT_EVERY_MS / 1000,
      p_source: "email-content-verify",
      p_code: "email_content_verify",
      p_tenant_id: tenantId,
      p_msg: sanitizeErrorMessage(msg).slice(0, 300),
    });
    if (!error) lastAlertAt.set(limitKey, now);
  } catch {
  }
}

export async function reportAudienceMismatch(tenantId: string, actionId: string, tool: EmailTool): Promise<void> {
  const msg = `${tool} campaign for card ${actionId} is going to a list that is not the sealed one`;
  try {
    const { logEvent } = await import("@/services/logging/logEvent");
    await logEvent({ level: "error", source: "email-content-verify", code: "email_send.audience_mismatch", message: msg, tenant_id: tenantId, meta: { tool_name: tool } });
  } catch {
  }
  try {
    const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
    await tenantRpc(asTenantId(tenantId), "enqueue_ops_alert", {
      p_dedupe_key: `email_audience_mismatch:${actionId}`,
      p_source: "email-content-verify",
      p_code: "email_audience_mismatch",
      p_tenant_id: tenantId,
      p_msg: msg,
    });
  } catch {
  }
}
