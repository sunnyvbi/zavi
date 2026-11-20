
import type { Request, Response } from "express";
import { z } from "zod";

import { requireAuth } from "@/services/auth/middleware";
import { getBoolSetting, setTenantSetting } from "@/services/settings";
import type { SettingKey } from "@/services/settings/registry";

export const NOTIFICATION_PREF_KEYS = [
  "slack_approval_push_enabled",
  "autopilot_digest_push_enabled",
  "slack_connector_alert_enabled",
  "autopilot_digest_email_enabled",
  "material_news_enabled",
  "mention_alerts_enabled",
] as const satisfies readonly SettingKey[];

export type NotificationPrefKey = (typeof NOTIFICATION_PREF_KEYS)[number];

const patchBody = z
  .object(
    Object.fromEntries(
      NOTIFICATION_PREF_KEYS.map((k) => [k, z.boolean().optional()]),
    ) as Record<NotificationPrefKey, z.ZodOptional<z.ZodBoolean>>,
  )
  .strict();

async function readAll(tenant_id: string): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    NOTIFICATION_PREF_KEYS.map(
      async (k) => [k, await getBoolSetting(k, tenant_id)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

export async function getNotificationPrefs(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json({ prefs: await readAll(auth.tenant_id) });
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "read_failed", message: (e as Error).message } });
  }
}

export async function patchNotificationPrefs(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = patchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: `body must contain only booleans for: ${NOTIFICATION_PREF_KEYS.join(", ")}`,
      },
    });
    return;
  }

  const updates = Object.entries(parsed.data).filter(
    ([, v]) => typeof v === "boolean",
  ) as Array<[NotificationPrefKey, boolean]>;

  if (updates.length === 0) {
    res.status(400).json({
      error: { code: "bad_request", message: "no settings provided" },
    });
    return;
  }

  const applied: string[] = [];
  try {
    for (const [key, value] of updates) {
      await setTenantSetting(auth.tenant_id, key, value, auth.user_id);
      applied.push(key);
    }
    res.json({ prefs: await readAll(auth.tenant_id) });
  } catch (e) {
    let prefs: Record<string, boolean> | null = null;
    try {
      prefs = await readAll(auth.tenant_id);
    } catch {
      prefs = null;
    }
    res.status(500).json({
      error: {
        code: "write_failed",
        message: (e as Error).message,
        applied,
      },
      ...(prefs ? { prefs } : {}),
    });
  }
}
