import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import {
  BOARD_DESCRIPTION_MAX,
  BOARD_NAME_MAX,
  createPinterestBoard,
  resolvePinterestPublishReadiness,
  searchPinterestBoards,
} from "@/services/connectors/pinterest-composio/readiness";

export async function pinterestReadinessGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const readiness = await resolvePinterestPublishReadiness(auth.tenant_id, undefined, { only: ["board"] });
  res.json({
    connected: readiness.checks.board.reason_code !== "pinterest_not_connected",
    readiness,
  });
}

const CreateBody = z.object({
  name: z.string().trim().min(1).max(BOARD_NAME_MAX),
  description: z.string().trim().max(BOARD_DESCRIPTION_MAX).optional(),
});

const CREATE_STATUS = { not_connected: 409, name_taken: 409, refused: 422, unconfirmed: 502 } as const;

export async function pinterestBoardCreate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to make changes." } });
    return;
  }
  const body = CreateBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "validation", message: `Give the board a name of 1 to ${BOARD_NAME_MAX} characters, and a description under ${BOARD_DESCRIPTION_MAX}.` } });
    return;
  }
  const r = await createPinterestBoard(auth.tenant_id, { name: body.data.name, description: body.data.description || undefined });
  if (!r.ok) {
    res.status(CREATE_STATUS[r.code]).json({ error: { code: r.code, message: r.message } });
    return;
  }
  res.json({ board: { id: r.board.id, label: r.board.name } });
}

const SearchQuery = z.object({ q: z.string().trim().min(1).max(BOARD_NAME_MAX) });

export async function pinterestBoardSearch(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const q = SearchQuery.safeParse(req.query ?? {});
  if (!q.success) {
    res.status(400).json({ error: { code: "validation", message: "Type part of the board's name." } });
    return;
  }
  const r = await searchPinterestBoards(auth.tenant_id, q.data.q);
  if (!r.ok) {
    const notConnected = r.code === "pinterest_not_connected";
    res.status(notConnected ? 409 : 502).json({
      error: {
        code: notConnected ? "not_connected" : "lookup_failed",
        message: notConnected
          ? "Pinterest is not connected for this workspace. Connect Pinterest, then search again."
          : "Zavi could not search your Pinterest boards just now. Try again in a minute.",
      },
    });
    return;
  }
  const boards = r.boards.filter((b) => (b.privacy ?? "").toUpperCase() !== "SECRET").map((b) => ({ id: b.id, label: b.name }));
  res.json({ boards, complete: r.complete });
}
