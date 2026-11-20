
import type { Request, Response } from "express";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { publicHostClient, tenantClient, tenantRpc, type TenantId } from "@/services/tenant-client";
import { getBoolSetting, getBoolSettingStrict } from "@/services/settings";
import { OLD_SITE_FROZEN_STATUS, oldSiteFrozenBody } from "@/services/sites/old-site-freeze";
import { isSiteEditsAppId, SITE_EDITS_APP_PREFIX, siteIdFromEditsApp } from "@/services/sites/site-inline-edits";
import { isVisibleSite } from "@/services/sites/site-build-status";

const MAX_SELECTOR = 400;
const MAX_TEXT = 5000;
const MAX_SEGMENTS = 40;
export const MAX_RUN_CHARS = 4000;
const MAX_STYLE_VALUE = 120;
const SAFE_SELECTOR = /^[A-Za-z0-9_\-.#[\]=:()>+~*, \t]+$/;
const EDITABLE_STYLE_KEYS = [
  "color",
  "backgroundColor",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "textDecoration",
  "textAlign",
];
const SAFE_STYLE_VALUE = /^[A-Za-z0-9 #%().,'"/-]+$/;
const FORBIDDEN_STYLE = /url\s*\(|javascript:|expression\s*\(|@import|<|>/i;

const MAX_URL = 2048;
const EDITABLE_ATTR_KEYS = ["href", "src"] as const;
type AttrKey = (typeof EDITABLE_ATTR_KEYS)[number];
const HREF_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);
const SRC_SCHEMES = new Set(["https:"]);
const URL_PARSE_BASE = "https://base.invalid/";

export function sanitizeUrl(key: AttrKey, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length === 0 || t.length > MAX_URL) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return null;
  if (/\s/.test(t)) return null;
  if (/\\/.test(t)) return null;
  if (/%00/i.test(t)) return null;
  if (t.startsWith("//")) return null;

  const scheme = t.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) {
    let proto: string;
    try {
      proto = new URL(t).protocol.toLowerCase();
    } catch {
      return null;
    }
    const allowed = key === "href" ? HREF_SCHEMES : SRC_SCHEMES;
    return allowed.has(proto) ? t : null;
  }
  if (t.startsWith("#")) return key === "href" ? t : null;
  try {
    if (new URL(t, URL_PARSE_BASE).protocol.toLowerCase() !== "https:") return null;
  } catch {
    return null;
  }
  return t;
}

export function isSafeSelector(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.trim().length > 0 &&
    v.length <= MAX_SELECTOR &&
    SAFE_SELECTOR.test(v.trim())
  );
}

function sanitizeStyleValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0 || t.length > MAX_STYLE_VALUE) return null;
  if (!SAFE_STYLE_VALUE.test(t) || FORBIDDEN_STYLE.test(t)) return null;
  return t;
}

export type StoredEditPatch = {
  text?: string;
  segments?: Array<string | null>;
  style?: Record<string, string>;
  attrs?: Record<string, string>;
};

export function sanitizeSegments(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SEGMENTS) return null;
  if (!raw.every((s) => typeof s === "string" && s.length <= MAX_TEXT)) return null;
  if (raw.every((s) => !(s as string).trim())) return null;
  return raw as string[];
}

export function sanitizePatchSegments(raw: unknown): Array<string | null> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SEGMENTS) return null;
  let words = 0;
  for (const s of raw) {
    if (s === null) continue;
    if (typeof s !== "string" || s.length > MAX_TEXT || !s.trim()) return null;
    words++;
  }
  return words > 0 ? (raw as Array<string | null>) : null;
}

export function sanitizePatch(raw: unknown): StoredEditPatch {
  const out: StoredEditPatch = {};
  if (!raw || typeof raw !== "object") return out;
  const p = raw as Record<string, unknown>;
  if (typeof p.text === "string") out.text = p.text.slice(0, MAX_TEXT);
  const segments = sanitizePatchSegments(p.segments);
  if (segments) out.segments = segments;
  if (p.style && typeof p.style === "object") {
    const style: Record<string, string> = {};
    for (const k of EDITABLE_STYLE_KEYS) {
      const val = sanitizeStyleValue((p.style as Record<string, unknown>)[k]);
      if (val !== null) style[k] = val;
    }
    if (Object.keys(style).length > 0) out.style = style;
  }
  if (p.attrs && typeof p.attrs === "object") {
    const attrs: Record<string, string> = {};
    for (const k of EDITABLE_ATTR_KEYS) {
      const val = sanitizeUrl(k, (p.attrs as Record<string, unknown>)[k]);
      if (val !== null) attrs[k] = val;
    }
    if (Object.keys(attrs).length > 0) out.attrs = attrs;
  }
  return out;
}

export function patchIsEmpty(patch: StoredEditPatch): boolean {
  return !patch.text && !patch.segments && !patch.style && !patch.attrs;
}

export type EditBefore = {
  text?: string;
  segments?: string[];
  style?: Record<string, string>;
  attrs?: Record<string, string>;
};

export function sanitizeBefore(raw: unknown): EditBefore | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const out: EditBefore = {};
  if (typeof b.text === "string" && b.text.trim()) out.text = b.text.slice(0, MAX_TEXT);
  const segments = sanitizeSegments(b.segments);
  if (segments) out.segments = segments;
  if (b.style && typeof b.style === "object") {
    const style: Record<string, string> = {};
    for (const k of EDITABLE_STYLE_KEYS) {
      const val = sanitizeStyleValue((b.style as Record<string, unknown>)[k]);
      if (val !== null) style[k] = val;
    }
    if (Object.keys(style).length > 0) out.style = style;
  }
  if (b.attrs && typeof b.attrs === "object") {
    const attrs: Record<string, string> = {};
    for (const k of EDITABLE_ATTR_KEYS) {
      const val = sanitizeUrl(k, (b.attrs as Record<string, unknown>)[k]);
      if (val !== null) attrs[k] = val;
    }
    if (Object.keys(attrs).length > 0) out.attrs = attrs;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function withBefore(patch: StoredEditPatch, before: EditBefore | null): StoredEditPatch & { before?: EditBefore } {
  return before ? { ...patch, before } : patch;
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function normHost(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

type HostingRow = { status?: string; external_ref?: { url?: unknown } | null };
type DomainRow = { status?: string; external_ref?: { hostname?: unknown } | null };
type CustomDomainRow = { hostname?: unknown; status?: unknown };
const PUBLIC_HOST_RE =
  /^(?=[^:]{4,253}(?::|$))[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z0-9-]{2,63}(?::[0-9]{1,5})?$/;

export function servingHosts(
  hosting: HostingRow[],
  domains: DomainRow[],
  custom: CustomDomainRow[],
): string[] {
  const out = new Set<string>();
  for (const r of hosting) {
    if (r.status !== "ready") continue;
    const h = hostOf(r.external_ref?.url);
    if (h) out.add(h);
  }
  for (const r of domains) {
    if (r.status !== "ready") continue;
    const h = normHost(r.external_ref?.hostname);
    if (h) out.add(h);
  }
  for (const r of custom) {
    if (r.status !== "verified") continue;
    const h = normHost(r.hostname);
    if (h) out.add(h);
  }
  return [...out];
}

async function ownsApp(tid: TenantId, appId: string): Promise<boolean> {
  const want = appId.trim().toLowerCase();
  if (!want) return false;
  const tc = tenantClient(tid);
  const [h, d, c] = await Promise.all([
    tc.from("tenant_resources").select("status, external_ref").eq("resource_kind", "hosting"),
    tc.from("tenant_resources").select("status, external_ref").eq("resource_kind", "domain"),
    tc.from("tenant_custom_domains").select("hostname, status"),
  ]);
  return servingHosts(
    (h.data ?? []) as HostingRow[],
    (d.data ?? []) as DomainRow[],
    (c.data ?? []) as CustomDomainRow[],
  ).includes(want);
}

async function isTenantSiteHost(tid: TenantId, appId: string): Promise<boolean> {
  const want = appId.trim().toLowerCase();
  if (!want) return false;
  try {
    const { siteStore } = await import("@/services/sites/store");
    const sites = await siteStore().listForTenant(tid);
    return sites.some(
      (s) => s.tenant_id === tid && (normHost(s.hostname) === want || hostOf(s.live_url) === want),
    );
  } catch {
    return false;
  }
}

async function ownsSite(tid: TenantId, siteId: string): Promise<boolean> {
  try {
    const { siteStore } = await import("@/services/sites/store");
    const site = await siteStore().get(tid, siteId);
    return !!site && site.tenant_id === tid && site.id === siteId && isVisibleSite(site);
  } catch {
    return false;
  }
}

export async function assertOwnsApp(tid: TenantId, appId: string, res: Response): Promise<boolean> {
  if (isSiteEditsAppId(appId)) {
    const siteId = siteIdFromEditsApp(appId);
    if (siteId && (await ownsSite(tid, siteId))) return true;
    res.status(403).json({
      error: { code: "not_your_app", message: "this site is not registered to your workspace" },
    });
    return false;
  }
  if (await ownsApp(tid, appId)) return true;
  if (await isTenantSiteHost(tid, appId)) {
    res.status(409).json({
      error: {
        code: "not_available_for_site",
        message: "Inline edits aren't available for this site. Ask for the change in its Build chat.",
      },
    });
    return false;
  }
  res.status(403).json({
    error: { code: "not_your_app", message: "this app is not registered to your workspace" },
  });
  return false;
}

export async function refuseInlineEdit(tid: TenantId, appId: string, res: Response): Promise<void> {
  if (isSiteEditsAppId(appId)) {
    if (await assertOwnsApp(tid, appId, res)) {
      res.status(409).json({
        error: { code: SITE_EDITS_APPLY_CODE, message: "A site's edits go live through its code: apply them from Publish." },
      });
    }
    return;
  }
  if (await ownsApp(tid, appId)) {
    res.status(OLD_SITE_FROZEN_STATUS).json(oldSiteFrozenBody());
    return;
  }
  await assertOwnsApp(tid, appId, res);
}

export async function allowInlineWrite(tid: TenantId, appId: string, res: Response): Promise<boolean> {
  if (isSiteEditsAppId(appId)) return assertOwnsApp(tid, appId, res);
  await refuseInlineEdit(tid, appId, res);
  return false;
}

export async function allowSiteInlineWrite(auth: AuthedRequest, appId: string, res: Response): Promise<boolean> {
  return allowInlineWrite(auth.tenant_id, appId, res);
}

export function writeFailed(res: Response, code: string, where: string, error: string): void {
  console.warn(JSON.stringify({ evt: "website_edit_write_failed", where, error: String(error).slice(0, 300) }));
  res.status(500).json({ error: { code, message: "We couldn't save that change. Try again.", chat: "We couldn't save that change. Try again." } });
}

export async function getWebsiteEditsHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const app = typeof req.query.app === "string" ? req.query.app : "";
  if (!app) {
    res.status(400).json({ error: { code: "missing_app", message: "app is required" } });
    return;
  }
  if (!(await assertOwnsApp(auth.tenant_id, app, res))) return;

  const { data, error } = await tenantClient(auth.tenant_id)
    .from("website_edits")
    .select("id, selector, patch, removed, updated_at, published_at, published_patch")
    .eq("app_id", app);
  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  res.status(200).json({ edits: data ?? [] });
}

export async function setWebsiteEditHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const body = (req.body ?? {}) as {
    app_id?: unknown;
    selector?: unknown;
    patch?: unknown;
    remove?: unknown;
    before?: unknown;
  };
  const app_id = typeof body.app_id === "string" ? body.app_id : "";
  if (!app_id) {
    res.status(400).json({ error: { code: "missing_app", message: "app_id is required" } });
    return;
  }
  if (!(await allowSiteInlineWrite(auth, app_id, res))) return;
  if (!isSafeSelector(body.selector)) {
    res.status(400).json({ error: { code: "bad_selector", message: "invalid selector" } });
    return;
  }
  const selector = (body.selector as string).trim();
  const remove = body.remove === true;
  const patch = remove ? {} : sanitizePatch(body.patch);
  if (!remove && patchIsEmpty(patch)) {
    res.status(400).json({ error: { code: "empty_patch", message: "patch has no changes" } });
    return;
  }
  const result = await upsertWebsiteEdit(
    auth.tenant_id,
    app_id,
    selector,
    withBefore(patch, sanitizeBefore(body.before)),
    remove,
  );
  if (result.error) {
    writeFailed(res, "write_failed", "set", result.error);
    return;
  }
  if (!result.version) {
    writeFailed(res, "write_failed", "set", "merge_website_edit did not return the saved row version");
    return;
  }
  res.status(200).json({ ok: true, edit: { selector, ...result.version } });
}

export type PriorEdit = { patch: StoredEditPatch; removed: boolean } | null;

export async function upsertWebsiteEdit(
  tenant_id: TenantId,
  app_id: string,
  selector: string,
  patch: StoredEditPatch,
  remove: boolean,
  replace = false,
): Promise<{ error?: string; prior?: PriorEdit; version?: { id: string; updated_at: string; text_only: boolean } }> {
  const { data, error } = await tenantRpc(tenant_id, "merge_website_edit", {
    p_app_id: app_id,
    p_selector: selector,
    p_patch: remove ? {} : patch,
    p_remove: remove,
    p_replace: replace,
  });
  if (error) return { error: error.message };
  const r = (data ?? {}) as { existed?: unknown; patch?: unknown; removed?: unknown; id?: unknown; updated_at?: unknown; current_patch?: unknown };
  const prior: PriorEdit =
    r.existed === true
      ? { patch: withBefore(sanitizePatch(r.patch), sanitizeBefore(record(r.patch).before)), removed: r.removed === true }
      : null;
  if (remove && isSiteEditsAppId(app_id)) {
    const before = sanitizeBefore(record(r.patch).before) ?? sanitizeBefore(record(patch).before);
    if (before) {
      const kept = await tenantClient(tenant_id)
        .from("website_edits")
        .update({ patch: { before } })
        .eq("app_id", app_id)
        .eq("selector", selector)
        .eq("removed", true);
      if (kept.error) console.warn(`[website-edits] removal kept no original for ${app_id} ${selector}: ${kept.error.message}`);
    }
  }
  const currentPatch = sanitizePatch(r.current_patch);
  const textOnly =
    (typeof currentPatch.text === "string" || Array.isArray(currentPatch.segments)) &&
    Object.keys(currentPatch).every((key) => key === "before" || key === "text" || key === "segments");
  const version = typeof r.id === "string" && typeof r.updated_at === "string"
    ? { id: r.id, updated_at: r.updated_at, text_only: textOnly }
    : undefined;
  return { prior, version };
}

export function mergeEditPatch(prior: StoredEditPatch, next: StoredEditPatch): StoredEditPatch {
  const out: StoredEditPatch = { ...prior };
  if (next.text !== undefined) {
    out.text = next.text;
    delete out.segments;
  }
  if (next.segments !== undefined) {
    const before = out.segments;
    out.segments =
      before && before.length === next.segments.length
        ? next.segments.map((s, i) => (s === null ? before[i] : s))
        : next.segments;
    delete out.text;
  }
  if (next.style) out.style = { ...prior.style, ...next.style };
  if (next.attrs) out.attrs = { ...prior.attrs, ...next.attrs };
  return out;
}

export async function clearWebsiteEditsForTenant(tenant_id: string): Promise<{ deleted?: number; error?: string }> {
  const { data, error } = await tenantClient(tenant_id as TenantId)
    .from("website_edits")
    .delete()
    .not("id", "is", null)
    .not("app_id", "like", `${SITE_EDITS_APP_PREFIX}%`)
    .select("id");
  if (error) return { error: error.message };
  return { deleted: Array.isArray(data) ? data.length : 0 };
}

type EditRow = {
  id: string;
  selector: string;
  patch: Record<string, unknown> | null;
  removed: boolean;
  published_patch: Record<string, unknown> | null;
  published_removed: boolean;
  published_at: string | null;
  updated_at: string;
};

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

function isPending(r: EditRow): boolean {
  if (!r.published_at) return true;
  if (r.removed !== r.published_removed) return true;
  return stable(r.patch ?? {}) !== stable(r.published_patch ?? {});
}

export type PendingChange = {
  id: string;
  updated_at: string;
  selector: string;
  kind: "text" | "style" | "link" | "image" | "removed" | "mixed";
  summary: string;
  detail: string | null;
  status: "new" | "updated";
};

const STYLE_LABELS: Record<string, string> = {
  color: "Text color",
  backgroundColor: "Background",
  fontSize: "Font size",
  fontFamily: "Font",
  fontWeight: "Font weight",
  fontStyle: "Font style",
  textDecoration: "Text decoration",
  textAlign: "Text alignment",
};

function truncate(s: string, n = 90): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function describePendingChange(r: EditRow): PendingChange {
  const status: "new" | "updated" = r.published_at ? "updated" : "new";
  const version = { id: r.id, updated_at: r.updated_at };
  if (r.removed) {
    return { ...version, selector: r.selector, kind: "removed", summary: "Element hidden", detail: null, status };
  }
  const patch = (r.patch ?? {}) as StoredEditPatch;
  const facets: PendingChange["kind"][] = [];
  if (typeof patch.text === "string" || Array.isArray(patch.segments)) facets.push("text");
  if (patch.style && Object.keys(patch.style).length > 0) facets.push("style");
  if (patch.attrs?.href) facets.push("link");
  if (patch.attrs?.src) facets.push("image");

  if (facets.length === 0) {
    return { ...version, selector: r.selector, kind: "text", summary: "Edited", detail: null, status };
  }
  if (facets.length > 1) {
    return { ...version, selector: r.selector, kind: "mixed", summary: "Multiple edits", detail: null, status };
  }
  switch (facets[0]) {
    case "text":
      return { ...version, selector: r.selector, kind: "text", summary: "Text edited", detail: truncate(patch.text ?? patch.segments?.filter((x): x is string => typeof x === "string").join(" ") ?? ""), status };
    case "style": {
      const keys = Object.keys(patch.style ?? {});
      const summary = keys.length === 1 ? `${STYLE_LABELS[keys[0]] ?? "Style"} changed` : "Style changed";
      const detail = keys.map((k) => `${STYLE_LABELS[k] ?? k}: ${patch.style?.[k]}`).join(", ");
      return { ...version, selector: r.selector, kind: "style", summary, detail: truncate(detail), status };
    }
    case "link":
      return { ...version, selector: r.selector, kind: "link", summary: "Link updated", detail: truncate(patch.attrs?.href ?? ""), status };
    case "image":
      return { ...version, selector: r.selector, kind: "image", summary: "Image replaced", detail: truncate(patch.attrs?.src ?? ""), status };
    default:
      return { ...version, selector: r.selector, kind: "text", summary: "Edited", detail: null, status };
  }
}

async function loadAppRows(tenantId: TenantId, appId: string): Promise<EditRow[] | { error: string }> {
  const { data, error } = await tenantClient(tenantId)
    .from("website_edits")
    .select("id, selector, patch, removed, published_patch, published_removed, published_at, updated_at")
    .eq("app_id", appId);
  if (error) return { error: error.message };
  return (data ?? []) as EditRow[];
}

function requireAppId(req: Request, res: Response): string | null {
  const app_id = typeof req.body?.app_id === "string" ? req.body.app_id : "";
  if (!app_id) {
    res.status(400).json({ error: { code: "missing_app", message: "app_id is required" } });
    return null;
  }
  return app_id;
}

export const SITE_EDITS_APPLY_CODE = "site_edits_apply";

async function refuseOverlayPublish(tid: TenantId, appId: string, res: Response): Promise<void> {
  if (!isSiteEditsAppId(appId)) {
    await refuseInlineEdit(tid, appId, res);
    return;
  }
  if (!(await assertOwnsApp(tid, appId, res))) return;
  res.status(409).json({
    error: {
      code: SITE_EDITS_APPLY_CODE,
      message: "A site's edits go live through its code: apply them from Publish.",
    },
  });
}

export async function publishWebsiteEditsHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const app_id = requireAppId(req, res);
  if (!app_id) return;
  await refuseOverlayPublish(auth.tenant_id, app_id, res);
}

export async function unpublishWebsiteEditsHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const app_id = requireAppId(req, res);
  if (!app_id) return;
  await refuseOverlayPublish(auth.tenant_id, app_id, res);
}

export async function websitePublishStatusHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const app = typeof req.query.app === "string" ? req.query.app : "";
  if (!app) {
    res.status(400).json({ error: { code: "missing_app", message: "app is required" } });
    return;
  }
  if (!(await assertOwnsApp(auth.tenant_id, app, res))) return;
  const rows = await loadAppRows(auth.tenant_id, app);
  if ("error" in rows) {
    res.status(500).json({ error: { code: "read_failed", message: rows.error } });
    return;
  }
  const published = rows.filter((r) => r.published_at).length;
  const pending = rows.filter(isPending).length;
  const lastPublishedAt = rows
    .map((r) => r.published_at)
    .filter((x): x is string => !!x)
    .sort()
    .pop() ?? null;
  res.status(200).json({ pending, published, last_published_at: lastPublishedAt });
}

export async function websitePendingChangesHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const app = typeof req.query.app === "string" ? req.query.app : "";
  if (!app) {
    res.status(400).json({ error: { code: "missing_app", message: "app is required" } });
    return;
  }
  if (!(await assertOwnsApp(auth.tenant_id, app, res))) return;
  const rows = await loadAppRows(auth.tenant_id, app);
  if ("error" in rows) {
    res.status(500).json({ error: { code: "read_failed", message: rows.error } });
    return;
  }
  const items = rows.filter(isPending).map(describePendingChange);
  res.status(200).json({ items });
}

export async function discardWebsiteEditsHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const app_id = requireAppId(req, res);
  if (!app_id) return;
  if (!(await assertOwnsApp(auth.tenant_id, app_id, res))) return;

  const selector = typeof req.body?.selector === "string" ? req.body.selector.trim() : null;
  if (req.body?.restore !== undefined && req.body?.restore !== null) {
    if (!(await allowInlineWrite(auth.tenant_id, app_id, res))) return;
    const restore = req.body.restore as { patch?: unknown; removed?: unknown };
    const expected = req.body?.expected as { id?: unknown; updated_at?: unknown } | null | undefined;
    if (typeof restore !== "object" || !isSafeSelector(selector)) {
      res.status(400).json({ error: { code: "bad_selector", message: "restore needs a selector" } });
      return;
    }
    if (!expected || typeof expected.id !== "string" || typeof expected.updated_at !== "string") {
      res.status(400).json({ error: { code: "missing_edit_version", message: "Reload this change before restoring it." } });
      return;
    }
    const removed = restore.removed === true;
    const patch = removed
      ? withBefore({}, sanitizeBefore(record(restore.patch).before))
      : withBefore(sanitizePatch(restore.patch), sanitizeBefore(record(restore.patch).before));
    const { data, error } = await tenantClient(auth.tenant_id)
      .from("website_edits")
      .update({ patch, removed, updated_at: new Date().toISOString() })
      .eq("app_id", app_id)
      .eq("selector", selector)
      .eq("id", expected.id)
      .eq("updated_at", expected.updated_at)
      .select("id");
    if (error) {
      writeFailed(res, "discard_failed", "restore", error.message);
      return;
    }
    if (!Array.isArray(data) || data.length === 0) {
      res.status(409).json({ error: { code: "edit_changed", message: "That change was edited somewhere else. Reload and try again." } });
      return;
    }
    res.status(200).json({ discarded: 1 });
    return;
  }
  const rows = await loadAppRows(auth.tenant_id, app_id);
  if ("error" in rows) {
    res.status(500).json({ error: { code: "read_failed", message: rows.error } });
    return;
  }
  let targets = rows.filter(isPending);
  if (selector) targets = targets.filter((r) => r.selector === selector);
  if (targets.length === 0) {
    res.status(200).json({ discarded: 0 });
    return;
  }

  const now = new Date().toISOString();
  const tc = tenantClient(auth.tenant_id);
  const textOnly = req.body?.only === "text" && !!selector;
  const expected = req.body?.expected as { id?: unknown; updated_at?: unknown } | null | undefined;
  if (
    selector &&
    (!expected || typeof expected !== "object" || typeof expected.id !== "string" || typeof expected.updated_at !== "string")
  ) {
    res.status(400).json({ error: { code: "missing_edit_version", message: "Reload this change before discarding it." } });
    return;
  }
  if (selector && targets.some((row) => row.id !== expected!.id || row.updated_at !== expected!.updated_at)) {
    res.status(409).json({ error: { code: "edit_changed", message: "That change was edited somewhere else. Reload and try again." } });
    return;
  }
  const keptStyle = (r: EditRow): Record<string, unknown> | null => {
    if (!textOnly || r.removed) return null;
    const next: Record<string, unknown> = { ...(r.patch ?? {}) };
    const liveText = r.published_at ? (r.published_patch ?? {}).text : undefined;
    const liveSegments = r.published_at ? (r.published_patch ?? {}).segments : undefined;
    if (typeof liveText === "string") next.text = liveText;
    else delete next.text;
    if (Array.isArray(liveSegments)) next.segments = liveSegments;
    else delete next.segments;
    const own = Object.keys(next).filter((k) => k !== "before" && k !== "text" && k !== "segments");
    return own.length > 0 ? next : null;
  };
  const results = await Promise.all(
    targets.map((r) => {
      const kept = keptStyle(r);
      if (kept) return tc.from("website_edits").update({ patch: kept, updated_at: now }).eq("id", r.id).eq("updated_at", r.updated_at).select("id");
      return r.published_at
        ?
          tc
            .from("website_edits")
            .update({
              patch: r.published_patch ?? {},
              removed: r.published_removed,
              updated_at: now,
            })
            .eq("id", r.id)
            .eq("updated_at", r.updated_at)
            .select("id")
        :
          tc.from("website_edits").delete().eq("id", r.id).eq("updated_at", r.updated_at).select("id");
    }),
  );
  const failed = results.find((x) => x.error);
  if (failed?.error) {
    res.status(500).json({ error: { code: "discard_failed", message: failed.error.message } });
    return;
  }
  if (results.some((result) => !Array.isArray(result.data) || result.data.length === 0)) {
    res.status(409).json({ error: { code: "edit_changed", message: "That change was edited somewhere else. Reload and try again." } });
    return;
  }
  res.status(200).json({ discarded: targets.length });
}

export async function getPublishedWebsiteEditsHandler(req: Request, res: Response): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=5");

  const app = typeof req.query.app === "string" ? req.query.app : "";
  if (!app) {
    res.status(400).json({ error: { code: "missing_app", message: "app is required" } });
    return;
  }
  const sc = publicHostClient(
    "public live-site read of already-published, non-PII page overrides, keyed by deploy host",
  );
  const want = app.trim().toLowerCase();
  if (!PUBLIC_HOST_RE.test(want)) {
    res.status(200).json({ edits: [], badge_hidden: true });
    return;
  }
  const [hostRes, domainRes, customRes] = await Promise.all([
    sc
      .from("tenant_resources")
      .select("tenant_id, status, external_ref")
      .eq("resource_kind", "hosting")
      .eq("status", "ready")
      .ilike("external_ref->>url", `%${want}%`),
    sc
      .from("tenant_resources")
      .select("tenant_id, status, external_ref")
      .eq("resource_kind", "domain")
      .eq("status", "ready")
      .ilike("external_ref->>hostname", `%${want}%`),
    sc.from("tenant_custom_domains").select("tenant_id, hostname, status").eq("status", "verified").ilike("hostname", want),
  ]);
  if (hostRes.error) {
    res.status(500).json({ error: { code: "read_failed", message: hostRes.error.message } });
    return;
  }
  const claimants = new Set<string>();
  const claim = (tenant_id: unknown, hosts: string[]) => {
    if (typeof tenant_id === "string" && hosts.includes(want)) claimants.add(tenant_id);
  };
  for (const r of (hostRes.data ?? []) as Array<HostingRow & { tenant_id: string }>) {
    claim(r.tenant_id, servingHosts([r], [], []));
  }
  for (const r of (domainRes.data ?? []) as Array<DomainRow & { tenant_id: string }>) {
    claim(r.tenant_id, servingHosts([], [r], []));
  }
  for (const r of (customRes.data ?? []) as Array<CustomDomainRow & { tenant_id: string }>) {
    claim(r.tenant_id, servingHosts([], [], [r]));
  }
  if (claimants.size !== 1) {
    res.status(200).json({ edits: [], badge_hidden: true });
    return;
  }
  const [ownerTenantId] = [...claimants];
  const [ownHost, ownDomain, ownCustom] = await Promise.all([
    sc.from("tenant_resources").select("status, external_ref").eq("tenant_id", ownerTenantId).eq("resource_kind", "hosting"),
    sc.from("tenant_resources").select("status, external_ref").eq("tenant_id", ownerTenantId).eq("resource_kind", "domain"),
    sc.from("tenant_custom_domains").select("hostname, status").eq("tenant_id", ownerTenantId),
  ]);
  if (ownHost.error) {
    res.status(500).json({ error: { code: "read_failed", message: ownHost.error.message } });
    return;
  }
  const ownerHostSet = new Set(
    servingHosts(
      (ownHost.data ?? []) as HostingRow[],
      (ownDomain.data ?? []) as DomainRow[],
      (ownCustom.data ?? []) as CustomDomainRow[],
    ),
  );
  ownerHostSet.add(want);
  const { data, error } = await sc
    .from("website_edits")
    .select("selector, published_patch, published_removed, published_at, app_id")
    .in("app_id", [...ownerHostSet])
    .eq("tenant_id", ownerTenantId)
    .not("published_at", "is", null)
    .order("published_at", { ascending: false })
    .order("app_id", { ascending: true });
  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  const seenSelectors = new Set<string>();
  const edits = ((data ?? []) as Array<{
    selector: string;
    published_patch: unknown;
    published_removed: boolean;
  }>)
    .filter((r) => (seenSelectors.has(r.selector) ? false : (seenSelectors.add(r.selector), true)))
    .map((r) => ({
      selector: r.selector,
      patch: r.published_patch ?? {},
      removed: r.published_removed,
    }));
  let badge_hidden = true;
  try {
    const gateOn = await getBoolSetting("platform_badge_global_enabled");
    if (gateOn) {
      badge_hidden = await getBoolSettingStrict("website_platform_badge_hidden", ownerTenantId);
    }
  } catch {
    badge_hidden = true;
  }
  let badge_reserve = false;
  if (!badge_hidden) {
    try {
      badge_reserve = (await getBoolSetting("site_badge_reserves_space", ownerTenantId)) === true;
    } catch {
      badge_reserve = false;
    }
  }
  res.status(200).json({ edits, badge_hidden, ...(badge_reserve ? { badge_reserve: true } : {}) });
}
