import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MAX_ROWS } from "@zavi/shared/db-guard";
import { SESSION_COOKIE, safeEqual, type AdminAuth } from "../admin-auth";
import type { ActivityLog } from "../activity";
import type { Config } from "../config";
import type { DatabaseManager } from "../db";
import type { Dialect } from "../db/types";
import type { KeySource } from "../keys";
import type { RulesFile, WhatCanLeave } from "../rules";
import type { ConnectorRuntime } from "../runtime";
import type { SafeHtml } from "../html";
import * as pages from "./pages";

export const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const MAX_BODY = 1024 * 1024;

export type AppContext = {
  cfg: Pick<Config, "machine" | "version" | "port" | "extraHosts" | "dataDir">;
  rules: RulesFile;
  db: DatabaseManager;
  activity: ActivityLog;
  runtime: Pick<ConnectorRuntime, "status" | "lastError" | "lastContactAt" | "lastHeartbeatAt" | "pairNote" | "online" | "heartbeatSoon">;
  auth: AdminAuth;
  keySource: KeySource;
  log: (level: "info" | "warn" | "error", msg: string) => void;
};

function baseHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function send(res: ServerResponse, status: number, body: SafeHtml | string, type = "text/html; charset=utf-8", extra: Record<string, string | string[]> = {}): void {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(typeof body === "string" ? body : body.value);
}

function redirect(res: ServerResponse, to: string, extra: Record<string, string | string[]> = {}): void {
  res.statusCode = 303;
  res.setHeader("Location", to);
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end();
}

function parseCookies(h: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (h ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return m;
}

export function hostnameOf(host: string | undefined): string | null {
  if (!host || host.length > 300) return null;
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export function hostAllowed(host: string | undefined, extra: string[]): boolean {
  const name = hostnameOf(host);
  return name !== null && (name === "localhost" || name === "127.0.0.1" || name === "[::1]" || extra.includes(name));
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | "too_large" | "bad_type"> {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return "bad_type";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return "too_large";
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const DIALECTS: Dialect[] = ["postgres", "mysql", "mongodb"];

export function createLocalServer(ctx: AppContext): Server {
  const server = createServer((req, res) => {
    handle(ctx, req, res).catch((e) => {
      ctx.log("error", `Local page error: ${(e as Error).name}`);
      if (!res.headersSent) {
        baseHeaders(res);
        send(res, 500, pages.errorPage("Something went wrong on the connector's page. Check the container log."));
      } else res.destroy();
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function handle(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  baseHeaders(res);
  const host = req.headers.host;
  if (!hostAllowed(host, ctx.cfg.extraHosts)) {
    send(res, 403, "Forbidden: this page only answers on localhost.", "text/plain; charset=utf-8");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/healthz" && method === "GET") {
    send(res, 200, "ok", "text/plain; charset=utf-8");
    return;
  }
  if (path === "/style.css" && method === "GET") {
    send(res, 200, pages.STYLE, "text/css; charset=utf-8");
    return;
  }

  if (method === "POST") {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if (origin !== `http://${host}` || (site !== undefined && site !== "same-origin")) {
      send(res, 403, "Forbidden: cross-site request.", "text/plain; charset=utf-8");
      return;
    }
  } else if (method !== "GET" && method !== "HEAD") {
    send(res, 405, "Method not allowed.", "text/plain; charset=utf-8", { Allow: "GET, POST" });
    return;
  }

  const cookieId = parseCookies(req.headers.cookie).get(SESSION_COOKIE) ?? null;

  if (path === "/login") {
    if (method === "GET") {
      send(res, 200, pages.loginPage(null));
      return;
    }
    const form = await readForm(req);
    if (typeof form === "string") {
      send(res, form === "too_large" ? 413 : 415, "Bad request.", "text/plain; charset=utf-8");
      return;
    }
    if (ctx.auth.loginLocked()) {
      send(res, 429, pages.loginPage("Too many wrong tokens. Wait 15 minutes, or reset the token: docker exec zavi-connector node dist/main.js reset-admin-token"));
      return;
    }
    const id = ctx.auth.login(form.get("token") ?? "");
    if (!id) {
      send(res, 401, pages.loginPage("That admin token is not right. It was printed once in the connector's log: docker logs zavi-connector"));
      return;
    }
    redirect(res, "/", { "Set-Cookie": `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
    return;
  }

  const session = ctx.auth.session(cookieId);
  if (!session) {
    if (method === "POST") send(res, 401, pages.loginPage("Your session ended. Log in again."));
    else redirect(res, "/login");
    return;
  }

  let form: URLSearchParams | null = null;
  if (method === "POST") {
    const f = await readForm(req);
    if (typeof f === "string") {
      send(res, f === "too_large" ? 413 : 415, "Bad request.", "text/plain; charset=utf-8");
      return;
    }
    if (!safeEqual(f.get("csrf") ?? "", session.csrf)) {
      send(res, 403, "Forbidden: the form expired. Reload the page and try again.", "text/plain; charset=utf-8");
      return;
    }
    form = f;
  }
  const csrf = session.csrf;
  const view = pages.viewOf(ctx);

  if (path === "/logout" && form) {
    ctx.auth.logout(session.id);
    redirect(res, "/login", { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    return;
  }

  if (path === "/" && method !== "POST") {
    send(res, 200, pages.statusPage(view, csrf));
    return;
  }

  if (path === "/database") {
    if (!form) {
      send(res, 200, pages.databasePage(view, csrf, null));
      return;
    }
    if (form.get("action") === "remove") {
      ctx.db.remove();
      ctx.runtime.heartbeatSoon();
      ctx.log("info", "The database was removed from the connector.");
      send(res, 200, pages.databasePage(pages.viewOf(ctx), csrf, { ok: true, text: "Removed. The connection string was deleted from this machine." }));
      return;
    }
    const dialect = form.get("dialect") as Dialect;
    const cs = (form.get("connection_string") ?? "").trim();
    if (!DIALECTS.includes(dialect)) {
      send(res, 400, pages.databasePage(view, csrf, { ok: false, text: "Pick a database type." }));
      return;
    }
    const out = await ctx.db.testAndSave(dialect, cs);
    if (!out.ok) {
      send(res, 200, pages.databasePage(view, csrf, { ok: false, text: `[FAILED] ${out.error} Nothing was saved.` }));
      return;
    }
    ctx.runtime.heartbeatSoon();
    ctx.log("info", `A ${dialect} database was added (${out.intro.tables.length} tables found).`);
    send(res, 200, pages.databasePage(pages.viewOf(ctx), csrf, { ok: true, text: pages.connectedLine(out.intro, ctx.db.driver()?.database ?? null) }));
    return;
  }

  if (path === "/rules") {
    let catalogError: string | null = null;
    const intro = ctx.db.config()
      ? await ctx.db.catalog(60_000).catch((e: Error) => {
          catalogError = e.message;
          return ctx.db.cachedCatalog();
        })
      : null;
    if (!form) {
      send(res, 200, pages.rulesPage(view, csrf, intro, catalogError, url.searchParams.get("saved") === "1"));
      return;
    }
    if (!intro) {
      send(res, 409, pages.rulesPage(view, csrf, intro, catalogError ?? "Add a database first.", false));
      return;
    }
    const names = new Set(intro.tables.map((t) => t.name));
    const allowed = form.getAll("allowed").filter((n) => names.has(n));
    const typed = (form.get("blocked_extra") ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^[^\u0000-\u001f]+\.[^\u0000-\u001f]+$/.test(s) && s.length <= 512);
    const blocked = [...new Set([...form.getAll("blocked").filter((b) => b.length <= 512 && b.includes(".")), ...typed])].slice(0, 5000);
    const leave = form.get("what_can_leave") as WhatCanLeave;
    const maxRows = Number(form.get("max_rows"));
    if (leave !== "totals_and_counts_only" && leave !== "rows_without_blocked_columns") {
      send(res, 400, pages.rulesPage(view, csrf, intro, "Choose what can leave this machine.", false));
      return;
    }
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) {
      send(res, 400, pages.rulesPage(view, csrf, intro, `Max rows per query must be a whole number from 1 to ${MAX_ROWS}.`, false));
      return;
    }
    const keepCols = ctx.rules.current().rules.allowed_columns;
    ctx.rules.save({ allowed, blocked, what_can_leave: leave, max_rows: maxRows, ...(keepCols && keepCols.length > 0 ? { allowed_columns: keepCols } : {}) }, { database: ctx.db.driver()?.database ?? null, unit: intro.dialect === "mongodb" ? "collection" : "table" });
    ctx.log("info", `Rules saved: ${allowed.length} allowed, ${blocked.length} blocked, ${leave}.`);
    redirect(res, "/rules?saved=1");
    return;
  }

  if (path === "/activity" && !form) {
    send(res, 200, pages.activityPage(view, csrf, ctx.activity.list(200)));
    return;
  }
  const m = /^\/activity\/([0-9a-f-]{36})$/.exec(path);
  if (m && !form) {
    const entry = ctx.activity.get(m[1]!);
    if (!entry) {
      send(res, 404, pages.errorPage("That activity entry is not in the log (it may have rotated out)."));
      return;
    }
    send(res, 200, pages.activityDetailPage(view, csrf, entry));
    return;
  }

  send(res, 404, pages.errorPage("Not found."));
}

