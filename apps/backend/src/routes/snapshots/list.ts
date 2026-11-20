
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

export async function listSnapshots(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const provider = (req.query.provider as string | undefined) ?? null;
  const supabase = serverClientFromBearer(auth.access_token);
  let q = supabase
    .from("tenant_ad_snapshots")
    .select("id, provider, period_start, period_end, source, created_at")
    .eq("tenant_id", auth.tenant_id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (provider) q = q.eq("provider", provider);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ error: { code: "list_failed", message: error.message } });
    return;
  }
  res.json({ snapshots: data ?? [] });
}
