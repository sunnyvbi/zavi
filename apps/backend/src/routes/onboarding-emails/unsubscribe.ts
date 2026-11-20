
import type { Request, Response } from "express";
import { unsubscribeByToken } from "@/services/onboarding-emails/sequence";

type Deps = { unsubscribe: (token: string, source: "link" | "one_click") => Promise<boolean> };
const realDeps: Deps = { unsubscribe: unsubscribeByToken };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokenOf(req: Request): string {
  const fromQuery = typeof req.query.t === "string" ? req.query.t : "";
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fromBody = typeof body.t === "string" ? body.t : "";
  return (fromQuery || fromBody).trim().slice(0, 64);
}

function page(title: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;color:#1f1d1a;"><h1 style="font-size:22px;">${title}</h1>${inner}</body></html>`;
}

function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function makeOnboardingEmailUnsubscribeHandlers(deps: Deps = realDeps) {
  async function get(req: Request, res: Response): Promise<void> {
    const token = tokenOf(req);
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    res
      .status(200)
      .type("html")
      .send(
        page(
          "Unsubscribe from Zavi onboarding emails",
          `<p>Click below and we won't send you the Zavi getting-started emails again. Emails about your account, like sign-in codes, are not affected.</p>
           <form method="post" action="/api/onboarding-emails/unsubscribe">
             <input type="hidden" name="t" value="${attr(token)}">
             <button type="submit" style="font-size:16px;padding:10px 18px;border-radius:8px;border:1px solid #1f1d1a;background:#1f1d1a;color:#fff;cursor:pointer;">Unsubscribe</button>
           </form>`,
        ),
      );
  }

  async function post(req: Request, res: Response): Promise<void> {
    const token = tokenOf(req);
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    if (!UUID.test(token)) {
      res
        .status(400)
        .type("html")
        .send(page("This link is incomplete", "<p>Open the unsubscribe link from the email again, or reply to the email and ask us to stop.</p>"));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = body["List-Unsubscribe"] === "One-Click" ? "one_click" : "link";
    try {
      await deps.unsubscribe(token, source);
    } catch (e) {
      console.warn(`[onboarding-emails unsubscribe] write failed: ${e instanceof Error ? e.message : String(e)}`);
      res.status(500).type("html").send(page("Something went wrong", "<p>Please try again in a minute.</p>"));
      return;
    }
    res
      .status(200)
      .type("html")
      .send(page("You're unsubscribed", "<p>You won't get the Zavi getting-started emails again.</p>"));
  }

  return { get, post };
}

const handlers = makeOnboardingEmailUnsubscribeHandlers();
export const getOnboardingEmailUnsubscribe = handlers.get;
export const postOnboardingEmailUnsubscribe = handlers.post;
