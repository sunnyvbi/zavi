
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { computeReadiness } from "@/services/readiness/compute";
import { logEvent } from "@/services/logging/logEvent";
import {
  CompanyFactsBody,
  FACT_KEYS,
  normalizeForKey,
} from "@/services/company-facts/write";
import { canonicalizeUrl } from "./tenant-product-url";
import { companySuggestions } from "@/services/company/suggestions";
import { competitorsFromIdea } from "@/services/company/idea-competitors";
import {
  dismissDescriptionDraft,
  dismissDraft,
  getOrCreateDescriptionDraft,
  getOrCreateDraft,
} from "@/services/company/description-draft";
import {
  assertSafeUrl,
  SsrfBlockedError,
} from "@/services/onboarding/enrichment/url-guard";

function bearerToken(req: Request): string {
  const h = (req.headers.authorization as string | undefined) ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : h;
}

async function callerIsTenantAdmin(
  bearer: string,
  user_id: string,
  tenant_id: string,
): Promise<boolean> {
  const sb = serverClientFromBearer(bearer);
  const { data, error } = await sb
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenant_id)
    .eq("user_id", user_id)
    .maybeSingle();
  if (error || !data) return false;
  const role = (data as { role?: unknown }).role;
  return role === "owner" || role === "admin";
}

export async function getCompanyFactsHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sb = serverClientFromBearer(bearerToken(req));
  const { data, error } = await sb
    .from("tenant_fact")
    .select("key, value_text, source, source_ref, verified_at")
    .eq("tenant_id", auth.tenant_id);

  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  res.status(200).json({ keys: FACT_KEYS, facts: data ?? [] });
}

export async function setCompanyFactsHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const isAdmin = await callerIsTenantAdmin(
    bearerToken(req),
    auth.user_id,
    auth.tenant_id,
  );
  if (!isAdmin) {
    res.status(403).json({
      error: {
        code: "not_admin",
        message: "Only a workspace owner or admin can change company facts.",
      },
    });
    return;
  }

  const parsed = CompanyFactsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }

  const tenant_id = auth.tenant_id;
  const sb = serviceClient();
  const ref = `set in workspace settings by user ${auth.user_id}`;

  const written: string[] = [];
  const cleared: string[] = [];
  const rejected: Array<{ key: string; dropped: string[] }> = [];
  const canonicalized: string[] = [];

  for (const f of parsed.data.facts) {
    const norm = normalizeForKey(f.key, f.value);
    let value = norm.value;
    if (norm.rejected.length > 0) rejected.push({ key: f.key, dropped: norm.rejected });

    if (f.key === "domain" && !value) {
      const { error: domErr } = await sb.rpc("set_tenant_company_domain_system", {
        p_tenant_id: tenant_id,
        p_url: null,
        p_source: "human_confirmed",
        p_source_ref: ref,
      });
      if (domErr) {
        res.status(500).json({
          error: { code: "clear_failed", message: `domain: ${domErr.message}` },
        });
        return;
      }
      cleared.push(f.key);
      continue;
    }

    if (!value) {
      const { error } = await sb
        .from("tenant_fact")
        .delete()
        .eq("tenant_id", tenant_id)
        .eq("key", f.key);
      if (error) {
        res
          .status(500)
          .json({ error: { code: "clear_failed", message: `${f.key}: ${error.message}` } });
        return;
      }
      cleared.push(f.key);
      continue;
    }

    if (f.key === "domain") {
      try {
        await assertSafeUrl(value);
      } catch (e) {
        if (e instanceof SsrfBlockedError && e.code === "ssrf_blocked") {
          res.status(400).json({
            error: {
              code: "unsafe_domain",
              message:
                "That website address resolves to a private network address, so agents could never reach it. Use your public site URL.",
            },
          });
          return;
        }
      }

      const c = await canonicalizeUrl(value);
      if (c.changed) {
        value = c.url;
        canonicalized.push(`domain → ${c.url}`);
      }
    }

    if (f.key === "domain") {
      const { error: domErr } = await sb.rpc("set_tenant_company_domain_system", {
        p_tenant_id: tenant_id,
        p_url: value,
        p_source: "human_confirmed",
        p_source_ref: ref,
      });
      if (domErr) {
        const code = (domErr as { code?: string }).code;
        res.status(code === "22023" ? 400 : 500).json({
          error: {
            code: code === "22023" ? "unsafe_domain" : "write_failed",
            message: `domain: ${domErr.message}`,
          },
        });
        return;
      }
      written.push(f.key);
      continue;
    }

    const { error } = await sb.rpc("set_tenant_fact", {
      p_tenant_id: tenant_id,
      p_key: f.key,
      p_value_text: value,
      p_source: "human_confirmed",
      p_source_ref: ref,
    });
    if (error) {
      res
        .status(500)
        .json({ error: { code: "write_failed", message: `${f.key}: ${error.message}` } });
      return;
    }
    written.push(f.key);
  }

  if (written.length > 0 || cleared.length > 0) {
    try {
      const { regenerateCompanyBrief } = await import("@/services/company/brief");
      await regenerateCompanyBrief(tenant_id);
    } catch (e) {
      await logEvent({
        level: "warn",
        source: "connectors.company-facts",
        code: "company_brief.render_failed",
        error: e,
        tenant_id,
      });
    }
  }

  if (written.includes("domain") || cleared.includes("domain")) {
    try {
      await computeReadiness(tenant_id);
    } catch (e) {
      await logEvent({
        level: "warn",
        source: "connectors.company-facts",
        code: "readiness.recompute_failed",
        error: e,
        tenant_id,
      });
    }
  }

  res.status(200).json({
    ok: true,
    written,
    cleared,
    ...(rejected.length > 0 ? { rejected } : {}),
    ...(canonicalized.length > 0 ? { canonicalized } : {}),
  });
}

export async function getCompanyFactSuggestionsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const sb = serverClientFromBearer(bearerToken(req));
    const { data, error } = await sb
      .from("tenant_fact")
      .select("key, value_text")
      .eq("tenant_id", auth.tenant_id);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ key: string; value_text: string | null }>;

    const stated = new Set(
      ((data ?? []) as Array<{ key: string; value_text: string | null }>)
        .filter((r) => (r.value_text ?? "").trim())
        .map((r) => r.key),
    );
    const missing = new Set(
      ["what_we_sell", "company_story", "country"].filter((k) => !stated.has(k)),
    );
    const said = (k: string) => rows.find((r) => r.key === k)?.value_text ?? null;

    res.status(200).json({
      suggestions: await companySuggestions(auth.tenant_id, missing, { location: said("location"), markets: said("markets") }),
    });
  } catch (e) {
    res.status(200).json({ suggestions: {}, warning: (e as Error).message });
  }
}

export async function companyDescriptionDraftHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await callerIsTenantAdmin(bearerToken(req), auth.user_id, auth.tenant_id))) {
    res.status(200).json({ draft: null });
    return;
  }
  const draft = await getOrCreateDescriptionDraft(auth.tenant_id).catch((e: unknown) => {
    void logEvent({ level: "warn", source: "company-description-draft", code: "company_description_draft.route_failed", error: e, tenant_id: auth.tenant_id });
    return null;
  });
  res.status(200).json({
    draft: draft?.status === "ready" ? { value: draft.value, from: draft.from } : null,
    status: draft?.status ?? null,
  });
}

const COMPETITOR_WAIT_MS = 40_000;

export async function companyCompetitorSuggestionsHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await callerIsTenantAdmin(bearerToken(req), auth.user_id, auth.tenant_id))) {
    res.status(200).json({ competitors: [], pending: false });
    return;
  }
  const job = competitorsFromIdea(auth.tenant_id);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), COMPETITOR_WAIT_MS);
  });
  try {
    const names = await Promise.race([job, timeout]);
    res.status(200).json({ competitors: names ?? [], pending: names === null });
  } catch (e) {
    void logEvent({ level: "warn", source: "company-competitor-suggestions", code: "company_competitor_suggestions.failed", error: e, tenant_id: auth.tenant_id });
    res.status(200).json({ competitors: [], pending: false });
  } finally {
    clearTimeout(timer);
  }
}

export async function dismissCompanyDescriptionDraftHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await callerIsTenantAdmin(bearerToken(req), auth.user_id, auth.tenant_id))) {
    res.status(403).json({ error: { code: "not_admin", message: "Only a workspace owner or admin can do that." } });
    return;
  }
  try {
    await dismissDescriptionDraft(auth.tenant_id);
  } catch (e) {
    void logEvent({ level: "warn", source: "company-description-draft", code: "company_description_draft.dismiss_failed", error: e, tenant_id: auth.tenant_id });
    res.status(500).json({ error: { code: "dismiss_failed", message: "Could not dismiss that. Try again." } });
    return;
  }
  res.status(200).json({ ok: true });
}

export async function brandVoiceDraftHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await callerIsTenantAdmin(bearerToken(req), auth.user_id, auth.tenant_id))) {
    res.status(200).json({ draft: null });
    return;
  }
  const draft = await getOrCreateDraft(auth.tenant_id, "brand_voice").catch((e: unknown) => {
    void logEvent({ level: "warn", source: "company-description-draft", code: "brand_voice_draft.route_failed", error: e, tenant_id: auth.tenant_id });
    return null;
  });
  res.status(200).json({
    draft: draft?.status === "ready" ? { value: draft.value, from: draft.from } : null,
    status: draft?.status ?? null,
  });
}

export async function dismissBrandVoiceDraftHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await callerIsTenantAdmin(bearerToken(req), auth.user_id, auth.tenant_id))) {
    res.status(403).json({ error: { code: "not_admin", message: "Only a workspace owner or admin can do that." } });
    return;
  }
  try {
    await dismissDraft(auth.tenant_id, "brand_voice");
  } catch (e) {
    void logEvent({ level: "warn", source: "company-description-draft", code: "brand_voice_draft.dismiss_failed", error: e, tenant_id: auth.tenant_id });
    res.status(500).json({ error: { code: "dismiss_failed", message: "Could not dismiss that. Try again." } });
    return;
  }
  res.status(200).json({ ok: true });
}
