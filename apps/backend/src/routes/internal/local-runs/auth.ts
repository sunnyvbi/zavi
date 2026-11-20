
import type { Request, Response, NextFunction } from "express";
import {
  resolveMacWorkerToken,
  MacTokenAuthError,
  type MacWorkerCaller,
} from "@/services/auth/mac-worker-token";
import { logEvent } from "@/services/logging/logEvent";

export function getMacWorker(req: Request): MacWorkerCaller {
  const c = (req as Request & { macWorker?: MacWorkerCaller }).macWorker;
  if (!c) throw new Error("macWorker missing — macWorkerAuth not mounted");
  return c;
}

export async function macWorkerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const hdr = req.headers.authorization ?? "";
  const raw = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
  if (!raw) {
    res.status(401).json({ error: { code: "unauthorized" } });
    return;
  }
  try {
    const caller = await resolveMacWorkerToken(raw);
    (req as Request & { macWorker?: MacWorkerCaller }).macWorker = caller;
    next();
  } catch (e) {
    if (e instanceof MacTokenAuthError && e.code === "anomaly") {
      void logEvent({
        level: "warn",
        source: "route",
        code: "mac_worker_token_anomaly",
        meta: { count: 1 },
      });
    }
    res.status(401).json({ error: { code: "unauthorized" } });
  }
}
