
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient, serverClientFromBearer } from "@/services/supabase";
import { fundraisingPipelineEnabled } from "@/services/fundraising/flag";

const OUTREACH_STATES = [
  "queued",
  "sent",
  "opened",
  "replied",
  "bounced",
  "unsubscribed",
  "paused",
  "completed",
] as const;

const Body = z
  .object({
    identity_key: z.string().min(1).max(600).optional(),
    investor_id: z.string().uuid().optional(),
    state: z.enum(OUTREACH_STATES),
  })
  .refine((b) => Boolean(b.identity_key) !== Boolean(b.investor_id), {
    message: "exactly one of identity_key or investor_id is required",
  });

export async function fundraisingSetOutreachState(
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

  const enabled = await fundraisingPipelineEnabled(auth.tenant_id);
  if (!enabled) {
    res.status(404).json({
      error: {
        code: "not_found",
        message: "fundraising pipeline not enabled for this tenant",
      },
    });
    return;
  }

  const sb = serverClientFromBearer(auth.access_token);
  let investorId: string | null = null;
  try {
    let q = sb
      .from("fundraising_investor")
      .select("id")
      .eq("tenant_id", auth.tenant_id);
    q = body.investor_id
      ? q.eq("id", body.investor_id)
      : q.eq("identity_key", body.identity_key!);
    const { data, error } = await q.limit(1).maybeSingle<{ id: string }>();
    if (error) throw error;
    investorId = data?.id ?? null;
  } catch {
    res
      .status(500)
      .json({ error: { code: "internal", message: "lookup failed" } });
    return;
  }

  if (!investorId) {
    res.status(404).json({
      error: { code: "not_found", message: "investor not found for this tenant" },
    });
    return;
  }

  try {
    const { error } = await serviceClient().rpc(
      "fundraising_set_outreach_state",
      {
        p_tenant_id: auth.tenant_id,
        p_investor_id: investorId,
        p_state: body.state,
      },
    );
    if (error) throw error;
  } catch (e) {
    res.status(500).json({
      error: { code: "internal", message: (e as Error).message },
    });
    return;
  }

  res.status(200).json({ ok: true, investor_id: investorId, state: body.state });
}
