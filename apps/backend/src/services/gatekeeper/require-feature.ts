
import type { NextFunction, Request, Response } from "express";
import { readBearerToken, verifyBearer } from "@/services/auth/jwt";
import { isFeatureEnabled } from "./index";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireFeature(
  name: string,
  label: string,
  opts: { mutationsOnly?: boolean } = {},
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (opts.mutationsOnly && SAFE_METHODS.has(req.method)) return next();

    let enabled = false;
    try {
      const userId = req.auth?.user_id ?? (await verifyBearer(req))?.user_id ?? null;
      if (!userId && readBearerToken(req)) {
        res.status(401).json({ error: { code: "unauthenticated", message: "Invalid or expired Bearer token." } });
        return;
      }
      enabled = await isFeatureEnabled(name, userId);
    } catch (err) {
      console.warn(`[gatekeeper] requireFeature(${name}) failed closed: ${(err as Error).message}`);
      enabled = false;
    }
    if (enabled) return next();

    res.status(403).json({
      error: {
        code: "feature_not_enabled",
        message: `${label} is not available on your account yet.`,
      },
    });
  };
}
