
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { logEvent } from "@/services/logging/logEvent";
import {
  APP_ROWS_DEFAULT_LIMIT,
  AppDataError,
  createGeneratedAppRow,
  deleteGeneratedAppRow,
  readGeneratedAppRows,
  rowKeySchema,
  rowValuesSchema,
  updateGeneratedAppRow,
} from "@/services/website/app-data";

const tableSchema = z.string().trim().min(1).max(128);
const versionSchema = z.string().min(1).max(64);
const createSchema = z.object({ table: tableSchema, values: rowValuesSchema }).strict();
const updateSchema = z.object({
  table: tableSchema,
  key: rowKeySchema,
  version: versionSchema,
  values: rowValuesSchema,
}).strict();
const deleteSchema = z.object({ table: tableSchema, key: rowKeySchema, version: versionSchema }).strict();
const WRITE_ROLES = ["owner", "admin"] as const;

function sendError(res: Response, error: unknown): void {
  if (!(error instanceof AppDataError)) {
    res.status(500).json({ error: { code: "unavailable", message: "The app database is unavailable." } });
    return;
  }
  const status =
    error.code === "app_db_stale_row" || error.code === "app_db_conflict" || error.code === "app_db_schema_mismatch"
      ? 409
      : error.code === "app_db_constraint" || error.code === "app_db_required_column" ||
          error.code === "app_db_foreign_key" || error.code === "app_db_check_constraint" ||
          error.code === "app_db_invalid_values"
        ? 422
        : error.code === "app_db_not_ready" || error.code === "app_db_secret_missing"
          ? 503
          : 400;
  res.status(status).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

async function auditMutation(auth: { tenant_id: string; user_id: string }, op: "create" | "update" | "delete") {
  await logEvent({
    level: "info",
    source: "website.app_data",
    code: `app_data_${op}`,
    tenant_id: auth.tenant_id,
    meta: { initiated_by_user: auth.user_id, op, driver: "postgres", count: 1 },
  });
}

async function auditRead(
  auth: { tenant_id: string; user_id: string },
  table: string,
  count: number,
) {
  await logEvent({
    level: "info",
    source: "website.app_data",
    code: "app_data_read",
    tenant_id: auth.tenant_id,
    meta: { initiated_by_user: auth.user_id, op: "read", driver: "postgres", table, count },
  });
}

async function auditMutationFailure(
  auth: { tenant_id: string; user_id: string },
  op: "create" | "update" | "delete",
  error: unknown,
) {
  if (error instanceof AppDataError) return;
  await logEvent({
    level: "error",
    source: "website.app_data",
    code: `app_data_${op}_failed`,
    tenant_id: auth.tenant_id,
    error,
    meta: { initiated_by_user: auth.user_id, op, driver: "postgres" },
  });
}

export async function getWebsiteAppRowsHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const parsedTable = tableSchema.safeParse(req.query.table);
  if (!parsedTable.success) {
    res.status(400).json({ error: { code: "missing_table", message: "table is required" } });
    return;
  }
  const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const offset = Number.parseInt(String(req.query.offset ?? ""), 10);
  try {
    const result = await readGeneratedAppRows({
      tenantId: auth.tenant_id,
      table: parsedTable.data,
      limit: Number.isFinite(limit) ? limit : APP_ROWS_DEFAULT_LIMIT,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    await auditRead(auth, parsedTable.data, Array.isArray(result.rows) ? result.rows.length : 0);
    res.status(200).json({ connected: true, supported: true, ...result });
  } catch (error) {
    if (error instanceof AppDataError && ["app_db_not_ready", "app_db_secret_missing"].includes(error.code)) {
      res.status(200).json({ connected: false, reason: "not_ready" });
      return;
    }
    if (error instanceof AppDataError) {
      sendError(res, error);
      return;
    }
    await logEvent({ level: "error", source: "website.app_rows", code: "app_rows_read_failed", tenant_id: auth.tenant_id, error });
    sendError(res, error);
  }
}

export async function createWebsiteAppRowHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.issues[0]?.message ?? "Invalid request." } });
    return;
  }
  try {
    const row = await createGeneratedAppRow({ tenantId: auth.tenant_id, ...parsed.data });
    await auditMutation(auth, "create");
    res.status(201).json({ ok: true, row });
  } catch (error) {
    await auditMutationFailure(auth, "create", error);
    sendError(res, error);
  }
}

export async function updateWebsiteAppRowHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.issues[0]?.message ?? "Invalid request." } });
    return;
  }
  try {
    const { roleChange, ...row } = await updateGeneratedAppRow({ tenantId: auth.tenant_id, ...parsed.data });
    await auditMutation(auth, "update");
    if (roleChange) {
      await logEvent({
        level: "info",
        source: "website.app_data",
        code: "app_role_changed",
        tenant_id: auth.tenant_id,
        meta: {
          initiated_by_user: auth.user_id,
          table: roleChange.table,
          target_id: roleChange.target_id,
          from_role: roleChange.from,
          to_role: roleChange.to,
        },
      });
    }
    res.status(200).json({ ok: true, row });
  } catch (error) {
    await auditMutationFailure(auth, "update", error);
    sendError(res, error);
  }
}

export async function deleteWebsiteAppRowHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const parsed = deleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.issues[0]?.message ?? "Invalid request." } });
    return;
  }
  try {
    await deleteGeneratedAppRow({ tenantId: auth.tenant_id, ...parsed.data });
    await auditMutation(auth, "delete");
    res.status(200).json({ ok: true });
  } catch (error) {
    await auditMutationFailure(auth, "delete", error);
    sendError(res, error);
  }
}
