




import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { loadTenantRole } from "@/services/auth/tenant-role";
import { logEvent } from "@/services/logging/logEvent";
import { AppDataError, listGeneratedAppTables } from "@/services/website/app-data";

export async function getWebsiteAppCatalogHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const [tables, role] = await Promise.all([
      listGeneratedAppTables(auth.tenant_id),
      loadTenantRole(auth),
    ]);
    const usersTable = tables.find((table) => table.name.toLowerCase() === "users");
    res.status(200).json({
      connected: true,
      dialect: "postgres",
      can_write: role === "owner" || role === "admin",
      tables: tables.map((table) => ({
        name: table.name,
        row_estimate: table.row_estimate,
        columns: table.columns,
        primary_key: table.primary_key,
        writable: table.writable,
      })),
      entities: usersTable
        ? { users: { table: usersTable.name, id_field: usersTable.primary_key[0] } }
        : {},
    });
  } catch (error) {
    if (error instanceof AppDataError && ["app_db_not_ready", "app_db_secret_missing"].includes(error.code)) {
      res.status(200).json({ connected: false, reason: "not_ready", dialect: "postgres" });
      return;
    }
    await logEvent({
      level: "error",
      source: "website.app_catalog",
      code: "app_catalog_read_failed",
      tenant_id: auth.tenant_id,
      error,
    });
    res.status(200).json({ connected: false, reason: "unavailable", dialect: "postgres" });
  }
}
