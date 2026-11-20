
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { writeStaffAudit } from "@/services/staff/audit";
import {
  FLAG_NAME_RE,
  createFlag,
  deleteFlag,
  evaluateFlag,
  getFlag,
  listFlags,
  rolloutBucket,
  updateFlag,
  _resetGatekeeperCache,
} from "@/services/gatekeeper";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FlagFields = z.object({
  description: z.string().max(500).optional(),
  is_enabled: z.boolean().optional(),
  rollout_percentage: z.number().int().min(0).max(100).optional(),
  cache_policy: z.enum(["critical", "standard"]).optional(),
  whitelist: z
    .array(z.string().regex(UUID_RE, "whitelist entries must be user ids (uuid)"))
    .max(1000)
    .optional(),
});

const CreateBody = FlagFields.extend({
  name: z.string().regex(FLAG_NAME_RE, "name must be lowercase letters, digits, _ . - (max 80)"),
});

function bad(res: Response, message: string): void {
  res.status(400).json({ error: { code: "bad_body", message } });
}

function notFound(res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: "Feature flag not found" } });
}

function normalize<T extends { whitelist?: string[]; description?: string }>(input: T): T {
  return {
    ...input,
    ...(input.whitelist ? { whitelist: Array.from(new Set(input.whitelist.map((u) => u.trim().toLowerCase()))) } : {}),
    ...(input.description !== undefined ? { description: input.description.trim() } : {}),
  };
}

export async function staffGatekeeperList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  res.json({ flags: await listFlags() });
}

export async function staffGatekeeperGet(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  _resetGatekeeperCache();
  const flag = await getFlag(String(req.params.name));
  if (!flag) return notFound(res);
  res.json({ flag });
}

export async function staffGatekeeperCreate(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "invalid body");
  const { name, ...fields } = normalize(parsed.data);

  const flag = await createFlag(name, fields, staff.email);
  if (!flag) {
    res.status(409).json({ error: { code: "exists", message: "A flag with this name already exists" } });
    return;
  }
  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "gatekeeper.create",
    target_table: "gatekeeper_flags",
    target_id: name,
    meta: { ...fields, whitelist: undefined, whitelist_count: fields.whitelist?.length ?? 0 },
  });
  res.status(201).json({ flag });
}

export async function staffGatekeeperUpdate(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const name = String(req.params.name);
  const parsed = FlagFields.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "invalid body");
  const fields = normalize(parsed.data);
  if (Object.keys(fields).length === 0) return bad(res, "nothing to update");

  const flag = await updateFlag(name, fields, staff.email);
  if (!flag) return notFound(res);
  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "gatekeeper.update",
    target_table: "gatekeeper_flags",
    target_id: name,
    meta: { ...fields, whitelist: undefined, whitelist_count: fields.whitelist?.length },
  });
  res.json({ flag });
}

const ToggleBody = z.object({ is_enabled: z.boolean() });

export async function staffGatekeeperToggle(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const name = String(req.params.name);
  const parsed = ToggleBody.safeParse(req.body);
  if (!parsed.success) return bad(res, "is_enabled (boolean) is required");
  const flag = await updateFlag(name, { is_enabled: parsed.data.is_enabled }, staff.email);
  if (!flag) return notFound(res);
  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "gatekeeper.toggle",
    target_table: "gatekeeper_flags",
    target_id: name,
    meta: { is_enabled: flag.is_enabled },
  });
  res.json({ flag });
}

export async function staffGatekeeperDelete(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const name = String(req.params.name);
  const deleted = await deleteFlag(name);
  if (!deleted) return notFound(res);
  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "gatekeeper.delete",
    target_table: "gatekeeper_flags",
    target_id: name,
  });
  res.json({ deleted: true });
}

export async function staffGatekeeperCheck(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const name = String(req.params.name);
  const userId = typeof req.query.user_id === "string" && req.query.user_id.trim() ? req.query.user_id.trim().toLowerCase() : null;
  _resetGatekeeperCache();
  const flag = await getFlag(name);
  const { enabled, reason } = evaluateFlag(flag, userId);
  res.json({
    name,
    user_id: userId,
    enabled,
    reason,
    bucket: userId ? rolloutBucket(userId, name) : null,
  });
}
