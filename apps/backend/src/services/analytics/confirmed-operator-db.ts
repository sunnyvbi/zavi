
import { getCatalog } from "@/services/tools/operator-db/catalog";
import { getConfirmedMapping, type CanonicalMap } from "@/services/tools/operator-db/mapping";
import { resolveAttachedDb } from "@/services/data-gateway";
import type { GatewayContext } from "@/services/data-gateway/types";
import type { OperatorDbDriver, SchemaMap } from "@/services/tools/operator-db/types";
import type { OperatorDbWindowExt } from "@/services/analytics/operator-db-window-stubs";
import { ExpectedToolError } from "@/services/tools/types";

export type OperatorRole = "users" | "bookings";

export type ConfirmedOperatorDb =
  | {
      ok: true;
      driver: OperatorDbDriver & OperatorDbWindowExt;
      cfg: SchemaMap;
      confirmed_at: string;
      table: string;
      created_at_field: string | null;
      close: () => Promise<void>;
    }
  | { ok: false; reason: "not_connected" | "needs_confirmation" | "read_failed"; message: string };

export type ConfirmedDbDeps = {
  getCatalog: typeof getCatalog;
  getConfirmedMapping: typeof getConfirmedMapping;
  resolveAttachedDb: (ctx: GatewayContext) => Promise<{ driver: OperatorDbDriver; cfg: SchemaMap; close?: () => Promise<void> }>;
};

const realDeps: ConfirmedDbDeps = { getCatalog, getConfirmedMapping, resolveAttachedDb };

const ROLE_LABEL: Record<OperatorRole, string> = { users: "users/accounts", bookings: "bookings/orders" };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

export function roleIsConfirmed(map: CanonicalMap | null | undefined, role: OperatorRole): boolean {
  const e = map?.[role];
  if (!e || !str(e.table)) return false;
  return role === "bookings" ? Boolean(str(e.created_at_field)) : true;
}

function errorToFail(e: unknown): ConfirmedOperatorDb {
  if (e instanceof ExpectedToolError && e.code === "operator_db_not_connected") {
    return { ok: false, reason: "not_connected", message: "No database is connected." };
  }
  if (e instanceof ExpectedToolError && e.code === "operator_db_not_discovered") {
    return { ok: false, reason: "needs_confirmation", message: "The database schema is still being discovered, so there is no confirmed mapping yet." };
  }
  if (e instanceof ExpectedToolError && (e.code === "operator_db_unreachable" || e.code === "operator_db_tls_refused")) {
    return { ok: false, reason: "read_failed", message: e.message };
  }
  const code =e instanceof ExpectedToolError ? e.code : (e as Error)?.message ?? String(e);
  return { ok: false, reason: "read_failed", message: `The database could not be read (${String(code).slice(0, 120)}).` };
}

export async function resolveConfirmedOperatorDb(
  gateway: GatewayContext,
  role: OperatorRole,
  deps: ConfirmedDbDeps = realDeps,
): Promise<ConfirmedOperatorDb> {
  const tenant_id = gateway.tenant_id;
  try {
    const catalog = await deps.getCatalog(tenant_id);
    if (!catalog || !catalog.catalog_hash) {
      const probe = await deps.resolveAttachedDb(gateway);
      await probe.close?.();
      return { ok: false, reason: "needs_confirmation", message: "The database schema is still being discovered." };
    }
    const confirmed = await deps.getConfirmedMapping(tenant_id, catalog.catalog_hash);
    if (!confirmed || !roleIsConfirmed(confirmed.confirmed_map, role)) {
      return {
        ok: false,
        reason: "needs_confirmation",
        message: `The founder has not confirmed which table holds ${ROLE_LABEL[role]}${role === "bookings" ? " and its created-at field" : ""}. Ask them to confirm the data mapping (the growth_constraint_diagnosis flow); no number is given until then.`,
      };
    }
    const { driver, cfg, close } = await deps.resolveAttachedDb(gateway);
    const entry = confirmed.confirmed_map[role]!;
    return {
      ok: true,
      driver: driver as OperatorDbDriver & OperatorDbWindowExt,
      cfg,
      confirmed_at: confirmed.confirmed_at,
      table: entry.table,
      created_at_field: str(entry.created_at_field),
      close: close ?? (async () => undefined),
    };
  } catch (e) {
    return errorToFail(e);
  }
}
