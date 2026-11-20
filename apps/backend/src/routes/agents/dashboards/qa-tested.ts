
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

const Body = z.object({ tested: z.boolean() });

export async function qaSetTestCaseTested(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const caseId = req.params.id;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body);
  } catch (e) {
    res
      .status(400)
      .json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("qa_set_test_case_tested", {
    p_case_id: caseId,
    p_tested: body.tested,
  });
  if (error) {
    const notFound = error.code === "P0002";
    res.status(notFound ? 404 : 500).json({
      error: {
        code: notFound ? "not_found" : "toggle_failed",
        message: error.message,
      },
    });
    return;
  }

  res.json({
    ok: true,
    id: caseId,
    manual_tested_at: data ? String(data) : null,
  });
}
