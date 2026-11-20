
import type { Request, Response } from "express";
import { unsubscribeAndCount } from "@/services/tools/email/safety-net";
import { staffCrossTenantClient } from "@/services/tenant-client";

interface UnsubTokenRow {
  tenant_id: string;
  email: string;
}

async function resolveToken(token: string): Promise<UnsubTokenRow | null> {
  const { data, error } = await staffCrossTenantClient(
    "one-click unsubscribe: resolve an opaque recipient token to its tenant",
  )
    .from("email_unsub_token")
    .select("tenant_id, email")
    .eq("token", token)
    .maybeSingle();

  if (error) throw new Error("email_unsub_token lookup failed");
  if (!data) return null;
  return data as UnsubTokenRow;
}

export const TEST_UNSUBSCRIBE_TOKEN = "test-send";
export const TEST_UNSUBSCRIBE_LINE = "This is a test email, so its unsubscribe link does nothing. In a real send, the link unsubscribes the person who clicks it.";

const PAGE_HEAD =
  `<meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="color-scheme" content="light dark">` +
  `<style>` +
  `body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#0f172a;background:#fff}` +
  `h1{font-size:1.25rem;margin:0 0 .5rem}` +
  `p{color:#475569;font-size:.875rem;margin:0 0 1rem}` +
  `button{font-size:1rem;padding:.6rem 1.1rem;border-radius:.5rem;border:1px solid #0f172a;background:#0f172a;color:#fff;cursor:pointer}` +
  `@media (prefers-color-scheme:dark){body{color:#f1f5f9;background:#0f172a}p{color:#cbd5e1}button{border-color:#f1f5f9;background:#f1f5f9;color:#0f172a}}` +
  `</style>`;

const NOT_RECORDED = "We could not record that unsubscribe. Please try again in a few minutes.";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export async function emailUnsubscribe(req: Request, res: Response): Promise<void> {
  const token = String(req.query.token ?? "").trim();
  const isGet = req.method === "GET";
  const wantsHtml = isGet || (req.headers.accept ?? "").includes("text/html");

  if (token === TEST_UNSUBSCRIBE_TOKEN) {
    respond(res, 200, wantsHtml, TEST_UNSUBSCRIBE_LINE);
    return;
  }

  if (!token || !isUuid(token)) {
    respond(res, 400, wantsHtml, "That unsubscribe link is not valid.");
    return;
  }

  if (isGet) {
    confirmPage(res, token);
    return;
  }

  let row: UnsubTokenRow | null;
  try {
    row = await resolveToken(token);
  } catch (e) {
    respond(res, 503, wantsHtml, NOT_RECORDED);
    console.error("[unsubscribe] email_unsubscribe_lookup_failed", { error_class: e instanceof Error ? e.name : typeof e });
    return;
  }

  if (!row) {
    respond(res, 404, wantsHtml, "This unsubscribe link is not valid or has expired.");
    return;
  }

  try {
    await unsubscribeAndCount(row.tenant_id, row.email);
  } catch (e) {
    respond(res, 503, wantsHtml, NOT_RECORDED);
    console.error("[unsubscribe] email_unsubscribe_failed", { error_class: e instanceof Error ? e.name : typeof e });
    return;
  }

  respond(res, 200, wantsHtml, "You have been unsubscribed. You will not receive further emails.");
}

function confirmPage(res: Response, token: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res
    .status(200)
    .type("html")
    .send(
      `<!doctype html><html lang="en"><head>${PAGE_HEAD}` +
        `<meta name="referrer" content="no-referrer">` +
        `<title>Unsubscribe</title></head>` +
        `<body>` +
        `<h1>Stop these emails?</h1>` +
        `<p>Click below and this sender will not email you again.</p>` +
        `<form method="post" action="/api/email/unsubscribe?token=${encodeURIComponent(token)}">` +
        `<button type="submit">Unsubscribe</button>` +
        `</form></body></html>`,
    );
}

function respond(res: Response, status: number, wantsHtml: boolean, message: string): void {
  if (res.headersSent) return;

  if (!wantsHtml) {
    res.status(status).json({ ok: status === 200, message });
    return;
  }

  res
    .status(status)
    .type("html")
    .send(
      `<!doctype html><html lang="en"><head>${PAGE_HEAD}` +
        `<title>Unsubscribe</title></head>` +
        `<body>` +
        `<h1>${escapeHtml(message)}</h1>` +
        `<p>${status >= 500 ? "Nothing was changed. Open the link in your email again to retry." : "You can close this window."}</p>` +
        `</body></html>`,
    );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
