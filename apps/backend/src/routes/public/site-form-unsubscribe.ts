
import type { Request, Response } from "express";
import { mintOptOutToken, readOptOutToken, recipientTag, type OptOutAction, type OptOutClaims } from "@/services/site-auth/form-notify";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Current = { version: number; recipient: string | null };

type Deps = {
  key: () => string | null;
  now: () => number;
  current: (siteId: string) => Promise<Current | null>;
  setMuted: (siteId: string, muted: boolean, expectedVersion: number) => Promise<number | null>;
};

const realDeps: Deps = {
  key: () => {
    const k = process.env.SITE_AUTH_ALIAS_KEY ?? "";
    return k.length >= 32 ? k : null;
  },
  now: () => Date.now(),
  async current(siteId) {
    const { readFormNotifyTarget, resolveFormNotifyRecipient } = await import("@/services/site-auth/form-notify-run");
    const t = await readFormNotifyTarget(siteId);
    if (!t) return null;
    return { version: t.version, recipient: await resolveFormNotifyRecipient(t) };
  },
  async setMuted(siteId, muted, expectedVersion) {
    const { sitePublicRpc } = await import("@/services/tenant-client");
    const { data, error } = await sitePublicRpc("site_form_notify_set_muted", {
      p_site_id: siteId,
      p_muted: muted,
      p_expected_version: expectedVersion,
    });
    if (error) throw new Error(`site_form_notify_set_muted failed${error.code ? ` (${error.code})` : ""}`);
    const v = Array.isArray(data) ? data[0] : data;
    return v === null || v === undefined ? null : Number(v);
  },
};

function tokenParam(req: Request): string {
  const q = typeof req.query.t === "string" ? req.query.t : "";
  const body = (req.body ?? {}) as Record<string, unknown>;
  const b = typeof body.t === "string" ? body.t : "";
  return (q || b).trim().slice(0, 512);
}

function page(title: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;color:#1f1d1a;"><h1 style="font-size:22px;">${title}</h1>${inner}</body></html>`;
}

function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BUTTON = "font-size:16px;padding:10px 18px;border-radius:8px;border:1px solid #1f1d1a;background:#1f1d1a;color:#fff;cursor:pointer;";

function form(token: string, label: string): string {
  return `<form method="post" action="/api/public/site-forms/unsubscribe">
  <input type="hidden" name="t" value="${attr(token)}">
  <button type="submit" style="${BUTTON}">${label}</button></form>`;
}

const COPY: Record<OptOutAction, { ask: string; askBody: string; button: string; done: string; doneBody: string }> = {
  mute: {
    ask: "Stop form emails?",
    askBody: "<p>You will stop getting an email for each form sent on your site. Every submission is still saved in your site's admin page.</p>",
    button: "Stop form emails",
    done: "Form emails are off",
    doneBody: "<p>Submissions are still saved in your site's admin page.</p>",
  },
  resume: {
    ask: "Turn form emails back on?",
    askBody: "<p>You will get an email for each form sent on your site.</p>",
    button: "Turn them back on",
    done: "Form emails are on",
    doneBody: "<p>You will get an email for each form sent on your site.</p>",
  },
};

export function makeSiteFormUnsubscribeHandlers(deps: Deps = realDeps) {
  const headers = (res: Response) => res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
  const stale = (res: Response) =>
    res.status(400).type("html").send(page("This link no longer works", "<p>It is incomplete, expired, or a newer email replaced it. Use the link in your most recent form email.</p>"));

  async function check(token: string): Promise<{ key: string; c: OptOutClaims; recipient: string } | null> {
    const key = deps.key();
    if (!key) return null;
    const c = readOptOutToken(key, token, deps.now() / 1000);
    if (!c || !UUID_RE.test(c.s)) return null;
    const cur = await deps.current(c.s);
    if (!cur || !cur.recipient || cur.version !== c.v) return null;
    if (recipientTag(key, cur.recipient) !== c.r) return null;
    return { key, c, recipient: cur.recipient };
  }

  async function get(req: Request, res: Response): Promise<void> {
    headers(res);
    try {
      const token = tokenParam(req);
      const ok = await check(token);
      if (!ok) return void stale(res);
      const copy = COPY[ok.c.a];
      res.status(200).type("html").send(page(copy.ask, `${copy.askBody}${form(token, copy.button)}`));
    } catch (e) {
      console.warn(`[site-form-notify] ${JSON.stringify({ event: "optout_page_failed", error: String((e as Error)?.message ?? e).slice(0, 160) })}`);
      res.status(500).type("html").send(page("Something went wrong", "<p>Please try again in a minute.</p>"));
    }
  }

  async function post(req: Request, res: Response): Promise<void> {
    headers(res);
    try {
      const ok = await check(tokenParam(req));
      if (!ok) return void stale(res);
      const { key, c, recipient } = ok;
      const next = await deps.setMuted(c.s, c.a === "mute", c.v);
      if (next === null) return void stale(res);
      console.warn(`[site-form-notify] ${JSON.stringify({ event: c.a === "mute" ? "unsubscribed" : "resubscribed", site_id: c.s })}`);
      const copy = COPY[c.a];
      const resume =
        c.a === "mute"
          ? form(
              mintOptOutToken(key, { siteId: c.s, recipient, action: "resume", version: next, nowS: deps.now() / 1000 }),
              COPY.resume.button,
            )
          : "";
      res.status(200).type("html").send(page(copy.done, `${copy.doneBody}${resume}`));
    } catch (e) {
      console.warn(`[site-form-notify] ${JSON.stringify({ event: "optout_failed", error: String((e as Error)?.message ?? e).slice(0, 160) })}`);
      res.status(500).type("html").send(page("Something went wrong", "<p>Please try again in a minute.</p>"));
    }
  }

  return { get, post };
}

const handlers = makeSiteFormUnsubscribeHandlers();
export const getSiteFormUnsubscribe = handlers.get;
export const postSiteFormUnsubscribe = handlers.post;
