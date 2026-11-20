
import { createHash } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { IDEMPOTENT_ROUTES } from "@/services/http/idempotent-routes";
import { requireAuth } from "@/services/auth/middleware";
import { tenantClient, type TenantId } from "@/services/tenant-client";
import { STALE_RESOLVERS, type StaleResolver } from "@/services/http/stale-resolvers";

declare module "express-serve-static-core" {
  interface Request {
    idempotencyScope?: { tenant_id: TenantId; user_id: string };
  }
}

export const IDEMPOTENCY_HEADER = "idempotency-key";
const TABLE = "request_idempotency";
const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;
const WAIT_MS = 8000;
const POLL_MS = 250;
export const STALE_MS = 10 * 60 * 1000;
const SETTLE_ATTEMPTS = 3;
const SETTLE_BACKOFF_MS = 100;
export const SETTLE_HOLD_MS = 5000;
let settleHoldMs = SETTLE_HOLD_MS;
export function _setSettleHoldMsForTests(ms: number | null): void {
  settleHoldMs = ms ?? SETTLE_HOLD_MS;
}

type StoredRow = {
  request_hash: string;
  status: "in_progress" | "done";
  response_status: number | null;
  response_body: unknown;
  created_at: string | null;
};

type Scope = { tid: TenantId; userId: string; route: string; key: string; claimedAt?: string };

function requestHash(req: Request): string {
  return createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex");
}

function routeOf(req: Request): string {
  const path = String(req.originalUrl ?? req.url ?? "").split("?")[0];
  return `${req.method} ${path}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function readRow(s: Scope): Promise<StoredRow | null> {
  const { data, error } = await tenantClient(s.tid)
    .from(TABLE)
    .select("request_hash,status,response_status,response_body,created_at")
    .eq("user_id", s.userId)
    .eq("route", s.route)
    .eq("idem_key", s.key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as StoredRow | null) ?? null;
}

function isStale(row: StoredRow, staleMs: number): boolean {
  if (!row.created_at) return false;
  const at = Date.parse(row.created_at);
  return Number.isFinite(at) && Date.now() - at > staleMs;
}

function replay(res: Response, row: StoredRow): void {
  res.setHeader("Idempotent-Replayed", "true");
  if (row.response_status != null && row.response_body != null) {
    res.status(row.response_status).json(row.response_body);
    return;
  }
  res.status(409).json({
    error: {
      code: "already_processed",
      message: "This request was already processed.",
      prior_status: row.response_status,
    },
  });
}

async function settleRow(s: Scope, status: number, body: unknown): Promise<void> {
  const values = {
    status: "done",
    response_status: status,
    response_body: body === undefined ? null : body,
    completed_at: new Date().toISOString(),
  };
  for (let i = 0; i < SETTLE_ATTEMPTS; i++) {
    try {
      let q = tenantClient(s.tid)
        .from(TABLE)
        .update(values)
        .eq("user_id", s.userId)
        .eq("route", s.route)
        .eq("idem_key", s.key);
      if (s.claimedAt) q = q.eq("created_at", s.claimedAt);
      const { error } = await q;
      if (!error) return;
      console.warn(`[idempotency] settle attempt ${i + 1} failed for ${s.route}: ${error.message}`);
    } catch (e) {
      console.warn(`[idempotency] settle attempt ${i + 1} failed for ${s.route}: ${(e as Error).message}`);
    }
    if (i < SETTLE_ATTEMPTS - 1) await sleep(SETTLE_BACKOFF_MS * (i + 1));
  }
}

async function releaseRow(s: Scope): Promise<void> {
  try {
    let q = tenantClient(s.tid)
      .from(TABLE)
      .delete()
      .eq("user_id", s.userId)
      .eq("route", s.route)
      .eq("idem_key", s.key);
    if (s.claimedAt) q = q.eq("created_at", s.claimedAt);
    const { error } = await q;
    if (error) console.warn(`[idempotency] release failed for ${s.route}: ${error.message}`);
  } catch (e) {
    console.warn(`[idempotency] release failed for ${s.route}: ${(e as Error).message}`);
  }
}

let staleResolverOverride: Readonly<Record<string, StaleResolver>> | null = null;
export function _setStaleResolversForTests(map: Readonly<Record<string, StaleResolver>> | null): void {
  staleResolverOverride = map;
}
function staleResolverFor(path: string | undefined): StaleResolver | undefined {
  if (!path) return undefined;
  return (staleResolverOverride ?? STALE_RESOLVERS)[path];
}

type StaleOutcome = "replayed" | "taken_over" | "refused";

async function resolveStaleClaim(
  res: Response,
  s: Scope,
  row: StoredRow,
  resolver: StaleResolver,
): Promise<StaleOutcome> {
  let found: Awaited<ReturnType<StaleResolver>>;
  try {
    found = await resolver({ tenant_id: s.tid, user_id: s.userId, key: s.key });
  } catch (e) {
    console.warn(`[idempotency] stale resolver failed for ${s.route}: ${(e as Error).message}`);
    return "refused";
  }
  if (found !== "not_found") {
    await settleRow({ ...s, ...(row.created_at ? { claimedAt: row.created_at } : {}) }, found.status, found.body);
    res.setHeader("Idempotent-Replayed", "true");
    res.status(found.status).json(found.body);
    return "replayed";
  }
  const claimedAt = new Date().toISOString();
  try {
    const { data, error } = await tenantClient(s.tid)
      .from(TABLE)
      .update({ created_at: claimedAt })
      .eq("user_id", s.userId)
      .eq("route", s.route)
      .eq("idem_key", s.key)
      .eq("status", "in_progress")
      .eq("created_at", row.created_at)
      .select("idem_key");
    if (error) throw new Error(error.message);
    if (Array.isArray(data) && data.length === 1) {
      s.claimedAt = claimedAt;
      return "taken_over";
    }
    return "refused";
  } catch (e) {
    console.warn(`[idempotency] stale takeover failed for ${s.route}: ${(e as Error).message}`);
    return "refused";
  }
}

export async function idempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  return idempotencyWith(undefined, STALE_MS, req, res, next);
}

export function idempotencyFor(path: string, staleMs = STALE_MS) {
  return (req: Request, res: Response, next: NextFunction): Promise<void> =>
    idempotencyWith(staleResolverFor(path), staleMs, req, res, next);
}

async function idempotencyWith(
  resolver: StaleResolver | undefined,
  staleMs: number,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const raw = req.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (key === undefined || key === "") {
    next();
    return;
  }
  if (!KEY_RE.test(key)) {
    res.status(400).json({
      error: { code: "bad_idempotency_key", message: "Idempotency-Key must be 8-200 chars of [A-Za-z0-9_.:-]." },
    });
    return;
  }

  const auth = req.idempotencyScope ?? await requireAuth(req, res);
  if (!auth) return;
  const scope: Scope = { tid: auth.tenant_id, userId: auth.user_id, route: routeOf(req), key, claimedAt: new Date().toISOString() };
  const { route } = scope;
  const hash = requestHash(req);

  try {
    const { error: insErr } = await tenantClient(scope.tid).from(TABLE).insert({
      user_id: scope.userId,
      route,
      idem_key: key,
      request_hash: hash,
      status: "in_progress",
      created_at: scope.claimedAt,
    });
    if (insErr) {
      if ((insErr as { code?: string }).code !== "23505") throw new Error(insErr.message);
      const deadline = Date.now() + WAIT_MS;
      let row = await readRow(scope);
      while (row && row.status === "in_progress" && !isStale(row, staleMs) && Date.now() < deadline) {
        await sleep(POLL_MS);
        row = await readRow(scope);
      }
      if (!row) {
        res.status(409).json({
          error: { code: "idempotency_retry", message: "The earlier attempt could not be found. Try again." },
        });
        return;
      }
      if (row.request_hash !== hash) {
        res.status(422).json({
          error: {
            code: "idempotency_key_reused",
            message: "This Idempotency-Key was already used for a different request.",
          },
        });
        return;
      }
      if (row.status === "in_progress") {
        const outcome: StaleOutcome =
          isStale(row, staleMs) && resolver ? await resolveStaleClaim(res, scope, row, resolver) : "refused";
        if (outcome === "replayed") return;
        if (outcome === "taken_over") {
        } else if (isStale(row, staleMs)) {
          res.status(409).json({
            error: {
              code: "idempotency_stale",
              message:
                "An earlier attempt of this request never finished, so it may or may not have taken effect. Check before trying again.",
            },
          });
          return;
        } else {
          res.status(409).json({
            error: { code: "idempotency_in_progress", message: "This request is still being processed." },
          });
          return;
        }
      } else {
        replay(res, row);
        return;
      }
    }
  } catch (e) {
    console.warn(`[idempotency] claim failed for ${route}: ${(e as Error).message}`);
    res.status(503).json({
      error: { code: "idempotency_unavailable", message: "Could not start this request safely. Try again." },
    });
    return;
  }

  let body: unknown = null;
  const origJson = res.json.bind(res);
  res.json = ((payload: unknown) => {
    body = payload;
    return origJson(payload);
  }) as Response["json"];

  const origEnd = res.end.bind(res) as (...args: unknown[]) => Response;
  let settling: Promise<void> | null = null;
  res.end = ((...args: unknown[]) => {
    if (!settling) {
      settling = res.locals?.idempotencyRelease === true ? releaseRow(scope) : settleRow(scope, res.statusCode, body);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      origEnd(...args);
    };
    const timer = setTimeout(release, settleHoldMs);
    void settling.then(() => {
      clearTimeout(timer);
      release();
    });
    return res;
  }) as Response["end"];

  next();
}

export function mountIdempotency(app: Express): void {
  for (const r of IDEMPOTENT_ROUTES) {
    if (r.auth !== "pre_resolved") app[r.method](r.path, idempotencyFor(r.path, r.staleMs));
  }
}
