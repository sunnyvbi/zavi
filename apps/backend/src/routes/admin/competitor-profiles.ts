import type { Request, Response } from "express";
import { z } from "zod";
import { competitorProfileInputSchema } from "@zavi/shared";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { assertSafeUrl } from "@/services/onboarding/enrichment/url-guard";
import { ensureAgentRunnable } from "@/services/agents/ensure-runnable";
import { enqueueAgentRun } from "@/services/agents/runner";
import { writeStaffAudit } from "@/services/staff/audit";
import { getSetting, setTenantSetting } from "@/services/settings";
import { getCompanyFacts, joinCompetitors, projectCompanyFactValue } from "@/services/company/facts";
import { validateCustomBrands } from "@/services/competitor-intel/brands";
import {
  COMPETITOR_PROFILE_RESEARCH_SOURCE,
  competitorResearchPrompt,
  extractCompetitorResearch,
  normalizeCompetitorWebsite,
} from "@/services/competitor-profiles/research";

const REASON = "admin competitor profile research and reviewed publish for one tenant";
const StartBody = z.object({
  website: z.string().trim().min(1).max(2048),
  request_id: z.string().uuid(),
});
const PublishBody = z.object({
  run_id: z.string().uuid(),
  request_id: z.string().uuid(),
  profile: competitorProfileInputSchema,
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
  return row && payloadOf(row).source === COMPETITOR_PROFILE_RESEARCH_SOURCE ? row : null;
}

async function subjectContext(tenant_id: string): Promise<{
  subjectName: string;
  subjectCategory: string;
  subjectAudience: string;
}> {
  const client = sb();
  const [tenant, facts] = await Promise.all([
    client.from("tenants").select("display_name").eq("id", tenant_id).maybeSingle(),
    client
      .from("tenant_fact")
      .select("key, value_text")
      .eq("tenant_id", tenant_id)
      .in("key", ["what_we_sell", "who_we_serve"]),
  ]);
  if (tenant.error) throw new Error(tenant.error.message);
  if (!tenant.data) throw new Error("tenant not found");
  if (facts.error) throw new Error(facts.error.message);
  const byKey = new Map(
    (facts.data ?? []).map((row) => [String(row.key), String(row.value_text ?? "")]),
  );
  return {
    subjectName: String(tenant.data.display_name ?? ""),
    subjectCategory: byKey.get("what_we_sell") ?? "",
    subjectAudience: byKey.get("who_we_serve") ?? "",
  };
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { code: "invalid_request", message } });
}

async function syncReviewedBrandToWeeklyScan(
  tenant_id: string,
  companyName: string,
  actorUserId: string,
): Promise<void> {
  const record = await getCompanyFacts(tenant_id);
  const brands = record.competitors;
  if (brands.some((brand) => brand.toLowerCase() === companyName.toLowerCase())) return;
  const next = validateCustomBrands([...brands, companyName]);
  if (!next.ok) return;
  await projectCompanyFactValue(
    tenant_id,
    "competitors",
    joinCompetitors(next.brands),
    "staff_reviewed",
    `reviewed competitor profile, staff ${actorUserId}`,
  );
}

export async function staffCompetitorResearchStart(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const parsed = StartBody.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message ?? "invalid body");

  let normalized: ReturnType<typeof normalizeCompetitorWebsite>;
  try {
    normalized = normalizeCompetitorWebsite(parsed.data.website);
    await assertSafeUrl(normalized.website);
  } catch (error) {
    return badRequest(res, error instanceof Error ? error.message : "website is not safe to fetch");
  }

  try {
    const [context, runnable] = await Promise.all([
      subjectContext(tenant_id),
      ensureAgentRunnable(tenant_id, "research"),
    ]);
    if (!runnable.runnable) {
      res.status(403).json({ error: { code: runnable.reason, message: runnable.detail } });
      return;
    }
    const dedupeKey = `competitor-profile:${tenant_id}:${parsed.data.request_id}`;
    const enqueued = await enqueueAgentRun({
      tenant_id,
      agent_slug: "research",
      trigger: "a2a",
      cron_dedupe_key: dedupeKey,
      payload: {
        source: COMPETITOR_PROFILE_RESEARCH_SOURCE,
        origin: "staff_console",
        website: normalized.website,
        request_id: parsed.data.request_id,
        task_description: competitorResearchPrompt({ website: normalized.website, ...context }),
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
      action: "competitor_profile_research_started",
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

export async function staffCompetitorResearchStatus(req: Request, res: Response): Promise<void> {
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
    const profile = extractCompetitorResearch(row.parsed, website);
    if (!profile) {
      res.json({
        status: "failed",
        run_id: row.id,
        request_id,
        website,
        error: "Research completed without all required profile fields. Retry the research.",
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

export async function staffCompetitorProfilePublish(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const parsed = PublishBody.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message ?? "invalid body");

  let normalized: ReturnType<typeof normalizeCompetitorWebsite>;
  try {
    normalized = normalizeCompetitorWebsite(parsed.data.profile.website);
    await assertSafeUrl(normalized.website);
  } catch (error) {
    return badRequest(res, error instanceof Error ? error.message : "website is not safe to fetch");
  }

  try {
    const run = await readOwnedResearchRun(tenant_id, parsed.data.run_id);
    if (!run || run.status !== "success" || run.parse_ok !== true) {
      res.status(409).json({
        error: { code: "research_not_complete", message: "Complete competitor research before publishing." },
      });
      return;
    }
    const payload = payloadOf(run);
    const researchedWebsite = typeof payload.website === "string" ? payload.website : "";
    if (payload.request_id !== parsed.data.request_id || researchedWebsite !== normalized.website) {
      res.status(409).json({
        error: { code: "stale_research", message: "The website changed. Research this URL before publishing." },
      });
      return;
    }
    const generated = extractCompetitorResearch(run.parsed, researchedWebsite);
    if (!generated) {
      res.status(409).json({
        error: { code: "research_incomplete", message: "Research did not produce a complete profile." },
      });
      return;
    }

    const profile = parsed.data.profile;
    const { data, error } = await sb()
      .from("competitor_profiles")
      .upsert(
        {
          tenant_id,
          domain: normalized.domain,
          website: normalized.website,
          company_name: profile.company_name,
          industry: profile.industry,
          positioning: profile.positioning,
          target_audience: profile.target_audience,
          pricing: profile.pricing,
          acquisition_channels: profile.acquisition_channels,
          threat_level: profile.threat_level,
          source_urls: generated.source_urls,
          source_run_id: run.id,
          published_by: staff.user_id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,domain" },
      )
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    await syncReviewedBrandToWeeklyScan(tenant_id, profile.company_name, staff.user_id).catch(
      (syncError) => console.warn(
        `[competitor-profile] weekly tracking sync failed tenant=${tenant_id}: ${(syncError as Error).message}`,
      ),
    );

    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "competitor_profile_published",
      target_table: "competitor_profiles",
      target_id: data.id,
      tenant_id,
      meta: { domain: normalized.domain, source_run_id: run.id },
    });
    res.json({ id: data.id, profile: { ...profile, website: normalized.website } });
  } catch (error) {
    res.status(500).json({
      error: { code: "competitor_publish_failed", message: (error as Error).message },
    });
  }
}
