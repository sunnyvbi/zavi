
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

export async function artifactsList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("extracted_artifacts")
    .select("id, kind, target_slug, rationale, proposed, status, created_at, source_event_id")
    .eq("status", "proposed")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    res.status(500).json({ error: { code: "list_failed", message: error.message } });
    return;
  }
  res.json({ artifacts: data ?? [] });
}
