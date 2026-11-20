
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { writeStaffAudit } from "@/services/staff/audit";
import {
  editSecretList,
  listSettings,
  SecretListError,
  type SecretListEdit,
  setGlobalSetting,
  setTenantSetting,
  REDACTED_SETTING_VALUE,
} from "@/services/settings";
import { APP_SETTINGS, CONSENT_KEYS_PER_TENANT_ONLY, isSettingKey, type SettingDef } from "@/services/settings/registry";
import {
  BUILD_REPLAY_FIXTURES,
  BUILD_REPLAY_OFF,
  BUILD_REPLAY_SETTING,
  buildReplayAllowed,
} from "@/services/agents/build-replay-config";

function grantsConsent(key: string, value: unknown): boolean {
  if (value === true) return true;
  if (key !== BUILD_REPLAY_SETTING) return false;
  return typeof value === "string" && value.trim() !== "" && value.trim() !== BUILD_REPLAY_OFF;
}

export async function staffSettingsGet(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const settings = await listSettings();
  res.json({ settings });
}

const PutBody = z
  .object({
    key: z.string().min(1),
    scope: z.enum(["global", "tenant"]),
    tenant_id: z.string().uuid().optional(),
    value: z.unknown(),
    op: z.enum(["set", "append", "append_with_note", "remove", "replace", "note"]).optional(),
    note: z.string().optional(),
    target: z.string().min(1).optional(),
    expected_revision: z.string().nullable().optional(),
  })
  .superRefine((body, ctx) => {
    if (!Object.prototype.hasOwnProperty.call(body, "value")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "value is required (use null to clear a tenant override)" });
    }
  });

export async function staffSettingsPut(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = PutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_body", message: parsed.error.message } });
    return;
  }
  const { key, scope, tenant_id, value } = parsed.data;
  const op = parsed.data.op ?? "set";
  const isSecret = isSettingKey(key) && Boolean((APP_SETTINGS[key] as SettingDef).secret);

  if (typeof value === "string" && value.trim() === REDACTED_SETTING_VALUE) {
    res.status(400).json({
      error: {
        code: "redacted_placeholder_write",
        message: `refusing to store the redaction placeholder for ${key}. Paste the real value, or "" to clear it.`,
      },
    });
    return;
  }

  if (scope === "global" && CONSENT_KEYS_PER_TENANT_ONLY.has(key) && grantsConsent(key, value)) {
    res.status(400).json({
      error: {
        code: "cannot_set_consent_globally",
        message: `${key} is consent-class. Grant it per-tenant (scope=tenant), not globally.`,
      },
    });
    return;
  }

  if (key === BUILD_REPLAY_SETTING && value !== null && value !== BUILD_REPLAY_OFF) {
    if (typeof value !== "string" || !(BUILD_REPLAY_FIXTURES as readonly string[]).includes(value)) {
      res.status(400).json({
        error: { code: "unknown_fixture", message: `${key} must be "${BUILD_REPLAY_OFF}" or one of ${BUILD_REPLAY_FIXTURES.join(", ")}` },
      });
      return;
    }
    if (!buildReplayAllowed()) {
      res.status(400).json({
        error: { code: "replay_not_allowed_here", message: `${key} can only be turned on from a local dev backend, never production or staging.` },
      });
      return;
    }
  }

  const def = isSettingKey(key) ? (APP_SETTINGS[key] as SettingDef) : undefined;
  if (def?.secretList) {
    await putCredentialList(staff, parsed.data, res);
    return;
  }
  if (op !== "set") {
    res.status(400).json({ error: { code: "bad_body", message: `op=${op} only applies to credential lists` } });
    return;
  }

  try {
    if (scope === "global") {
      await setGlobalSetting(key, value, staff.email);
    } else {
      if (!tenant_id) {
        res.status(400).json({ error: { code: "tenant_required", message: "tenant_id required for scope=tenant" } });
        return;
      }
      await setTenantSetting(tenant_id, key, value ?? null, staff.email);
    }
  } catch (e) {
    res.status(400).json({ error: { code: "invalid_setting", message: (e as Error).message } });
    return;
  }

  try {
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "settings_update",
      target_table: scope === "global" ? "app_setting" : "tenant_app_setting",
      target_id: key,
      tenant_id: scope === "tenant" ? (tenant_id ?? null) : null,
      meta: isSecret ? { key, scope, op } : { key, scope, value },
    });
  } catch (e) {
    console.warn(`[admin/settings] audit write failed (change applied): ${(e as Error).message}`);
  }

  res.json({ ok: true });
}

type PutBodyData = z.infer<typeof PutBody>;

async function putCredentialList(
  staff: { user_id: string; email: string },
  body: PutBodyData,
  res: Response,
): Promise<void> {
  const { key, scope, value } = body;
  const op = body.op ?? "set";
  const fail = (status: number, code: string, message: string) => {
    res.status(status).json({ error: { code, message } });
  };
  if (scope !== "global" || typeof value !== "string") {
    fail(400, "bad_body", `${key} needs scope=global and a string value`);
    return;
  }
  const hasRevision = Object.prototype.hasOwnProperty.call(body, "expected_revision") && body.expected_revision !== undefined;
  const needsRevision = op === "set" || op === "replace" || op === "note";
  if (needsRevision && !hasRevision) {
    fail(400, "expected_revision_required", `op=${op} needs expected_revision (reload the page and try again)`);
    return;
  }
  if ((op === "replace" || op === "note") && !body.target) {
    fail(400, "bad_body", `op=${op} needs target (the seat)`);
    return;
  }
  if (op === "append_with_note" && body.note === undefined) {
    fail(400, "bad_body", "op=append_with_note needs note");
    return;
  }
  const expectedRevision = body.expected_revision ?? null;
  const edit: SecretListEdit =
    op === "set"
      ? { op: "set", tokens: value, expectedRevision }
      : op === "append"
        ? { op: "append", tokens: value }
        : op === "append_with_note"
          ? { op: "append", tokens: value, note: body.note ?? "" }
          : op === "remove"
            ? { op: "remove", target: value }
            : op === "replace"
              ? { op: "replace", target: body.target as string, token: value, expectedRevision }
              : { op: "note", target: body.target as string, note: value, expectedRevision };

  let result: Awaited<ReturnType<typeof editSecretList>>;
  try {
    result = await editSecretList(key, edit, staff.email);
  } catch (e) {
    if (e instanceof SecretListError) {
      fail(e.status, e.code, e.message);
      return;
    }
    fail(503, "storage_unavailable", (e as Error).message);
    return;
  }

  const meta: Record<string, unknown> = { key, scope, op, count: result.count, changed: result.changed };
  if (result.seat) meta.seat = result.seat;
  if (op === "note" || op === "append_with_note") {
    const text = op === "note" ? value : (body.note ?? "");
    meta.note_len = text.trim().length;
    meta.deleted = text.trim() === "";
  }
  try {
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "settings_update",
      target_table: "app_setting",
      target_id: key,
      tenant_id: null,
      meta,
    });
  } catch (e) {
    console.warn(`[admin/settings] audit write failed (change applied): ${(e as Error).message}`);
  }

  res.json({ ok: true, count: result.count, revision: result.revision, ...(result.seat ? { seat: result.seat } : {}) });
}
