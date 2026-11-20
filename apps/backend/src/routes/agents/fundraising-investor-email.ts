
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient, serverClientFromBearer } from "@/services/supabase";
import { fundraisingPipelineEnabled } from "@/services/fundraising/flag";

const Body = z
  .object({
    email: z
      .string()
      .trim()
      .pipe(z.union([z.literal(""), z.string().email()])),
    identity_key: z.string().min(1).max(600).optional(),
    investor_id: z.string().uuid().optional(),
  })
  .refine((b) => Boolean(b.identity_key) !== Boolean(b.investor_id), {
    message: "exactly one of identity_key or investor_id is required",
  });

type ResolvedRow = {
  id: string;
  firm: string | null;
  name: string | null;
  identity_key: string | null;
};

export async function fundraisingSetInvestorEmail(
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
  let row: ResolvedRow | null = null;
  try {
    let q = sb
      .from("fundraising_investor")
      .select("id, firm, name, identity_key")
      .eq("tenant_id", auth.tenant_id);
    q = body.investor_id
      ? q.eq("id", body.investor_id)
      : q.eq("identity_key", body.identity_key!);
    const { data, error } = await q.limit(1).maybeSingle<ResolvedRow>();
    if (error) throw error;
    row = data ?? null;
  } catch {
    res
      .status(500)
      .json({ error: { code: "internal", message: "lookup failed" } });
    return;
  }

  if (!row) {
    res.status(404).json({
      error: { code: "not_found", message: "investor not found for this tenant" },
    });
    return;
  }

  const trimmed = body.email.trim().toLowerCase();
  const nextEmail = trimmed.length > 0 ? trimmed : null;

  try {
    const { error } = await serviceClient().rpc(
      "fundraising_set_investor_email",
      {
        p_tenant_id: auth.tenant_id,
        p_investor_id: row.id,
        p_email: nextEmail,
      },
    );
    if (error) throw error;
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("email already assigned to another investor")) {
      res.status(409).json({
        error: {
          code: "email_conflict",
          message: "That email is already assigned to another investor.",
        },
      });
      return;
    }
    if (msg.includes("investor not found for tenant")) {
      res.status(404).json({
        error: {
          code: "not_found",
          message: "investor not found for this tenant",
        },
      });
      return;
    }
    res.status(500).json({
      error: { code: "internal", message: msg },
    });
    return;
  }

  console.log(
    `[fundraising investor-email] tenant set email for investor=${row.id} (cleared=${nextEmail === null})`,
  );

  res
    .status(200)
    .json({ ok: true, investor_id: row.id, email: nextEmail });
}
