
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { writeStaffAudit } from "@/services/staff/audit";
import {
  HumanError,
  DISCIPLINES,
  STAFF_SETTABLE_STATES,
  VETTING_STATES,
  type Discipline,
  type VettingState,
} from "@/services/humans/contract";
import { getMemberDetail, listMembers, setVettingState } from "@/services/humans/store";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const QueueQuery = z.object({
  vetting_state: z.enum(VETTING_STATES).optional(),
  discipline: z.enum(DISCIPLINES).optional(),
  has_collision: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  sort: z.enum(["oldest", "newest"]).default("oldest"),
});

const VettingBody = z.object({
  state: z.enum(STAFF_SETTABLE_STATES),
  reason: z.string().trim().max(2000).optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res: Response, e: unknown): void {
  if (e instanceof HumanError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  console.error(`[admin/human] unexpected failure: ${(e as Error)?.message ?? e}`);
  res.status(500).json({ error: { code: "human_unavailable", message: "Human console is temporarily unavailable." } });
}

function badRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ error: { code, message } });
}

export async function staffHumanQueue(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const parsed = QueueQuery.safeParse(req.query ?? {});
  if (!parsed.success) {
    return badRequest(res, "validation", parsed.error.issues[0]?.message ?? "invalid query");
  }
  const q = parsed.data;
  try {
    const page = await listMembers({
      vetting_state: q.vetting_state as VettingState | undefined,
      discipline: q.discipline as Discipline | undefined,
      has_collision: q.has_collision === undefined ? undefined : q.has_collision === "true",
      limit: q.limit,
      offset: q.offset,
      sort: q.sort,
    });
    res.json(page);
  } catch (e) {
    sendError(res, e);
  }
}

export async function staffHumanDetail(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return badRequest(res, "invalid_id", "id must be a UUID");
  try {
    res.json(await getMemberDetail(id));
  } catch (e) {
    sendError(res, e);
  }
}

export async function staffHumanSetVetting(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return badRequest(res, "invalid_id", "id must be a UUID");

  const parsed = VettingBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return badRequest(res, "validation", parsed.error.issues[0]?.message ?? "invalid body");
  }
  const { state } = parsed.data;
  const reason = parsed.data.reason ?? "";

  if (state === "rejected" && reason.length === 0) {
    return badRequest(res, "reason_required", "A rejection must include a reason the applicant can act on.");
  }

  try {
    const member = await setVettingState(id, state, state === "rejected" ? reason : null);
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "human_vetting_set",
      target_table: "human_members",
      target_id: member.id,
      meta: {
        vetting_state: member.vetting_state,
        rejected_reason: member.rejected_reason,
        handle_verified_at: member.handle_verified_at,
      },
    });
    res.json({ member });
  } catch (e) {
    sendError(res, e);
  }
}
