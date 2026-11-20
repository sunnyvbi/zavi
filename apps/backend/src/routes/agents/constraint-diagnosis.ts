
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { getBoolSetting } from "@/services/settings";
import { ExpectedToolError, type ToolContext } from "@/services/tools/types";
import { growthConstraintDiagnosisTool } from "@/services/tools/growth/growth_constraint_diagnosis";
import { getCatalog } from "@/services/tools/operator-db/catalog";

function numberQuery(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function slimSchema(
  tenantId: string,
): Promise<{ tables: Array<{ name: string; columns: string[] }> } | null> {
  try {
    const resolved = await getCatalog(tenantId);
    const tables = resolved?.catalog?.tables ?? [];
    if (tables.length === 0) return null;
    return {
      tables: tables.map((t) => ({
        name: t.name,
        columns: (t.columns ?? []).map((c) => c.name).filter(Boolean),
      })),
    };
  } catch {
    return null;
  }
}

export async function growthConstraintDiagnosis(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!(await getBoolSetting("growth_constraint_card_enabled", auth.tenant_id))) {
    res.json({ status: "disabled", tenant_id: auth.tenant_id });
    return;
  }

  const ctx: ToolContext = {
    tenant_id: auth.tenant_id,
    log: () => {},
    agent_slug: "growth-lead",
  };

  const windowDays = numberQuery(req.query.window_days);

  try {
    const result = (await growthConstraintDiagnosisTool.execute(
      ctx,
      windowDays !== undefined ? { window_days: windowDays } : {},
    )) as Record<string, unknown>;

    const schema =
      result.status === "requires_mapping_confirmation"
        ? await slimSchema(auth.tenant_id)
        : null;

    res.json({ ...result, schema, tenant_id: auth.tenant_id });
  } catch (err) {
    if (err instanceof ExpectedToolError) {
      res.json({
        status: "not_available",
        reason: err.code,
        message: err.message,
        tenant_id: auth.tenant_id,
      });
      return;
    }
    res
      .status(500)
      .json({ status: "error", message: "diagnosis_failed" });
  }
}
