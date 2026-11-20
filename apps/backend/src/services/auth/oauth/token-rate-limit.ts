import { isIPv6 } from "node:net";
import type { Request } from "express";
import { rateLimit } from "express-rate-limit";

export const TOKEN_WINDOW_MS = 15 * 60 * 1000;
export const TOKEN_MAX_PER_CLIENT = 50;
export const TOKEN_MAX_PER_IP = 5000;

export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

function sourceBucket(req: Request): string {
  const { ip = "" } = req;
  return ipBucket(ip);
}

export function tokenRateKey(req: Request): string {
  const clientId = (req.body as { client_id?: unknown } | undefined)?.client_id;
  if (typeof clientId === "string" && clientId.length > 0 && clientId.length <= 200) {
    return `client:${clientId}|ip:${sourceBucket(req)}`;
  }
  return `ip:${sourceBucket(req)}`;
}

export function tokenIpKey(req: Request): string {
  return `ip:${sourceBucket(req)}`;
}

export const tokenPerClientRateLimit = {
  windowMs: TOKEN_WINDOW_MS,
  max: TOKEN_MAX_PER_CLIENT,
  keyGenerator: tokenRateKey,
};

export const tokenPerIpCeiling = rateLimit({
  windowMs: TOKEN_WINDOW_MS,
  max: TOKEN_MAX_PER_IP,
  keyGenerator: tokenIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests", error_description: "Too many token requests from this address" },
});
