import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";

const Id = z.object({ decision_id: z.string().uuid() });
const Limit = z.number().int().positive().max(9_999_900);
const NewCuts = z.array(z.object({ platform: z.enum(["meta", "google"]), object_id: z.string().min(1).max(64), to_usd: z.number().positive().max(9_999_900) })).max(4);
const ApproveMoveBody = z.object({
  ticked_ids: z.array(z.string().uuid()).max(20),
  new_cuts: NewCuts.optional(),
  retry_ids: z.array(z.string().uuid()).max(10).optional(),
  finish: z.boolean().optional(),
  raise_budget_to_usd: Limit.optional(),
  raise_daily_limit_to_usd: Limit.optional(),
});
const MoveFitBody = z.object({ ticked_ids: z.array(z.string().uuid()).max(20), new_cuts: NewCuts.optional() });

async function gate(req: Request, res: Response) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  const id = Id.safeParse(req.params);
  if (!id.success) {
    res.status(400).json({ error: { code: "invalid_decision_id", message: "decision_id must be a UUID" } });
    return null;
  }
  if (auth.tenant_overridden) {
    res.status(403).json({ error: { code: "not_authorized", message: "Only the company's own owner or admin can approve a move." } });
    return null;
  }
  return { auth, decision_id: id.data.decision_id };
}

export async function approvalsApproveMove(req: Request, res: Response): Promise<void> {
  const g = await gate(req, res);
  if (!g) return;
  const body = ApproveMoveBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid_body", message: "ticked_ids must be a list of card ids" } });
    return;
  }
  const { approveMove } = await import("@/services/growth/move-card");
  const r = await approveMove({ tenant_id: g.auth.tenant_id, actor_user_id: g.auth.user_id, anchor_id: g.decision_id, ...body.data });
  if (r.ok) {
    res.json(r);
    return;
  }
  const status = r.code === "not_authorized" ? 403 : r.code === "budget_unreadable" || r.code === "move_unreadable" ? 503 : r.code === "not_in_move" ? 404 : r.code === "invalid_new_cuts" ? 400 : 409;
  res.status(status).json({
    error: {
      code: r.code, message: r.detail ?? "Nothing was approved.", line_id: r.line_id ?? null, done: r.done ?? [], budget_choice: r.budget_choice ?? null,
      ...(r.filed ? { filed: r.filed } : {}),
      ...(r.candidates ? { candidates: r.candidates } : {}),
    },
  });
}

export async function approvalsRejectMove(req: Request, res: Response): Promise<void> {
  const g = await gate(req, res);
  if (!g) return;
  const { rejectMove } = await import("@/services/growth/move-card");
  const r = await rejectMove(g.auth.tenant_id, g.auth.user_id, g.decision_id);
  if (r.ok) {
    res.json(r);
    return;
  }
  res.status(r.code === "not_in_move" ? 404 : 503).json({ error: { code: r.code, message: r.detail ?? "Nothing was rejected." } });
}

export async function approvalsMoveFit(req: Request, res: Response): Promise<void> {
  const g = await gate(req, res);
  if (!g) return;
  const body = MoveFitBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid_body", message: "ticked_ids must be a list of card ids" } });
    return;
  }
  const { moveFit } = await import("@/services/growth/move-card");
  const r = await moveFit(g.auth.tenant_id, g.decision_id, body.data.ticked_ids, body.data.new_cuts);
  if (r.ok) {
    res.json(r);
    return;
  }
  res.status(r.code === "not_in_move" ? 404 : 409).json({ error: { code: r.code, line_id: r.line_id ?? null, ...(r.candidates ? { candidates: r.candidates } : {}) } });
}

export async function approvalsFindMoney(req: Request, res: Response): Promise<void> {
  const g = await gate(req, res);
  if (!g) return;
  const { findMoneyView } = await import("@/services/growth/move-card");
  try {
    const v = await findMoneyView(g.auth.tenant_id, g.decision_id);
    if (!v) {
      res.status(404).json({ error: { code: "not_an_open_raise", message: "This card is not an open raise." } });
      return;
    }
    res.json(v);
  } catch (e) {
    console.warn(`[find-money] ${g.decision_id} unreadable: ${(e as Error).message}`);
    res.status(503).json({ error: { code: "move_unreadable", message: "Zavi could not read this card just now. Try again." } });
  }
}
