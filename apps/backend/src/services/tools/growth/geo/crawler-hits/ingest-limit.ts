
import type { Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";

export const GEO_INGEST_PER_TOKEN_PER_MIN = 1200;
export const GEO_INGEST_NO_TOKEN_PER_MIN = 60;
export const GEO_INGEST_PER_IP_PER_MIN = 6000;

const TOKEN_HEADER = /^Bearer (zgeo_[0-9a-f]{64})$/;

export function tokenBucketKey(req: Pick<Request, "headers">): string | null {
  const m = TOKEN_HEADER.exec((req.headers.authorization as string | undefined) ?? "");
  return m ? `geo-token:${createHash("sha256").update(m[1]).digest("hex").slice(0, 32)}` : null;
}

const tooMany = (_req: Request, res: Response): void => {
  res.status(429).json({ error: { code: "rate_limited", message: "too many log batches" } });
};

export function geoIngestLimiters(): RequestHandler[] {
  const perIp = rateLimit({
    windowMs: 60_000,
    max: GEO_INGEST_PER_IP_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooMany,
  });
  const perToken = rateLimit({
    windowMs: 60_000,
    max: (req: Request) => (tokenBucketKey(req) ? GEO_INGEST_PER_TOKEN_PER_MIN : GEO_INGEST_NO_TOKEN_PER_MIN),
    keyGenerator: (req: Request) => tokenBucketKey(req) ?? `geo-ip:${req.ip}`,
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooMany,
  });
  return [perIp, perToken];
}
