
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { REDACTED_SETTING_VALUE } from "@/services/settings";
import { APP_SETTINGS, isSettingKey, type SettingDef } from "@/services/settings/registry";

function isSecretSettingKey(key: string): boolean {
  if (!isSettingKey(key)) return false;
  const def: SettingDef = APP_SETTINGS[key];
  return def.secret === true;
}

type GlobalFlag = {
  key: string;
  value: unknown;
  value_type: string;
  description: string;
  updated_at: string | null;
  source: "app_setting" | "system_config";
};

type OverrideCount = {
  key: string;
  tenants: number;
};

function inferType(v: unknown): string {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (v === null) return "unknown";
  return "json";
}

export async function staffFeatureFlags(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/feature-flags: cross-tenant staff read-only board");

  const [settingsRes, blobRes, overridesRes] = await Promise.all([
    sb
      .from("app_setting")
      .select("key, value, value_type, description, updated_at")
      .order("key", { ascending: true }),
    sb.from("system_config").select("blob, updated_at").eq("id", 1).maybeSingle(),
    sb.from("tenant_app_setting").select("key").limit(10000),
  ]);

  type SettingRow = {
    key: string | null;
    value: unknown;
    value_type: string | null;
    description: string | null;
    updated_at: string | null;
  };
  const globals: GlobalFlag[] = ((settingsRes.data ?? []) as SettingRow[])
    .filter((r): r is SettingRow & { key: string } => typeof r.key === "string")
    .map((r) => ({
      key: r.key,
      value: isSecretSettingKey(r.key) ? REDACTED_SETTING_VALUE : r.value,
      value_type: r.value_type || inferType(r.value),
      description: r.description || "",
      updated_at: r.updated_at,
      source: "app_setting",
    }));

  const settingKeys = new Set(globals.map((g) => g.key));

  const blobRow = (blobRes.data ?? null) as { blob: unknown; updated_at: string | null } | null;
  const blob = blobRow && typeof blobRow.blob === "object" && blobRow.blob !== null
    ? (blobRow.blob as Record<string, unknown>)
    : {};
  for (const [key, value] of Object.entries(blob)) {
    if (settingKeys.has(key)) continue;
    globals.push({
      key,
      value,
      value_type: inferType(value),
      description: "",
      updated_at: blobRow?.updated_at ?? null,
      source: "system_config",
    });
  }
  globals.sort((a, b) => a.key.localeCompare(b.key));

  const counts = new Map<string, number>();
  for (const row of (overridesRes.data ?? []) as Array<{ key: string | null }>) {
    if (typeof row.key !== "string") continue;
    counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  }
  const overrides: OverrideCount[] = Array.from(counts.entries())
    .map(([key, tenants]) => ({ key, tenants }))
    .sort((a, b) => b.tenants - a.tenants || a.key.localeCompare(b.key));

  const tenantOverrides = overrides.reduce((sum, o) => sum + o.tenants, 0);

  res.json({
    globals,
    overrides,
    summary: {
      globalFlags: globals.length,
      appSettingFlags: globals.filter((g) => g.source === "app_setting").length,
      blobFlags: globals.filter((g) => g.source === "system_config").length,
      overriddenKeys: overrides.length,
      tenantOverrides,
    },
  });
}
