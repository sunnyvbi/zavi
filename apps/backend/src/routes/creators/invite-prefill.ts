
import type { Request, Response } from "express";
import { invitePrefill } from "@/services/creators/creator-invites";

type Deps = { prefill: (token: string) => Promise<{ name: string; email: string } | null> };
const realDeps: Deps = { prefill: invitePrefill };

export function makeCreatorInvitePrefillHandler(deps: Deps = realDeps) {
  return async function get(req: Request, res: Response): Promise<void> {
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    const token = typeof req.query.t === "string" ? req.query.t.trim().slice(0, 64) : "";
    try {
      const found = token ? await deps.prefill(token) : null;
      if (!found) {
        res.status(404).json({ error: { code: "not_found", message: "This link has expired." } });
        return;
      }
      res.json({ name: found.name, email: found.email });
    } catch {
      res.status(503).json({ error: { code: "unavailable", message: "Try again in a moment." } });
    }
  };
}

export const getCreatorInvitePrefill = makeCreatorInvitePrefillHandler();
