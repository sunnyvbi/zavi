
import type { Express, Router } from "express";

type AnyFn = (...args: unknown[]) => unknown;

function isRouterLike(fn: AnyFn): boolean {
  return "stack" in fn || "handle" in fn;
}

function wrap(fn: unknown): unknown {
  if (typeof fn !== "function") return fn;
  const handler = fn as AnyFn;
  if (isRouterLike(handler)) return handler;

  if (handler.length >= 4) {
    return function (err: unknown, req: unknown, res: unknown, next: unknown) {
      try {
        const out = handler(err, req, res, next);
        if (out && typeof (out as Promise<unknown>).catch === "function") {
          (out as Promise<unknown>).catch(next as (e: unknown) => void);
        }
      } catch (e) {
        (next as (e: unknown) => void)(e);
      }
    };
  }
  return function (req: unknown, res: unknown, next: unknown) {
    try {
      const out = handler(req, res, next);
      if (out && typeof (out as Promise<unknown>).catch === "function") {
        (out as Promise<unknown>).catch(next as (e: unknown) => void);
      }
    } catch (e) {
      (next as (e: unknown) => void)(e);
    }
  };
}

const METHODS = ["use", "all", "get", "post", "put", "patch", "delete", "head", "options"] as const;

export function forwardAsyncErrors<T extends Express | Router>(target: T): T {
  const t = target as unknown as Record<string, AnyFn>;
  for (const method of METHODS) {
    const original = t[method];
    if (typeof original !== "function") continue;
    t[method] = function (...args: unknown[]) {
      return original.apply(t, args.map(wrap));
    } as AnyFn;
  }
  return target;
}

export function installUnhandledRejectionGuard(): void {
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[zavi-backend] unhandled rejection (process kept alive):",
      reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : reason,
    );
  });
}
