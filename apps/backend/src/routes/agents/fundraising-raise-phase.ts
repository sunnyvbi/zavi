
import type { Request, Response } from "express";
import { z } from "zod";
import { serviceClient } from "@/services/supabase";
import { RAISE_PHASES } from "@/services/fundraising/raise-resolver";
import { gateRaise } from "./fundraising-raise-gate";

const Body = z.object({
  phase: z.enum(RAISE_PHASES),
});

export async function fundraisingSetRaisePhase(
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

  const gated = await gateRaise(req, res);
  if (!gated) return;

  try {
    const { error } = await serviceClient().rpc("fundraising_set_raise_phase", {
      p_tenant_id: gated.tenant_id,
      p_phase: body.phase,
    });
    if (error) throw error;
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "internal", message: (e as Error).message } });
    return;
  }

  res.status(200).json({ ok: true, phase: body.phase });
}
