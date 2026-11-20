
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export const listQuerySchema = z
  .object({
    status: z.enum(["pending", "armed", "regressed"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const armBodySchema = z
  .object({
    signature: z.string().regex(/^[0-9a-f]{64}$/),
    armed_pr_url: z.string().url().max(300).optional(),
  })
  .strict();

export async function staffRegressionList(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);
  let q: z.infer<typeof listQuerySchema>;
  try {
    q = listQuerySchema.parse(req.query);
  } catch (e) {
    res.status(400).json({ error: { code: "invalid_query", message: (e as Error).message } });
    return;
  }

  let query = serviceClient()
    .from("regression_signatures")
    .select(
      "signature, status, sig_version, code_class, agent_slug, engine, armed_by, armed_at, armed_pr_url, regressed_at, first_seen, last_seen",
    )
    .order("last_seen", { ascending: false })
    .limit(q.limit);
  if (q.status) query = query.eq("status", q.status);

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: { code: "list_failed", message: error.message } });
    return;
  }
  res.json({ signatures: data ?? [] });
}

export async function staffRegressionArm(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  let body: z.infer<typeof armBodySchema>;
  try {
    body = armBodySchema.parse(req.body);
  } catch (e) {
    res.status(400).json({ error: { code: "invalid_body", message: (e as Error).message } });
    return;
  }

  const { data: armed, error } = await serviceClient().rpc("arm_regression_signature", {
    p_signature: body.signature,
    p_armed_by: staff.email,
    p_armed_pr_url: body.armed_pr_url ?? null,
  });
  if (error) {
    res.status(500).json({ error: { code: "arm_failed", message: error.message } });
    return;
  }
  if (armed !== true) {
    res.status(409).json({
      error: {
        code: "not_armable",
        message: "signature not found or not in 'pending' state (already armed/regressed?)",
      },
    });
    return;
  }
  res.json({ armed: true, signature: body.signature, armed_by: staff.email });
}
