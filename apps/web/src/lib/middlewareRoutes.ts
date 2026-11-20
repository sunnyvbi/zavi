import { NextResponse, type NextRequest } from "next/server";
import { workspaceAgentHref } from "@/lib/workspace/tabUrl";

const LEGACY_PATHS_PRESERVED = new Set<string>([
  "/edit",
]);

export { isPublicPath } from "./publicPaths";

const CREATOR_ROOT = "/creator";
const CREATOR_PREFIX = "/creator/";

export function isCreatorGatedPath(pathname: string): boolean {
  return pathname === CREATOR_ROOT || pathname.startsWith(CREATOR_PREFIX);
}

export function rewriteAgentsToWorkspace(req: NextRequest): NextResponse | null {
  const url = req.nextUrl;
  const path = url.pathname;

  if (!path.startsWith("/agents")) return null;

  if (path === "/agents" || path === "/agents/") {
    const target = new URL("/workspace", req.url);
    return NextResponse.redirect(target, 307);
  }

  if (path === "/agents/new" || path.startsWith("/agents/new/")) {
    return null;
  }

  const m = path.match(/^\/agents\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  const slug = m[1];
  const sub = m[2] ?? "";

  if (LEGACY_PATHS_PRESERVED.has(sub)) return null;

  const target = new URL(workspaceAgentHref(slug), req.url);
  for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
  return NextResponse.redirect(target, 307);
}

const APPROVAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function rewriteLegacyToWorkspace(req: NextRequest): NextResponse | null {
  const url = req.nextUrl;
  const path = url.pathname;

  const carry = (target: URL): NextResponse => {
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
    return NextResponse.redirect(target, 307);
  };

  if (path === "/approvals" || path.startsWith("/approvals/")) {
    const target = new URL("/workspace", req.url);
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
    const id = path.slice("/approvals/".length).replace(/\/+$/, "");
    if (APPROVAL_ID_RE.test(id)) target.searchParams.set("decision", id.toLowerCase());
    target.searchParams.set("tab", "needs-you");
    return NextResponse.redirect(target, 307);
  }

  if (path === "/map" || path.startsWith("/map/")) {
    return carry(new URL("/workspace", req.url));
  }

  if (path === "/memory" || path === "/memory/") {
    const target = new URL("/workspace", req.url);
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
    target.searchParams.set("tab", "memory");
    return NextResponse.redirect(target, 307);
  }

  return null;
}
