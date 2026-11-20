
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { assertSafeUrl } from "@/services/onboarding/enrichment/url-guard";

function bearerToken(req: Request): string {
  const h = (req.headers.authorization as string | undefined) ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : h;
}

function failsSqlUrlRules(url: string): string | null {
  if (!/^https:\/\//.test(url)) return "must be an https:// URL";
  if (url.length > 2048) return "URL too long (max 2048)";
  if (url.length > 500) return "URL too long to store as a company fact (max 500)";
  if (isLiteralPrivateHost(url)) return "resolves to a private/loopback host";
  return null;
}

function isLiteralPrivateHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe[89ab][0-9a-f]:/.test(host)
  );
}

function normalizeUrl(
  raw: unknown,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "string") {
    return { ok: false, reason: "must be a string" };
  }
  const v = raw.trim();
  if (v.length === 0) return { ok: true, value: undefined };
  if (v.length > 2048) return { ok: false, reason: "URL too long (max 2048)" };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "https:") {
    return { ok: false, reason: "must be an https:// URL" };
  }
  return { ok: true, value: u.toString() };
}

const CANON_MAX_REDIRECTS = 3;
const CANON_TIMEOUT_MS = 5_000;

export async function canonicalizeUrl(
  input: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ url: string; changed: boolean }> {
  let url = input;
  try {
    for (let hop = 0; hop < CANON_MAX_REDIRECTS; hop++) {
      await assertSafeUrl(url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CANON_TIMEOUT_MS);
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetchFn(url, {
          method: "GET",
          redirect: "manual",
          signal: ctrl.signal,
          headers: { "user-agent": "praxis-web-fetch/1.0" },
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get("location");
      if (!loc) break;
      url = new URL(loc, url).toString();
    }
  } catch {
    return { url: input, changed: false };
  }
  return { url, changed: url !== input };
}

export async function getProductUrlHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sb = serverClientFromBearer(bearerToken(req));
  const { data, error } = await sb
    .from("tenants")
    .select("product_url")
    .eq("id", auth.tenant_id)
    .maybeSingle();

  if (error) {
    res.status(500).json({
      error: { code: "read_failed", message: error.message },
    });
    return;
  }

  const raw = (data?.product_url ?? {}) as Record<string, unknown>;
  const product_url: Record<string, string> = {};
  if (typeof raw.marketing === "string" && raw.marketing) {
    product_url.marketing = raw.marketing;
  }
  if (typeof raw.api === "string" && raw.api) product_url.api = raw.api;

  res.status(200).json({ product_url });
}

export async function setProductUrlHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as { marketing?: unknown; api?: unknown };
  const mk = normalizeUrl(body.marketing);
  if (!mk.ok) {
    res.status(400).json({
      error: { code: "invalid_marketing_url", message: `marketing: ${mk.reason}` },
    });
    return;
  }
  const api = normalizeUrl(body.api);
  if (!api.ok) {
    res.status(400).json({
      error: { code: "invalid_api_url", message: `api: ${api.reason}` },
    });
    return;
  }

  const product_url: Record<string, string> = {};
  const canonicalized: string[] = [];
  if (mk.value !== undefined) {
    const c = await canonicalizeUrl(mk.value);
    product_url.marketing = c.url;
    if (c.changed) canonicalized.push(`marketing → ${c.url}`);
  }
  if (api.value !== undefined) {
    const c = await canonicalizeUrl(api.value);
    product_url.api = c.url;
    if (c.changed) canonicalized.push(`api → ${c.url}`);
  }

  const sb = serverClientFromBearer(bearerToken(req));

  for (const [key, candidate] of [
    ["marketing", product_url.marketing],
    ["api", product_url.api],
  ] as const) {
    if (candidate === undefined) continue;
    const why = failsSqlUrlRules(candidate);
    if (why) {
      res.status(422).json({
        error: { code: "invalid_product_url", message: `${key} ${why}` },
      });
      return;
    }
  }

  let error: { code?: string; message: string } | null = null;

  if (product_url.marketing !== undefined) {
    const r = await sb.rpc("set_tenant_company_domain", {
      p_tenant_id: auth.tenant_id,
      p_url: product_url.marketing,
      p_source_ref: "registered via the product URL settings",
    });
    error = r.error;
  }

  if (!error && api.value !== undefined) {
    const r = await sb.rpc("set_tenant_api_origin", {
      p_tenant_id: auth.tenant_id,
      p_url: product_url.api,
    });
    error = r.error;
  }

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") {
      res.status(403).json({
        error: { code: "not_admin", message: error.message },
      });
      return;
    }
    if (code === "22023") {
      res.status(422).json({
        error: { code: "invalid_product_url", message: error.message },
      });
      return;
    }
    res.status(500).json({
      error: { code: "rpc_failed", message: error.message },
    });
    return;
  }

  res.status(200).json({
    ok: true,
    product_url,
    ...(canonicalized.length > 0 ? { canonicalized } : {}),
  });
}

export async function clearProductUrlHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sb = serverClientFromBearer(bearerToken(req));

  const domainClear = await sb.rpc("set_tenant_company_domain", {
    p_tenant_id: auth.tenant_id,
    p_url: null,
    p_source_ref: "cleared via the product URL settings",
  });

  const { error } = domainClear.error
    ? domainClear
    : await sb.rpc("set_tenant_product_url", {
        p_tenant_id: auth.tenant_id,
        p_product_url: {},
      });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") {
      res.status(403).json({
        error: { code: "not_admin", message: error.message },
      });
      return;
    }
    res.status(500).json({
      error: { code: "rpc_failed", message: error.message },
    });
    return;
  }

  res.status(200).json({ ok: true, product_url: {} });
}
