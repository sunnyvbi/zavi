import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { loadTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantRpc, tenantClient } from "@/services/tenant-client";
import { authorizeWrite } from "./ad-budget";
import {
  businessPolicySchema,
  readBusinessPolicy,
  recommendBusinessPolicy,
} from "@/services/growth/business-control-policy";
import {
  readBusinessInventory,
  businessEvidence,
} from "@/services/growth/business-control-runtime";
import {
  readControlledObjects,
  readExperiments,
  registerExperiment,
} from "@/services/growth/experiment-controls";
import { z } from "zod";

const saveSchema = z
  .object({
    policy: businessPolicySchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();
export async function getGrowthControls(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const [policy, experiments, objects, role] = await Promise.all([
      readBusinessPolicy(auth.tenant_id),
      readExperiments(auth.tenant_id),
      readControlledObjects(auth.tenant_id),
      loadTenantRole(auth),
    ]);
    const now = new Date();
    let recommendation = recommendBusinessPolicy([]);
    try {
      const inv = await readBusinessInventory(auth.tenant_id, now);
      recommendation = recommendBusinessPolicy(
        inv.objects.map((o) =>
          businessEvidence(
            o,
            inv.tracking[o.platform] === true,
            now,
            true,
            inv.matchesGoal,
          ),
        ),
      );
    } catch {
    }
    res.json({
      policy,
      recommendation,
      experiments,
      objects,
      can_manage: role === "owner" || role === "admin",
      limitations:
        "CPA uses platform-attributed purchases; unique new customers require customer-level attribution. Efficiency controls use purchases and purchase revenue on Meta and Google. ChatGPT supports experiment spend and duration stops. Google shared budgets and lifetime budgets require separate daily budgets. Reporting delay can cause overspend; a stop is confirmed only after a fresh platform read.",
    });
  } catch {
    res.status(503).json({
      error: { message: "Could not load business controls. Try again." },
    });
  }
}
export async function putGrowthControls(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { message: "Check the business-control values." } });
    return;
  }
  const auth = await authorizeWrite(req, res, {
    anyPlan: !parsed.data.policy.enabled,
  });
  if (!auth) return;
  try {
    const { data, error } = await tenantRpc(
      asTenantId(auth.tenant_id),
      "save_growth_business_policy",
      {
        p_actor: auth.user_id,
        p_policy: parsed.data.policy,
        p_revision: parsed.data.revision,
      },
    );
    if (error) throw new Error(error.message);
    if (data?.status === "conflict") {
      res.status(409).json({
        error: {
          message: "Someone changed these limits. Reload before saving.",
        },
      });
      return;
    }
    res.json(data);
  } catch {
    res
      .status(503)
      .json({ error: { message: "Could not save business controls." } });
  }
}
export async function postGrowthExperiment(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await authorizeWrite(req, res);
  if (!auth) return;
  try {
    res.status(201).json({
      id: await registerExperiment(auth.tenant_id, auth.user_id, req.body),
    });
  } catch (e) {
    res.status(400).json({ error: { message: (e as Error).message } });
  }
}

export async function getBusinessControlsProposal(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = z.string().uuid().safeParse(req.params.decision_id);
  if (!id.success) {
    res.status(400).json({ error: { message: "Invalid proposal." } });
    return;
  }
  try {
    const [row, policy, role] = await Promise.all([
      tenantClient(asTenantId(auth.tenant_id))
        .from("decisions")
        .select("id, body, status")
        .eq("id", id.data)
        .eq("decision_class", "growth.save_business_controls")
        .maybeSingle(),
      readBusinessPolicy(auth.tenant_id),
      loadTenantRole(auth),
    ]);
    if (row.error) throw new Error(row.error.message);
    if (!row.data) {
      res.status(404).json({ error: { message: "Proposal unavailable." } });
      return;
    }
    res.json({
      proposal: row.data,
      current_policy: policy,
      can_manage:
        !auth.tenant_overridden && (role === "owner" || role === "admin"),
    });
  } catch {
    res
      .status(503)
      .json({ error: { message: "Could not load this proposal. Try again." } });
  }
}
