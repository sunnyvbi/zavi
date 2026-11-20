
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { isStorableTimeZone, resolveReportingTimezone } from "@/services/analytics/tenant-timezone";

const bodySchema = z
  .object({
    reporting_timezone: z.string().trim().min(1).max(64).nullable(),
  })
  .strict();

export async function getReportingTimezone(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { data, error } = (await tenantClient(asTenantId(auth.tenant_id))
    .from("tenants")
    .select("reporting_timezone")
    .maybeSingle()) as { data: { reporting_timezone?: string | null } | null; error: { message?: string } | null };
  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: "Could not read the reporting time zone." } });
    return;
  }
  const effective = await resolveReportingTimezone(auth.tenant_id, { persist: false });
  res.json({ reporting_timezone: data?.reporting_timezone ?? null, effective: effective.tz, source: effective.source });
}

export async function patchReportingTimezone(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "validation", message: parsed.error.message } });
    return;
  }
  const tz = parsed.data.reporting_timezone;
  if (tz !== null && !isStorableTimeZone(tz)) {
    res.status(400).json({
      error: { code: "invalid_timezone", message: `'${tz}' is not a time zone name like America/New_York or Europe/London.` },
    });
    return;
  }
  const { error } = await tenantClient(asTenantId(auth.tenant_id)).from("tenants").update({ reporting_timezone: tz });
  if (error) {
    res.status(500).json({ error: { code: "write_failed", message: "Could not save the reporting time zone." } });
    return;
  }
  res.json({ reporting_timezone: tz });
}
