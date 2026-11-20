
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { approveCard, ignoreCard } from "@/services/memory-cards/store";

export async function workspaceMemoryCardsList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("memory_cards")
    .select(
      "id, source_kind, source_url, title, body, source_excerpt, confidence, status, memory_note_id, created_at, decided_at",
    )
    .eq("tenant_id", auth.tenant_id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    res.status(500).json({ error: { code: "db", message: error.message } });
    return;
  }
  const cards = data ?? [];
  res.json({
    pending: cards.filter((c) => c.status === "pending_review"),
    decided: cards.filter((c) => c.status !== "pending_review").slice(0, 20),
  });
}

const IdParam = z.object({ id: z.string().uuid() });
const ApproveBody = z.object({
  title: z.string().min(3).max(200).optional(),
  body: z.string().max(2000).optional(),
});

export async function workspaceMemoryCardApprove(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const p = IdParam.safeParse(req.params);
  if (!p.success) {
    res.status(400).json({ error: { code: "invalid_id", message: "bad card id" } });
    return;
  }
  let body: z.infer<typeof ApproveBody>;
  try {
    body = ApproveBody.parse(req.body ?? {});
  } catch (e) {
    res.status(400).json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const r = await approveCard({
    tenant_id: auth.tenant_id,
    card_id: p.data.id,
    actor_user_id: auth.user_id,
    title_override: body.title,
    body_override: body.body,
  });
  if (!r.ok) {
    res.status(r.code === "not_found" ? 404 : 502).json({ error: { code: r.code, message: r.message } });
    return;
  }
  res.json({ ok: true, status: r.status, changed: r.changed, memory_note_id: r.memory_note_id });
}

export async function workspaceMemoryCardIgnore(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const p = IdParam.safeParse(req.params);
  if (!p.success) {
    res.status(400).json({ error: { code: "invalid_id", message: "bad card id" } });
    return;
  }
  const r = await ignoreCard({
    tenant_id: auth.tenant_id,
    card_id: p.data.id,
    actor_user_id: auth.user_id,
  });
  if (!r.ok) {
    res.status(404).json({ error: { code: r.code, message: r.message } });
    return;
  }
  res.json({ ok: true, status: r.status, changed: r.changed });
}
