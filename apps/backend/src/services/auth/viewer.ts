
import type { Request, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const VIEWER_ALLOWED_WRITES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/api\/memory\/search$/ },
  { method: "POST", path: /^\/api\/workspace\/(agent-seen|thread-seen|agent-unread)$/ },
  { method: "POST", path: /^\/api\/workspace\/opened$/ },
  {
    method: "POST",
    path: /^\/api\/team-notes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(shown|send|dismiss|opened)$/,
  },
  { method: "PUT", path: /^\/api\/team-notes\/prefs$/ },
  { method: "POST", path: /^\/api\/onboarding-emails\/visit$/ },
  { method: "POST", path: /^\/api\/feedback\/product$/ },
  { method: "POST", path: /^\/api\/feedback\/product\/seen$/ },
  {
    method: "POST",
    path: /^\/api\/workspace\/growth\/cards\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/copied$/,
  },
];

const WRITING_GETS: ReadonlyArray<RegExp> = [
  /^\/api\/connectors\/(.+\/)?(start|install-url|manifest-init|return)$/,
  /^\/api\/extension\/ops\/next$/,
];

function routedPath(path: string): string {
  let p = path;
  try {
    p = decodeURIComponent(p);
  } catch {
  }
  p = p.toLowerCase().replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

export function viewerMayCall(method: string | undefined, rawPath: string): boolean {
  const path = routedPath(rawPath);
  const m = (method ?? "GET").toUpperCase();
  if (SAFE_METHODS.has(m)) return !WRITING_GETS.some((r) => r.test(path));
  return VIEWER_ALLOWED_WRITES.some((r) => r.method === m && r.path.test(path));
}

const CONNECTOR_MEMBER_WRITES: ReadonlyArray<RegExp> = [
  /^\/api\/connectors\/social(\/disconnect)?$/,
  /^\/api\/connectors\/composio\/[^/]+\/request$/,
];

export function isConnectorAdminWrite(method: string | undefined, rawPath: string): boolean {
  const path = routedPath(rawPath);
  if (!path.startsWith("/api/connectors/")) return false;
  const m = (method ?? "GET").toUpperCase();
  const writes = SAFE_METHODS.has(m) ? WRITING_GETS.some((r) => r.test(path)) : true;
  return writes && !CONNECTOR_MEMBER_WRITES.some((r) => r.test(path));
}

export function sendConnectorAdminOnly(res: Response): void {
  res.status(403).json({
    error: {
      code: "connector_admin_only",
      message: "Only a workspace owner or admin can connect or change accounts.",
    },
  });
}

export function sendViewerReadOnly(res: Response): void {
  res.status(403).json({
    error: {
      code: "viewer_read_only",
      message: "Your role is read-only. Ask a workspace admin to make you a member.",
    },
  });
}

export function refuseViewerWrite(
  req: Request,
  res: Response,
  tenantRole: string | null | undefined,
): boolean {
  if (tenantRole !== "viewer" || SAFE_METHODS.has((req.method ?? "GET").toUpperCase())) return false;
  sendViewerReadOnly(res);
  return true;
}
