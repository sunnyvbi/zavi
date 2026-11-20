
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantRpc } from "@/services/tenant-client";

const Body = z.object({
  done: z.boolean(),
});

export async function fundraisingSetReviewDone(
  req: Request,
  res: Response,
): Promise<void> {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body ?? {});
  } catch (e) {
    res
      .status(400)
      .json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { error } = await tenantRpc(
      asTenantId(auth.tenant_id),
      "fundraising_set_review_done",
      { p_done: body.done },
    );
    if (error) throw error;
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "internal", message: (e as Error).message } });
    return;
  }

  res.status(200).json({ ok: true, done: body.done });
}
