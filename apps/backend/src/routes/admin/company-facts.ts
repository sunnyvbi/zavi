
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { type TenantFactKey } from "@/services/agents/company-fact-sheet";
import {
  FACT_KEYS,
  CompanyFactsBody as SetBody,
  normalizeForKey,
} from "@/services/company-facts/write";
import { computeReadiness } from "@/services/readiness/compute";
import { logEvent } from "@/services/logging/logEvent";

export async function staffCompanyFactsGet(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenant_id = String(req.params.tenant_id ?? "");
  if (!tenant_id) {
    res.status(400).json({ error: { code: "missing_tenant", message: "tenant id required" } });
    return;
  }

  const sb = staffCrossTenantClient("admin console: read a tenant's company facts to edit them");
  const { data, error } = await sb
    .from("tenant_fact")
    .select("key, value_text, source, source_ref, verified_at")
    .eq("tenant_id", tenant_id);

  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  res.json({ tenant_id, keys: FACT_KEYS, facts: data ?? [] });
}

export async function staffCompanyFactsSet(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenant_id = String(req.params.tenant_id ?? "");
  if (!tenant_id) {
    res.status(400).json({ error: { code: "missing_tenant", message: "tenant id required" } });
    return;
  }

  const parsed = SetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }

  const sb = staffCrossTenantClient("admin console: a human is confirming a tenant's company facts");
  const ref = `set in admin console by ${staff.email}`;

  const written: string[] = [];
  const cleared: string[] = [];
  const rejected: Array<{ key: string; dropped: string[] }> = [];

  try {
    for (const f of parsed.data.facts) {
      const norm = normalizeForKey(f.key, f.value);
      const value = norm.value;
      if (norm.rejected.length > 0) rejected.push({ key: f.key, dropped: norm.rejected });

      if (f.key === "domain") {
        const { error: domErr } = await sb.rpc("set_tenant_company_domain_system", {
          p_tenant_id: tenant_id,
          p_url: value || null,
          p_source: "human_confirmed",
          p_source_ref: ref,
        });
        if (domErr) {
          const code = (domErr as { code?: string }).code;
          res.status(code === "22023" ? 422 : 500).json({
            error: {
              code: code === "22023" ? "invalid_domain" : "write_failed",
              message: `domain: ${domErr.message}`,
            },
          });
          return;
        }
        if (value) written.push(f.key);
        else cleared.push(f.key);
        continue;
      }

      if (!value) {
        const { error } = await sb.from("tenant_fact").delete().eq("tenant_id", tenant_id).eq("key", f.key);
        if (error) {
          res.status(500).json({ error: { code: "clear_failed", message: `${f.key}: ${error.message}` } });
          return;
        }
        cleared.push(f.key);
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
        res.status(500).json({ error: { code: "write_failed", message: `${f.key}: ${error.message}` } });
        return;
      }
      written.push(f.key);
    }
  } finally {
    if (written.length > 0 || cleared.length > 0) {
      try {
        const { regenerateCompanyBrief } = await import("@/services/company/brief");
        await regenerateCompanyBrief(tenant_id);
      } catch (e) {
        await logEvent({
          level: "warn",
          source: "admin.company-facts",
          code: "company_brief.render_failed",
          error: e,
          tenant_id,
        });
      }
    }
  }

  if (written.includes("domain") || cleared.includes("domain")) {
    try {
      await computeReadiness(tenant_id);
    } catch (e) {
      await logEvent({
        level: "warn",
        source: "admin.company-facts",
        code: "readiness.recompute_failed",
        error: e,
        tenant_id,
      });
    }
  }

  res.json({ ok: true, tenant_id, written, cleared, rejected });
}
