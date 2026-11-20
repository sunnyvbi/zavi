
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

export async function artifactsApply(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const supabase = serverClientFromBearer(auth.access_token);

  const { data: artifact, error: readErr } = await supabase
    .from("extracted_artifacts")
    .select("kind, target_slug")
    .eq("id", req.params.id)
    .maybeSingle();
  if (readErr) {
    res.status(500).json({ error: { code: "artifact_read_failed", message: readErr.message } });
    return;
  }
  const row = artifact as { kind?: string; target_slug?: string } | null;
  if (!row) {
    res.status(404).json({ error: { code: "not_found", message: "artifact not found" } });
    return;
  }
  if (row.kind === "memory_update" && row.target_slug === "company") {
    res.status(409).json({
      error: {
        code: "company_is_a_projection",
        message:
          "The company brief is generated from your company record, so it cannot be applied as a note. " +
          "To reword the description itself, tell an agent in chat what is wrong and confirm the change it " +
          "shows you. To fix a specific fact (what you sell, who you serve, competitors, markets), edit it " +
          "on the Company Details card. Either way the brief updates with it.",
      },
    });
    return;
  }

  const { error } = await supabase.rpc("apply_extracted_artifact", {
    p_artifact_id: req.params.id,
  });
  if (error) {
    res.status(500).json({ error: { code: "apply_failed", message: error.message } });
    return;
  }
  res.json({ ok: true });
}

export async function artifactsReject(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const supabase = serverClientFromBearer(auth.access_token);
  const { error } = await supabase.rpc("reject_extracted_artifact", {
    p_artifact_id: req.params.id,
  });
  if (error) {
    res.status(500).json({ error: { code: "reject_failed", message: error.message } });
    return;
  }
  res.json({ ok: true });
}
