
import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import {
  engineerPreviewEnabled,
  signPreviewToken,
  verifyPreviewToken,
  rewriteHtmlForProxy,
  restartEngineerPreview,
  sanitizePreviewPath,
} from "@/services/sandbox/engineer-preview";
import { extendSandboxTimeout } from "@/services/sandbox/e2b-client";
import { PREVIEW_HARD_CEILING_MIN } from "../../../workers/functions/preview-reaper";

const PROXY_FETCH_TIMEOUT_MS = 20_000;

export function withinHardCeiling(
  preview_started_at: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!preview_started_at) return true;
  const started = new Date(preview_started_at).getTime();
  if (!Number.isFinite(started)) return true;
  return now - started < PREVIEW_HARD_CEILING_MIN * 60 * 1000;
}
const E2B_HOST_RE = /^https:\/\/\d+-[a-z0-9]+\.e2b\.app$/i;

type RunRow = { tenant_id: string };
type PreviewRow = {
  id: string;
  tenant_id: string;
  preview_url: string | null;
  preview_status: string | null;
  preview_run_id: string | null;
  preview_error: string | null;
  preview_ended_at: string | null;
  preview_started_at: string | null;
  preview_port: number | null;
  e2b_sandbox_id: string | null;
  preview_path: string | null;
  preview_outcome: string | null;
};

const PREVIEW_ROW_COLS =
  "id, tenant_id, preview_url, preview_status, preview_run_id, preview_error, preview_ended_at, preview_started_at, preview_port, e2b_sandbox_id, preview_path, preview_outcome";

async function deriveRunTenant(run_id: string): Promise<string | null> {
  const sb = serviceClient();
  const { data } = await sb
    .from("agent_runs")
    .select("tenant_id")
    .eq("id", run_id)
    .maybeSingle<RunRow>();
  return data?.tenant_id ?? null;
}

async function loadPreviewRow(
  run_id: string,
  tenant_id: string,
): Promise<PreviewRow | null> {
  const sb = serviceClient();
  const { data } = await sb
    .from("tenant_sandbox")
    .select(PREVIEW_ROW_COLS)
    .eq("preview_run_id", run_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle<PreviewRow>();
  return data ?? null;
}

function previewPathPrefix(run_id: string): string {
  return `/api/workspace/engineer-preview/${encodeURIComponent(run_id)}`;
}

export async function getEngineerPreviewStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const runId = String(req.params.runId ?? "");
  if (!runId) {
    res.status(400).json({ error: { code: "bad_run_id", message: "Missing runId." } });
    return;
  }

  if (!(await engineerPreviewEnabled(auth.tenant_id))) {
    res.status(200).json({ status: "none" });
    return;
  }

  const runTenant = await deriveRunTenant(runId);
  if (!runTenant) {
    res.status(404).json({ status: "none" });
    return;
  }
  if (runTenant !== auth.tenant_id) {
    res.status(403).json({ error: { code: "forbidden", message: "Not your run." } });
    return;
  }

  const row = await loadPreviewRow(runId, runTenant);
  if (!row || row.preview_status !== "live" || !row.preview_url) {
    if (row?.preview_status === "dead") {
      res.status(200).json({
        status: "dead",
        preview_error: row.preview_error ?? null,
        ended_at: row.preview_ended_at ?? null,
        can_restart: Boolean(row.e2b_sandbox_id),
      });
      return;
    }
    res.status(200).json({ status: row?.preview_status ?? "none" });
    return;
  }

  try {
    await serviceClient().rpc("touch_sandbox_preview_viewed", { p_id: row.id });
  } catch {
  }

  if (row.e2b_sandbox_id && withinHardCeiling(row.preview_started_at)) {
    try {
      await extendSandboxTimeout(row.e2b_sandbox_id);
    } catch {
    }
  }

  const token = signPreviewToken({ runId, tenantId: runTenant });

  const previewPath = sanitizePreviewPath(row.preview_path);
  const outcome = row.preview_outcome === "on_target" || row.preview_outcome === "off_target"
    ? row.preview_outcome
    : null;

  const target = previewPath ?? "/";
  const qIdx = target.indexOf("?");
  const targetPath = qIdx === -1 ? target : target.slice(0, qIdx);
  const params = new URLSearchParams(qIdx === -1 ? "" : target.slice(qIdx + 1));
  params.delete("__pt");
  params.set("__pt", token);
  const proxyUrl = `${previewPathPrefix(runId)}${targetPath}?${params.toString()}`;

  res.status(200).json({
    status: "live",
    proxy_url: proxyUrl,
    preview_path: previewPath,
    preview_outcome: outcome,
  });
}

export async function restartEngineerPreviewRoute(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const runId = String(req.params.runId ?? "");
  if (!runId) {
    res.status(400).json({ error: { code: "bad_run_id", message: "Missing runId." } });
    return;
  }

  if (!(await engineerPreviewEnabled(auth.tenant_id))) {
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
    return;
  }

  const runTenant = await deriveRunTenant(runId);
  if (!runTenant) {
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
    return;
  }
  if (runTenant !== auth.tenant_id) {
    res.status(403).json({ error: { code: "forbidden", message: "Not your run." } });
    return;
  }

  const row = await loadPreviewRow(runId, runTenant);
  if (!row) {
    res.status(409).json({
      error: { code: "preview_unrecoverable", message: "Re-run the engineer to rebuild this preview." },
    });
    return;
  }
  if (!row.e2b_sandbox_id) {
    res.status(409).json({
      error: { code: "sandbox_gone", message: "Re-run the engineer to rebuild this preview." },
    });
    return;
  }
  if (row.preview_status === "starting") {
    res.status(409).json({
      error: { code: "restart_in_flight", message: "A restart is already in progress." },
    });
    return;
  }
  if (row.preview_status === "live" && row.preview_url) {
    res.status(200).json({ status: "live" });
    return;
  }

  const result = await restartEngineerPreview({
    row_id: row.id,
    sandbox_id: row.e2b_sandbox_id,
    run_id: runId,
    port: row.preview_port ?? undefined,
  });

  if (!result.restarted) {
    res.status(200).json({ status: "dead", preview_error: result.reason });
    return;
  }
  res.status(200).json({ status: "live" });
}

function readToken(req: Request, runId: string): string | null {
  const q = req.query?.__pt;
  const fromQuery = Array.isArray(q) ? q[0] : q;
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  const cookieName = `__epv_${runId}`;
  const raw = req.headers?.cookie;
  if (typeof raw === "string") {
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === cookieName) return decodeURIComponent(v.join("="));
    }
  }
  return null;
}

export async function engineerPreviewProxy(
  req: Request,
  res: Response,
): Promise<void> {
  const sendState = (code: number, state: string): void => {
    res.setHeader("X-Preview-State", state);
    res.setHeader("Cache-Control", "no-store");
    res.status(code).end();
  };

  const runId = String(req.params.runId ?? "");
  if (!runId) {
    sendState(400, "bad_request");
    return;
  }

  const token = readToken(req, runId);
  const claims = verifyPreviewToken(token);
  if (!token || !claims || claims.runId !== runId) {
    sendState(401, "token_invalid");
    return;
  }

  const runTenant = await deriveRunTenant(runId);
  if (!runTenant || claims.tenantId !== runTenant) {
    sendState(403, "forbidden");
    return;
  }

  if (!(await engineerPreviewEnabled(runTenant))) {
    sendState(404, "unavailable");
    return;
  }

  const row = await loadPreviewRow(runId, runTenant);
  if (!row || row.preview_status !== "live" || !row.preview_url) {
    sendState(410, "expired");
    return;
  }

  const origin = row.preview_url;
  if (!E2B_HOST_RE.test(origin)) {
    sendState(502, "origin_invalid");
    return;
  }

  const rest = String((req.params as Record<string, string>)[0] ?? "");
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (k === "__pt") continue;
    if (Array.isArray(v)) for (const x of v) search.append(k, String(x));
    else if (v != null) search.append(k, String(v));
  }
  const qs = search.toString();
  let target: URL;
  try {
    target = new URL(`${rest}${qs ? `?${qs}` : ""}`, `${origin}/`);
  } catch {
    sendState(400, "bad_path");
    return;
  }
  if (target.origin !== origin) {
    sendState(400, "bad_path");
    return;
  }

  const prefix = previewPathPrefix(runId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);
  let upstream: globalThis.Response;
  try {
    const fwdHeaders: Record<string, string> = { "accept-encoding": "identity" };
    if (typeof req.headers.accept === "string") fwdHeaders.accept = req.headers.accept;
    if (typeof req.headers["content-type"] === "string")
      fwdHeaders["content-type"] = req.headers["content-type"] as string;
    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    upstream = await fetch(target.toString(), {
      method,
      headers: fwdHeaders,
      ...(hasBody && req.body
        ? {
            body:
              typeof req.body === "string" || Buffer.isBuffer(req.body)
                ? req.body
                : JSON.stringify(req.body),
          }
        : {}),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    console.warn(
      `[engineer preview] upstream unreachable run=${runId}: ${(e as Error).message ?? e}`,
    );
    sendState(502, "upstream_unreachable");
    return;
  }
  clearTimeout(timer);

  res.setHeader(
    "Set-Cookie",
    `__epv_${runId}=${encodeURIComponent(token)}; Path=${prefix}; HttpOnly; Secure; SameSite=None`,
  );
  res.setHeader("Cache-Control", "no-store");

  const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
  res.setHeader("Content-Type", ct);
  const loc = upstream.headers.get("location");
  if (loc) {
    if (loc.startsWith("/") && !loc.startsWith("//")) {
      res.setHeader("Location", `${prefix}${loc}`);
    } else {
      res.setHeader("Location", loc);
    }
  }
  res.setHeader(
    "Content-Security-Policy",
    "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self' https://*.zaviagent.com http://localhost:3000",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");

  const status = upstream.status;

  if (/text\/html/i.test(ct)) {
    const html = await upstream.text();
    const rewritten = rewriteHtmlForProxy(html, prefix);
    res.status(status).send(rewritten);
    return;
  }

  if (!upstream.body) {
    res.status(status).end();
    return;
  }
  res.status(status);
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
}
