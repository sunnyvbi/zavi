
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { joinMeetingNow } from "@/services/meetings/join-now";

const Body = z.object({ meeting_url: z.string().trim().min(8).max(500) });

const JOIN_ERROR_STATUS: Record<string, number> = {
  not_configured: 503,
  not_enabled: 409,
  bad_url: 400,
  too_many_active: 429,
  create_failed: 502,
};

export async function workspaceNotetakerJoin(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body ?? {});
  } catch (e) {
    res.status(400).json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const result = await joinMeetingNow({
    tenant_id: auth.tenant_id,
    meeting_url: body.meeting_url,
    requested_by: auth.user_id,
  });
  if (!result.ok) {
    res
      .status(JOIN_ERROR_STATUS[result.code] ?? 500)
      .json({ error: { code: result.code, message: result.message } });
    return;
  }
  res.json({ ok: true, meeting_bot_id: result.meeting_bot_id, deduped: result.deduped });
}

export async function workspaceNotetakerMeetings(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("meeting_bots")
    .select("id, status, source, meeting_url, scheduled_for, atoms_count, error, created_at, summary_email_sent_at")
    .eq("tenant_id", auth.tenant_id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) {
    res.status(500).json({ error: { code: "db", message: error.message } });
    return;
  }
  res.json({ meetings: data ?? [] });
}

export async function workspaceNotetakerAtoms(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const botId = String(req.params.botId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(botId)) {
    res.status(400).json({ error: { code: "bad_id", message: "invalid bot id" } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("meeting_atoms")
    .select("id, atom_type, title, body, owner, status, confidence")
    .eq("tenant_id", auth.tenant_id)
    .eq("bot_id", botId)
    .order("created_at", { ascending: true });
  if (error) {
    res.status(500).json({ error: { code: "db", message: error.message } });
    return;
  }
  res.json({ atoms: data ?? [] });
}

export async function workspaceNotetakerNotes(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const botId = String(req.params.botId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(botId)) {
    res.status(400).json({ error: { code: "bad_id", message: "invalid bot id" } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("meeting_notes")
    .select("minutes, transcript, created_at, delete_after")
    .eq("tenant_id", auth.tenant_id)
    .eq("bot_id", botId)
    .gt("delete_after", new Date().toISOString())
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: { code: "db", message: error.message } });
    return;
  }
  res.json({ notes: data ?? null });
}
