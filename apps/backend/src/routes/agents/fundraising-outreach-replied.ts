
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";

const Body = z.object({
  investor_id: z.string().min(1).max(600),
  replied: z.boolean(),
});

export async function fundraisingMarkOutreachReplied(
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
    const { error } = await serviceClient().rpc(
      "fundraising_mark_outreach_replied",
      {
        p_tenant_id: auth.tenant_id,
        p_investor_id: body.investor_id,
        p_replied: body.replied,
      },
    );
    if (error) throw error;
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "internal", message: (e as Error).message } });
    return;
  }

  res
    .status(200)
    .json({ ok: true, investor_id: body.investor_id, replied: body.replied });
}
