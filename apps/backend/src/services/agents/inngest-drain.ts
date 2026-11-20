
import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";

let quiesced = false;

export function isQuiesced(): boolean {
  return quiesced;
}

export function quiesce(): void {
  quiesced = true;
}

export function unquiesce(): void {
  quiesced = false;
}

export function __resetQuiesceForTest(): void {
  quiesced = false;
}

type InngestRequestBody = {
  steps?: Record<string, unknown>;
  ctx?: { stack?: { stack?: unknown[] } };
};

const DISPATCH_STEP_HASH = createHash("sha1").update("dispatch").digest("hex");

export function isContinuation(body: unknown): boolean {
  const b = body as InngestRequestBody | undefined;
  return (
    Object.prototype.hasOwnProperty.call(b?.steps ?? {}, DISPATCH_STEP_HASH) ||
    (b?.ctx?.stack?.stack ?? []).includes(DISPATCH_STEP_HASH)
  );
}

export function inngestDrainMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.method === "POST" && quiesced && !isContinuation(req.body)) {
    res.setHeader("Retry-After", "30");
    res
      .status(503)
      .json({ error: "draining: container is shutting down for deploy" });
    return;
  }
  next();
}
