
import { randomUUID } from "node:crypto";
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { assertRunTenantOwnership } from "@/services/reports/guard";
import { scanArtifactForLeaks } from "@/services/agents/prototype-links";
import { ExpectedToolError } from "@/services/tools/types";
import { trackPrototypePublished } from "@/services/analytics/action-events";

export const SHARED_PAGES_BUCKET = "shared-pages";
export const SHARED_PAGE_MAX_CHARS = 200 * 1024;
export const SHARED_PAGE_TTL_DAYS = 30;

export const SHARED_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join("; ");

export const WEBRTC_OFF_SCRIPT =
  "<script>(function(){" +
  "for(var k of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCIceCandidate','RTCSessionDescription','RTCRtpSender','RTCRtpReceiver','RTCRtpTransceiver']){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch(e){}}" +
  "try{Object.defineProperty(Element.prototype,'attachShadow',{value:function(){throw new Error('shadow roots are disabled on this page')},writable:false,configurable:false})}catch(e){}" +
  "var kill=function(n){if(n.nodeType!==1)return;if(/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(n.nodeName)){n.remove();return}n.querySelectorAll&&n.querySelectorAll('iframe,frame,object,embed').forEach(function(x){x.remove()})};" +
  "new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(kill)})}).observe(document,{childList:true,subtree:true});" +
  "})()</script>";

const META_TAG = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const HTTP_EQUIV_STRIPPED = /http-equiv\s*=\s*(?:["']\s*)?(?:refresh|content-security-policy)/i;
const HREF_OR_ACTION = /\b(href|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const NAV_TAG = /<(a|area|form|base)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const decodeNumericEntities = (s: string): string =>
  s.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_m, n: string) =>
    String.fromCodePoint(n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : parseInt(n, 10)),
  );
const PING_ATTR = /\sping\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

function stripNavigationVectors(html: string): string {
  return html
    .replace(META_TAG, (tag) => (HTTP_EQUIV_STRIPPED.test(decodeNumericEntities(tag)) ? "" : tag))
    .replace(NAV_TAG, (tag) =>
      tag.replace(HREF_OR_ACTION, (match: string, attr: string, dq?: string, sq?: string, uq?: string) =>
        (dq ?? sq ?? uq ?? "").trim().startsWith("#") ? match : `${attr}="#"`,
      ),
    )
    .replace(PING_ATTR, "");
}

export function hardenPageHtml(html: string): string {
  const body = stripNavigationVectors(html.replace(/^\uFEFF?\s*<!doctype[^>]*>/i, ""));
  return (
    "<!doctype html>" +
    `<meta http-equiv="Content-Security-Policy" content="${SHARED_PAGE_CSP}">` +
    '<meta name="referrer" content="no-referrer">' +
    WEBRTC_OFF_SCRIPT +
    body
  );
}

export type SharedPageRow = {
  id: string;
  tenant_id: string;
  run_id: string;
  title: string;
  storage_path: string;
  status: "private" | "public" | "revoked";
  slug: string | null;
  expires_at: string | null;
  published_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export const SHARED_PAGE_FIELDS =
  "id, tenant_id, run_id, title, storage_path, status, slug, expires_at, published_at, revoked_at, created_at";

export async function createSharedPage(opts: {
  tenant_id: string;
  run_id: string;
  title: string;
  html: string;
}): Promise<SharedPageRow> {
  if (opts.html.length > SHARED_PAGE_MAX_CHARS) {
    throw new ExpectedToolError(
      "too_large",
      `The page is ${Math.round(opts.html.length / 1024)}KB; the limit is ${SHARED_PAGE_MAX_CHARS / 1024}KB. Cut repeated markup or data.`,
    );
  }
  let scan: ReturnType<typeof scanArtifactForLeaks>;
  try {
    scan = scanArtifactForLeaks(`${opts.title}\n${opts.html}`);
  } catch {
    scan = { ok: false, reason: "scan_error" };
  }
  if (!scan.ok) {
    throw new ExpectedToolError(
      "leak_blocked",
      `The page contained a secret-like pattern (${scan.reason}) and was not saved. Remove any keys, tokens or credentials.`,
    );
  }

  await assertRunTenantOwnership({ tenant_id: opts.tenant_id, run_id: opts.run_id });
  const tid = asTenantId(opts.tenant_id);
  const id = randomUUID();
  const storage_path = `${opts.tenant_id}/${id}.html`;

  const { error: upErr } = await tenantStorage(tid)
    .from(SHARED_PAGES_BUCKET)
    .upload(storage_path, Buffer.from(opts.html, "utf8"), {
      contentType: "text/html; charset=utf-8",
      upsert: false,
    });
  if (upErr) {
    throw new ExpectedToolError("save_failed", `The page could not be saved: ${upErr.message}`);
  }

  const { data, error } = await tenantClient(tid)
    .from("shared_pages")
    .insert({ id, run_id: opts.run_id, title: opts.title, storage_path })
    .select(SHARED_PAGE_FIELDS)
    .single<SharedPageRow>();
  if (error || !data) {
    throw new ExpectedToolError("save_failed", `The page could not be saved: ${error?.message ?? "no row"}`);
  }
  trackPrototypePublished({ tenant_id: String(tid), prototype: "shared_page" });
  return data;
}

export async function readSharedPageHtml(
  tenant_id: string,
  storage_path: string,
): Promise<string | null> {
  if (!storage_path.startsWith(`${tenant_id}/`)) return null;
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.html$/.test(storage_path)) return null;
  const { data, error } = await tenantStorage(asTenantId(tenant_id))
    .from(SHARED_PAGES_BUCKET)
    .download(storage_path);
  if (error || !data) return null;
  return await data.text();
}
