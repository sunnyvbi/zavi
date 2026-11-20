
import type { Request, Response } from "express";
import { unsubscribeInvite } from "@/services/creators/creator-invites";

type Deps = { unsubscribe: (token: string, source: "link" | "one_click") => Promise<void> };
const realDeps: Deps = { unsubscribe: unsubscribeInvite };

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

export function makeCreatorInviteUnsubscribeHandlers(deps: Deps = realDeps) {
  async function get(req: Request, res: Response): Promise<void> {
    const token = tokenOf(req);
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    res
      .status(200)
      .type("html")
      .send(
        page(
          "Unsubscribe from Zavi creator emails",
          `<p>Click below and we won't email you about Zavi creator profiles again.</p>
           <form method="post" action="/api/creators/invite/unsubscribe">
             <input type="hidden" name="t" value="${attr(token)}">
             <button type="submit" style="font-size:16px;padding:10px 18px;border-radius:8px;border:1px solid #1f1d1a;background:#1f1d1a;color:#fff;cursor:pointer;">Unsubscribe</button>
           </form>`,
        ),
      );
  }

  async function post(req: Request, res: Response): Promise<void> {
    const token = tokenOf(req);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
      res
        .status(400)
        .type("html")
        .send(page("This link is incomplete", "<p>Open the unsubscribe link from the email again, or reply to the email and ask us to stop.</p>"));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = body["List-Unsubscribe"] === "One-Click" ? "one_click" : "link";
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    try {
      await deps.unsubscribe(token, source);
    } catch (e) {
      console.warn(`[creator invite unsubscribe] write failed: ${e instanceof Error ? e.message : String(e)}`);
      res.status(500).type("html").send(page("Something went wrong", "<p>Please try again in a minute.</p>"));
      return;
    }
    res
      .status(200)
      .type("html")
      .send(page("You're unsubscribed", "<p>You won't get Zavi creator emails from us again.</p>"));
  }

  return { get, post };
}

const handlers = makeCreatorInviteUnsubscribeHandlers();
export const getCreatorInviteUnsubscribe = handlers.get;
export const postCreatorInviteUnsubscribe = handlers.post;
