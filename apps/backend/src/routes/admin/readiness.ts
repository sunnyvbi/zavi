
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { computeReadiness, readReadiness } from "@/services/readiness/compute";
import { buildBoard } from "@/services/readiness/board";
import {
  logFdeEvent,
  listFdeEvents,
  ACTION_KINDS,
  GAP_DIMENSIONS,
  type ActionKind,
  type GapDimension,
} from "@/services/readiness/fde-events";

export async function staffTenantReadiness(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenant_id = req.params.tenant_id;
  try {
    if (String(req.query.recompute ?? "") === "1") {
      await computeReadiness(tenant_id);
    }
    const readiness = await readReadiness(tenant_id);
    res.json({ readiness });
  } catch (e) {
    res.status(500).json({ error: { code: "readiness_failed", message: (e as Error).message } });
  }
}

export async function staffReadinessBoard(_req: Request, res: Response): Promise<void> {
  assertStaff(_req);
  try {
    const board = await buildBoard();
    res.json(board);
  } catch (e) {
    res.status(500).json({ error: { code: "readiness_board_failed", message: (e as Error).message } });
  }
}

export async function staffTenantFdeEvents(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  try {
    const events = await listFdeEvents(req.params.tenant_id);
    res.json({ events });
  } catch (e) {
    res.status(500).json({ error: { code: "fde_events_failed", message: (e as Error).message } });
  }
}

export async function staffFdeAction(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const tenant_id = typeof body.tenant_id === "string" ? body.tenant_id.trim() : "";
  if (!tenant_id) {
    res.status(400).json({ error: { code: "invalid_tenant_id", message: "tenant_id required" } });
    return;
  }

  const action_kind = body.action_kind as ActionKind;
  if (!ACTION_KINDS.includes(action_kind)) {
    res.status(400).json({
      error: {
        code: "invalid_action_kind",
        message: `action_kind must be one of: ${ACTION_KINDS.join(", ")}`,
      },
    });
    return;
  }

  const gap_dimension = (body.gap_dimension ?? null) as GapDimension | null;
  if (gap_dimension !== null && !GAP_DIMENSIONS.includes(gap_dimension)) {
    res.status(400).json({
      error: {
        code: "invalid_gap_dimension",
        message: `gap_dimension must be one of: ${GAP_DIMENSIONS.join(", ")}`,
      },
    });
    return;
  }

  try {
    const before = await readReadiness(tenant_id);

    const event = await logFdeEvent({
      tenant_id,
      action_kind,
      gap_dimension,
      staff_user_id: staff.user_id,
      staff_email: staff.email,
      readiness_at: before?.computed_at ?? null,
      before_score: before?.score ?? null,
      input_ref: str(body.input_ref),
      work_product_ref: str(body.work_product_ref),
      escalation_category: str(body.escalation_category),
      agent_training_hint: str(body.agent_training_hint),
    });

    res.json({ event });
  } catch (e) {
    res.status(500).json({ error: { code: "fde_action_failed", message: (e as Error).message } });
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
