import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { ensureAgentRunnable } from "@/services/agents/ensure-runnable";
import { enqueueAgentRun } from "@/services/agents/runner";
import { writeStaffAudit } from "@/services/staff/audit";
import { invalidateClientContext } from "@/services/client-context";
import { projectCompanyFact } from "@/services/company-facts/write";
import {
  COMPANY_FIELDS_FILL_SOURCE,
  estimatedFieldSchema,
  extractCompanyFields,
  fillFieldKeySchema,
  fillFieldsPrompt,
} from "@/services/company-profiles/fill-fields";

const REASON = "admin company profile: AI-estimated field fill and staff-reviewed publish";

const StartBody = z.object({
  keys: z.array(fillFieldKeySchema).min(1).max(20),
  request_id: z.string().uuid(),
});

const PublishBody = z.object({
  run_id: z.string().uuid(),
  request_id: z.string().uuid(),
  fields: z.array(estimatedFieldSchema).min(1).max(20),
});

type RunRow = {
  id: string;
  status: string;
  output_text: string | null;
  error: string | null;
  payload: unknown;
};

function sb() {
  return staffCrossTenantClient(REASON);
}

function payloadOf(row: Pick<RunRow, "payload">): Record<string, unknown> {
  return row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {};
}

function requestedKeys(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.keys) ? payload.keys.filter((key): key is string => typeof key === "string") : [];
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { code: "invalid_request", message } });
}

async function readOwnedFillRun(tenant_id: string, run_id: string): Promise<RunRow | null> {
  const { data, error } = await sb()
    .from("agent_runs")
    .select("id, status, output_text, error, payload")
    .eq("tenant_id", tenant_id)
    .eq("id", run_id)
    .eq("agent_slug", "operator")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as RunRow | null;
  return row && payloadOf(row).source === COMPANY_FIELDS_FILL_SOURCE ? row : null;
}

async function companyName(tenant_id: string): Promise<string> {
  const { data, error } = await sb().from("tenants").select("display_name").eq("id", tenant_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("tenant not found");
  return String(data.display_name ?? "");
}

export async function staffCompanyFieldsFillStart(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const parsed = StartBody.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message ?? "invalid body");
  const keys = [...new Set(parsed.data.keys)];

  try {
    const [name, runnable] = await Promise.all([companyName(tenant_id), ensureAgentRunnable(tenant_id, "operator")]);
    if (!runnable.runnable) {
      res.status(403).json({ error: { code: runnable.reason, message: runnable.detail } });
      return;
    }
    const dedupeKey = `company-fields:${tenant_id}:${parsed.data.request_id}`;
    const enqueued = await enqueueAgentRun({
      tenant_id,
      agent_slug: "operator",
      trigger: "a2a",
      cron_dedupe_key: dedupeKey,
      payload: {
        source: COMPANY_FIELDS_FILL_SOURCE,
        origin: "staff_console",
        keys,
        request_id: parsed.data.request_id,
        task_description: fillFieldsPrompt(keys, name),
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
        throw new Error(existing.error?.message ?? "existing fill run could not be found");
      }
      run_id = existing.data.id;
    }
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "company_fields_fill_started",
      target_table: "agent_runs",
      target_id: run_id,
      tenant_id,
      meta: { keys, request_id: parsed.data.request_id },
    });
    res.status(202).json({ run_id, request_id: parsed.data.request_id, keys, status: "running" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "fill could not be started";
    res.status(/tenant not found/i.test(message) ? 404 : 503).json({ error: { code: "fill_start_failed", message } });
  }
}

export async function staffCompanyFieldsFillStatus(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  if (!z.string().uuid().safeParse(req.params.run_id).success) return badRequest(res, "run_id must be a UUID");
  try {
    const row = await readOwnedFillRun(req.params.tenant_id, req.params.run_id);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "fill run not found" } });
      return;
    }
    const payload = payloadOf(row);
    const request_id = typeof payload.request_id === "string" ? payload.request_id : "";
    const keys = requestedKeys(payload);
    if (["queued", "dispatched", "running"].includes(row.status)) {
      res.json({ status: "running", run_id: row.id, request_id, keys });
      return;
    }
    if (row.status !== "success") {
      res.json({ status: "failed", run_id: row.id, request_id, keys, error: row.error || "The operator run did not complete." });
      return;
    }
    const result = extractCompanyFields(row.output_text, keys);
    if (!result) {
      res.json({
        status: "failed",
        run_id: row.id,
        request_id,
        keys,
        error: "The operator finished without a usable company_fields block. Retry the fill.",
      });
      return;
    }
    res.json({ status: "complete", run_id: row.id, request_id, keys, ...result });
  } catch (error) {
    res.status(500).json({ error: { code: "fill_status_failed", message: (error as Error).message } });
  }
}

export async function staffCompanyFieldsPublish(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const parsed = PublishBody.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message ?? "invalid body");

  try {
    const run = await readOwnedFillRun(tenant_id, parsed.data.run_id);
    if (!run || run.status !== "success") {
      res.status(409).json({ error: { code: "fill_not_complete", message: "Finish the AI fill before saving." } });
      return;
    }
    const payload = payloadOf(run);
    if (payload.request_id !== parsed.data.request_id) {
      res.status(409).json({ error: { code: "stale_fill", message: "This fill result is stale. Run the fill again." } });
      return;
    }
    const allowed = new Set(requestedKeys(payload));
    const fields = parsed.data.fields.filter((field) => allowed.has(field.key));
    if (fields.length === 0) {
      res.status(400).json({ error: { code: "invalid_request", message: "no reviewed fields belong to this fill run" } });
      return;
    }
    const now = new Date().toISOString();
    const { data, error } = await sb()
      .from("company_profile_fields")
      .upsert(
        fields.map((field) => ({
          tenant_id,
          key: field.key,
          value: field.value,
          method: field.method,
          source: field.source,
          formula: field.formula,
          inputs: field.inputs,
          assumptions: field.assumptions,
          caveats: field.caveats,
          confidence: field.confidence,
          status: "ai_estimated",
          evidence: field.evidence,
          source_run_id: run.id,
          reviewed_by: staff.user_id,
          updated_at: now,
        })),
        { onConflict: "tenant_id,key" },
      )
      .select("id, key");
    if (error) throw new Error(error.message);
    invalidateClientContext(tenant_id);

    const icp = fields.find((f) => f.key === "primary_icp");
    let projected: { written: boolean; refused: boolean; error: string | null } | undefined;
    if (icp) {
      const r = await projectCompanyFact(
        sb(), tenant_id, "who_we_serve", icp.value, "ai_estimated",
        `company field primary_icp published by ${staff.email} (run ${run.id})`,
      );
      projected = { written: r.written, refused: !r.written && !r.error, error: r.error };
    }

    for (const row of (data ?? []) as Array<{ id: string; key: string }>) {
      await writeStaffAudit({
        actor_user_id: staff.user_id,
        actor_email: staff.email,
        action: "company_field_published",
        target_table: "company_profile_fields",
        target_id: row.id,
        tenant_id,
        meta: {
          key: row.key,
          source_run_id: run.id,
          ...(row.key === "primary_icp" && projected ? { projected } : {}),
        },
      });
    }
    res.json({ ok: true, saved: (data ?? []).length, projected });
  } catch (error) {
    res.status(500).json({ error: { code: "company_fields_publish_failed", message: (error as Error).message } });
  }
}
