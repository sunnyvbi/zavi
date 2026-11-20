import type { Request, Response } from "express";
import { z } from "zod";
import { companyProfileInputSchema } from "@zavi/shared";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { assertSafeUrl } from "@/services/onboarding/enrichment/url-guard";
import { ensureAgentRunnable } from "@/services/agents/ensure-runnable";
import { enqueueAgentRun } from "@/services/agents/runner";
import { writeStaffAudit } from "@/services/staff/audit";
import {
  projectCompanyFact,
  normalizeIfUrl,
  type ProjectableFactKey,
} from "@/services/company-facts/write";
import {
  COMPANY_PROFILE_RESEARCH_SOURCE,
  companyResearchPrompt,
  extractCompanyResearch,
  normalizeCompanyWebsite,
} from "@/services/company-profiles/research";

const REASON = "admin company profile research and reviewed publish for one tenant";
const StartBody = z.object({
  website: z.string().trim().min(1).max(2048),
  request_id: z.string().uuid(),
});
const PublishBody = z.object({
  run_id: z.string().uuid(),
  request_id: z.string().uuid(),
  profile: companyProfileInputSchema,
});

type ResearchRunRow = {
  id: string;
  status: string;
  parse_ok: boolean | null;
  parsed: unknown;
  error: string | null;
  payload: unknown;
};

function sb() {
  return staffCrossTenantClient(REASON);
}

function payloadOf(row: Pick<ResearchRunRow, "payload">): Record<string, unknown> {
  return row.payload && typeof row.payload === "object"
    ? (row.payload as Record<string, unknown>)
    : {};
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { code: "invalid_request", message } });
}

async function readOwnedResearchRun(tenant_id: string, run_id: string): Promise<ResearchRunRow | null> {
  const { data, error } = await sb()
    .from("agent_runs")
    .select("id, status, parse_ok, parsed, error, payload")
    .eq("tenant_id", tenant_id)
    .eq("id", run_id)
    .eq("agent_slug", "research")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as ResearchRunRow | null;
  return row && payloadOf(row).source === COMPANY_PROFILE_RESEARCH_SOURCE ? row : null;
}

async function companyName(tenant_id: string): Promise<string> {
  const { data, error } = await sb()
    .from("tenants")
    .select("display_name")
    .eq("id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("tenant not found");
  return String(data.display_name ?? "");
}

export async function staffCompanyResearchStart(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const parsed = StartBody.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message ?? "invalid body");

  let normalized: ReturnType<typeof normalizeCompanyWebsite>;
  try {
    normalized = normalizeCompanyWebsite(parsed.data.website);
    await assertSafeUrl(normalized.website);
  } catch (error) {
    return badRequest(res, error instanceof Error ? error.message : "website is not safe to fetch");
  }

  try {
    const [name, runnable] = await Promise.all([
      companyName(tenant_id),
      ensureAgentRunnable(tenant_id, "research"),
    ]);
    if (!runnable.runnable) {
      res.status(403).json({ error: { code: runnable.reason, message: runnable.detail } });
      return;
    }
    const dedupeKey = `company-profile:${tenant_id}:${parsed.data.request_id}`;
    const enqueued = await enqueueAgentRun({
      tenant_id,
      agent_slug: "research",
      trigger: "a2a",
      cron_dedupe_key: dedupeKey,
      payload: {
        source: COMPANY_PROFILE_RESEARCH_SOURCE,
        origin: "staff_console",
        website: normalized.website,
        request_id: parsed.data.request_id,
        task_description: companyResearchPrompt(normalized.website, name),
      },
    });
    let run_id = enqueued.run_id;
    if (!run_id) {
      const existing = await sb()
        .from("agent_runs")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("cron_dedupe_key", dedupeKey)
        .maybeSingle();
      if (existing.error || !existing.data?.id) {
        throw new Error(existing.error?.message ?? "existing research run could not be found");
      }
      run_id = existing.data.id;
    }
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "company_profile_research_started",
      target_table: "agent_runs",
      target_id: run_id,
      tenant_id,
      meta: { domain: normalized.domain, request_id: parsed.data.request_id },
    });
    res.status(202).json({
      run_id,
      request_id: parsed.data.request_id,
      website: normalized.website,
      status: "researching",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "research could not be started";
    res.status(/tenant not found/i.test(message) ? 404 : 503).json({
      error: { code: "research_start_failed", message },
    });
  }
}

export async function staffCompanyResearchStatus(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  if (!z.string().uuid().safeParse(req.params.run_id).success) {
    badRequest(res, "run_id must be a UUID");
    return;
  }
  try {
    const row = await readOwnedResearchRun(req.params.tenant_id, req.params.run_id);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "research run not found" } });
      return;
    }
    const payload = payloadOf(row);
    const request_id = typeof payload.request_id === "string" ? payload.request_id : "";
    const website = typeof payload.website === "string" ? payload.website : "";
    if (["queued", "dispatched", "running"].includes(row.status)) {
      res.json({ status: "researching", run_id: row.id, request_id, website });
      return;
    }
    if (row.status !== "success" || row.parse_ok !== true) {
      res.json({
        status: "failed",
        run_id: row.id,
        request_id,
        website,
        error: row.error || "Research did not complete successfully.",
      });
      return;
    }
    const profile = extractCompanyResearch(row.parsed, website);
    if (!profile) {
      res.json({
        status: "failed",
        run_id: row.id,
        request_id,
        website,
        error: "Research completed without usable company fields. Retry the research.",
      });
      return;
    }
    res.json({ status: "complete", run_id: row.id, request_id, website, profile });
  } catch (error) {
    res.status(500).json({
      error: { code: "research_status_failed", message: (error as Error).message },
    });
  }
}

export async function staffCompanyProfilePublish(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const parsed = PublishBody.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message ?? "invalid body");

  let normalized: ReturnType<typeof normalizeCompanyWebsite>;
  try {
    normalized = normalizeCompanyWebsite(parsed.data.profile.website);
    await assertSafeUrl(normalized.website);
  } catch (error) {
    return badRequest(res, error instanceof Error ? error.message : "website is not safe to fetch");
  }

  try {
    const run = await readOwnedResearchRun(tenant_id, parsed.data.run_id);
    if (!run || run.status !== "success" || run.parse_ok !== true) {
      res.status(409).json({
        error: { code: "research_not_complete", message: "Complete company research before saving." },
      });
      return;
    }
    const payload = payloadOf(run);
    const researchedWebsite = typeof payload.website === "string" ? payload.website : "";
    if (payload.request_id !== parsed.data.request_id || researchedWebsite !== normalized.website) {
      res.status(409).json({
        error: { code: "stale_research", message: "The website changed. Research this URL before saving." },
      });
      return;
    }
    const generated = extractCompanyResearch(run.parsed, researchedWebsite);
    if (!generated) {
      res.status(409).json({
        error: { code: "research_incomplete", message: "Research did not produce a usable profile." },
      });
      return;
    }

    const profile = parsed.data.profile;
    const { data, error } = await sb()
      .from("company_profiles")
      .upsert(
        {
          tenant_id,
          domain: normalized.domain,
          website: normalized.website,
          industry: profile.industry,
          category: profile.category,
          founded: profile.founded,
          location: profile.location,
          social_profiles: profile.social_profiles,
          source_urls: generated.source_urls,
          source_run_id: run.id,
          published_by: staff.user_id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id" },
      )
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const projectRef = `company profile published by ${staff.email} (run ${run.id})`;
    const projected: { written: string[]; attempted: string[]; refused: string[]; errors: string[] } = {
      written: [], attempted: [], refused: [], errors: [],
    };

    const { error: domErr } = await sb().rpc("set_tenant_company_domain_system", {
      p_tenant_id: tenant_id,
      p_url: normalizeIfUrl("domain", normalized.website),
      p_source: "staff_reviewed",
      p_source_ref: projectRef,
    });
    if (domErr) projected.errors.push(`domain: ${domErr.message}`);
    else projected.attempted.push("domain");

    const projections: Array<[ProjectableFactKey, string | null | undefined]> = [
      ["what_we_sell", profile.category],
      ["industry", profile.industry],
      ["location", profile.location],
      ["founded", profile.founded],
    ];
    for (const [key, value] of projections) {
      if (!value || !String(value).trim()) continue;
      const r = await projectCompanyFact(
        sb(), tenant_id, key, String(value), "staff_reviewed", projectRef,
        { deferRender: true },
      );
      if (r.error) projected.errors.push(`${key}: ${r.error}`);
      else if (r.written) projected.written.push(key);
      else projected.refused.push(key);
    }

    const socialKey: Record<string, ProjectableFactKey> = {
      linkedin: "linkedin_url",
      instagram: "instagram_url",
      facebook: "facebook_url",
      x: "x_url",
      twitter: "x_url",
    };
    for (const social of profile.social_profiles ?? []) {
      const key = socialKey[String(social?.platform ?? "").toLowerCase()];
      const url = typeof social?.url === "string" ? social.url.trim() : "";
      if (!key || !url) continue;
      const r = await projectCompanyFact(
        sb(), tenant_id, key, url, "staff_reviewed", projectRef,
        { deferRender: true },
      );
      if (r.error) projected.errors.push(`${key}: ${r.error}`);
      else if (r.written) projected.written.push(key);
      else projected.refused.push(key);
    }

    try {
      const { regenerateCompanyBrief } = await import("@/services/company/brief");
      await regenerateCompanyBrief(tenant_id);
    } catch (e) {
      console.warn(
        `[admin/company-profiles] brief not re-rendered for ${tenant_id}: ${(e as Error).message}`,
      );
    }

    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "company_profile_published",
      target_table: "company_profiles",
      target_id: data.id,
      tenant_id,
      meta: { domain: normalized.domain, source_run_id: run.id, projected },
    });
    res.json({ id: data.id, profile: { ...profile, website: normalized.website }, projected });
  } catch (error) {
    res.status(500).json({
      error: { code: "company_publish_failed", message: (error as Error).message },
    });
  }
}
