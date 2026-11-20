import { isRetiredSetting, RETIRED_SETTING_KEYS } from "@zavi/shared";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { getCompanyFacts } from "@/services/company/facts";
import { redditDb as serviceClient } from "@/services/channels/reddit/db";
import { readRedditWorkspace, workspaceRunContext } from "./reddit/workspace";

const KEEP = ["item", "item_type", "status", "note", "detail", "origin"] as const;

const OFF = new Set(["dismissed", "paused"]);

export const RETIRED_SETTINGS: ReadonlySet<string> = new Set(RETIRED_SETTING_KEYS);

export function projectSettings(fields: unknown, slug = ""): Record<string, unknown[]> | null {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const out: Record<string, unknown[]> = {};
  for (const [fieldId, items] of Object.entries(fields as Record<string, unknown>)) {
    if (isRetiredSetting(slug, fieldId)) continue;
    if (!Array.isArray(items)) continue;
    const kept: unknown[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.status === "string" && OFF.has(row.status)) continue;
      const projected: Record<string, unknown> = {};
      for (const k of KEEP) if (row[k] !== null && row[k] !== undefined) projected[k] = row[k];
      if (Object.keys(projected).length > 0) kept.push(projected);
    }
    if (kept.length > 0) out[fieldId] = kept;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function defaultChannelContext(
  tenant_id: string,
  channel_slug: string,
): Promise<Record<string, unknown> | null> {
  if (channel_slug === "reddit_organic") {
    const [ws, facts] = await Promise.all([
      readRedditWorkspace(serviceClient(), tenant_id),
      getCompanyFacts(tenant_id).catch(() => null),
    ]);
    return { reddit_workspace: workspaceRunContext(ws, facts?.competitors ?? []) };
  }

  const managed = channel_slug === "chatgpt_ads"
    ? { chatgpt_ads_workspace: await (await import("./chatgpt-ads/context")).chatgptAdsRunContext(tenant_id).catch(() => ({ unavailable: true })) }
    : null;

  let settings: Record<string, unknown[]> | null = null;
  let settingsUnavailable = false;
  try {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "get_channel_settings", {
      p_channel_slug: channel_slug,
    });
    if (error) throw new Error(error.message ?? "get_channel_settings failed");
    settings = projectSettings((data as { fields?: unknown } | null)?.fields, channel_slug);
  } catch (err) {
    console.warn(
      `[channel-context] settings read failed for ${channel_slug}; run continues on defaults: ` +
        `${(err as Error)?.message ?? err}`,
    );
    settingsUnavailable = true;
  }
  if (channel_slug === "email_marketing") settings = withFooterPostalAddress(settings, await footerPostalAddress(tenant_id, settings));
  const ctx = settings ? { ...managed, channel_settings: settings } : managed;
  return settingsUnavailable ? { ...ctx, channel_settings_unavailable: true } : ctx;
}

export const FOOTER_POSTAL_FIELD = "postal_address";

function settingPostalAddress(settings: Record<string, unknown[]> | null): string | null {
  for (const raw of settings?.[FOOTER_POSTAL_FIELD] ?? []) {
    const item = (raw as { item?: unknown } | null)?.item;
    const text = typeof item === "string" ? item.trim() : "";
    if (text) return text.slice(0, 500);
  }
  return null;
}

export async function footerPostalAddress(tenant_id: string, settings: Record<string, unknown[]> | null = null): Promise<string | null> {
  try {
    const { getEmailTemplate } = await import("@/services/email-templates/store");
    const stored = await getEmailTemplate(asTenantId(tenant_id));
    if (!stored) return settingPostalAddress(settings);
    const postal = stored.postal_address?.trim() ?? "";
    return postal ? postal.slice(0, 500) : null;
  } catch (err) {
    console.warn(`[channel-context] email footer read failed; run has no postal address: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

export function withFooterPostalAddress(
  settings: Record<string, unknown[]> | null,
  footer: string | null,
): Record<string, unknown[]> | null {
  if (footer) return { ...(settings ?? {}), [FOOTER_POSTAL_FIELD]: [{ item: footer }] };
  if (!settings || !(FOOTER_POSTAL_FIELD in settings)) return settings;
  const rest = { ...settings };
  delete rest[FOOTER_POSTAL_FIELD];
  return rest;
}
