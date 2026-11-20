
import { unsubscribeHeaders, unsubscribeUrl } from "@/services/tools/email/safety-net";
import { UNSUBSCRIBE_HREF } from "@/services/email-templates/render";
import { bulkSendgridKey } from "./config";

const SENDGRID_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

export const BULK_TRACKING_SETTINGS = {
  open_tracking: { enable: true },
  click_tracking: { enable: false, enable_text: false },
} as const;
const WIRE_TIMEOUT_MS = 15_000;

export type BulkWireMessage = {
  tenantId: string;
  sendId: string;
  to: string;
  from: { email: string; name?: string | null };
  replyTo: string | null;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  unsubToken: string;
  postalAddress: string;
};

export type BulkWireResult =
  | { kind: "sent" }
  | { kind: "rejected"; status: number }
  | { kind: "stop_all"; status: number }
  | { kind: "throttled"; status: number }
  | { kind: "unknown" };

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

export type BulkWireDeps = { fetch?: FetchLike };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

export function bulkTextBody(bodyText: string, postalAddress: string, unsubToken: string): string {
  return `${bodyText.trimEnd()}\n\n--\n${postalAddress}\nUnsubscribe: ${unsubscribeUrl(unsubToken)}\n`;
}

export function textToHtml(bodyText: string): string {
  const paragraphs = bodyText
    .replace(/\r\n?/g, "\n")
    .trimEnd()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 1em">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);
  return paragraphs.join("");
}

export function bulkHtmlBody(bodyText: string, postalAddress: string, unsubToken: string): string {
  const footer =
    `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:12px;line-height:1.5;color:#6b7280">` +
    `${escapeHtml(postalAddress).replace(/\n/g, "<br>")}<br>` +
    `<a href="${escapeHtml(unsubscribeUrl(unsubToken))}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a>` +
    `</div>`;
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5;color:#111827">${textToHtml(bodyText)}${footer}</body></html>`;
}

export function hasUnsubscribeSlot(html: string, text: string): boolean {
  return html.includes(UNSUBSCRIBE_HREF.zavi_list) && text.includes(UNSUBSCRIBE_HREF.zavi_list);
}

function contentParts(msg: BulkWireMessage): Array<{ type: string; value: string }> {
  if (msg.bodyHtml) {
    const url = unsubscribeUrl(msg.unsubToken);
    return [
      { type: "text/plain", value: msg.bodyText.split(UNSUBSCRIBE_HREF.zavi_list).join(url) },
      { type: "text/html", value: msg.bodyHtml.split(UNSUBSCRIBE_HREF.zavi_list).join(escapeHtml(url)) },
    ];
  }
  return [
    { type: "text/plain", value: bulkTextBody(msg.bodyText, msg.postalAddress, msg.unsubToken) },
    { type: "text/html", value: bulkHtmlBody(msg.bodyText, msg.postalAddress, msg.unsubToken) },
  ];
}

export function buildBulkPayload(msg: BulkWireMessage): Record<string, unknown> {
  const content = contentParts(msg);
  return {
    personalizations: [{ to: [{ email: msg.to }] }],
    from: msg.from.name ? { email: msg.from.email, name: msg.from.name } : { email: msg.from.email },
    ...(msg.replyTo ? { reply_to: { email: msg.replyTo } } : {}),
    subject: msg.subject,
    content,
    headers: unsubscribeHeaders(msg.unsubToken),
    custom_args: { tenant_id: msg.tenantId, bulk_send_id: msg.sendId },
    tracking_settings: BULK_TRACKING_SETTINGS,
  };
}

export async function sendBulkEmail(msg: BulkWireMessage, deps: BulkWireDeps = {}): Promise<BulkWireResult> {
  if (msg.bodyHtml && !hasUnsubscribeSlot(msg.bodyHtml, msg.bodyText)) return { kind: "rejected", status: 0 };
  const key = bulkSendgridKey();
  if (!key) return { kind: "stop_all", status: 0 };

  const doFetch = deps.fetch ?? (fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WIRE_TIMEOUT_MS);
  let status: number;
  try {
    const resp = await doFetch(SENDGRID_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildBulkPayload(msg)),
      signal: controller.signal,
    });
    status = resp.status;
  } catch {
    return { kind: "unknown" };
  } finally {
    clearTimeout(timer);
  }
  if (status >= 200 && status < 300) return { kind: "sent" };
  if (status === 429) return { kind: "throttled", status };
  if (status === 401 || status === 403) return { kind: "stop_all", status };
  if (status >= 400 && status < 500) return { kind: "rejected", status };
  return { kind: "unknown" };
}
