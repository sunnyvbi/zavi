
import type { Request, Response } from "express";
import { defaultHookDeps } from "@/services/site-auth";
import { handleSendEmailHook, type HookDeps } from "@/services/site-auth/send-email-hook";

function h(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function createSiteAuthHookHandler(deps: () => HookDeps) {
  return async function siteAuthHook(req: Request, res: Response): Promise<void> {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const r = await handleSendEmailHook(
        deps(),
        String(req.params?.shardId ?? ""),
        { id: h(req, "webhook-id"), timestamp: h(req, "webhook-timestamp"), signature: h(req, "webhook-signature") },
        raw,
      );
      res.status(r.status).json(r.body);
    } catch (e) {
      console.warn(`[site-auth hook] failed: ${(e as Error).message}`);
      res.status(503).json({ error: { http_code: 503, message: "unavailable" } });
    }
  };
}

export const siteAuthSendEmailHook = createSiteAuthHookHandler(defaultHookDeps);
