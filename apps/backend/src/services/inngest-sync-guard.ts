
import type { NextFunction, Request, Response } from "express";
import { inngestSyncAllowed } from "@/services/agents/boot-role";

export function inngestSyncGuard(env: NodeJS.ProcessEnv = process.env) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "PUT" || inngestSyncAllowed(env)) {
      next();
      return;
    }
    console.warn(
      "[inngest-sync-guard] refused PUT /api/inngest: this process is not the canonical container and not in Inngest dev mode",
    );
    res.status(403).json({
      error: "inngest_sync_refused",
      message:
        "This process may not register with Inngest Cloud. Only the deployed prod container syncs. For local work set INNGEST_DEV=http://localhost:8288.",
    });
  };
}
