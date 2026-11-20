
import type { Request, Response } from "express";
import { CHANNELS } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { checkAgentTier, planUpgradeErrorBody } from "@/services/agents/entitlement";

const KNOWN_CHANNEL_SLUGS: ReadonlySet<string> = new Set(CHANNELS.map((c) => c.slug));
const EXECUTOR_BY_SLUG: ReadonlyMap<string, string> = new Map(CHANNELS.map((c) => [c.slug, c.executor]));

export async function postGrowthChannelAutorun(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({
      error: {
        code: "tenant_override_forbidden",
        message: "Not available for an overridden tenant.",
      },
    });
    return;
  }

  const revokingChatgpt = req.params.slug === "chatgpt_ads" && req.body?.autorun === false;
  const allowed = revokingChatgpt || await requireTenantRole(auth, ["owner", "admin"], res);
  if (!allowed) return;

  const slug = String(req.params.slug ?? "").trim();
  if (!KNOWN_CHANNEL_SLUGS.has(slug)) {
    res.status(400).json({
      error: { code: "unknown_channel", message: "That is not a channel." },
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.autorun !== "boolean") {
    res.status(400).json({
      error: { code: "bad_request", message: "autorun must be true or false." },
    });
    return;
  }

  if (slug === "chatgpt_ads" && body.autorun && body.paid_consent !== "chatgpt-growth-v1") {
    res.status(400).json({ error: { code: "paid_consent_required", message: "Confirm ChatGPT campaign creation, launch and management under your Growth budget and prepaid wallet. This does not enable wallet refills." } });
    return;
  }

  if (body.autorun === true) {
    const executor = EXECUTOR_BY_SLUG.get(slug) ?? slug;
    try {
      const tierDecision = await checkAgentTier(auth.tenant_id, executor);
      if (!tierDecision.allowed) {
        res.status(403).json(planUpgradeErrorBody(executor, tierDecision.required_tier));
        return;
      }
    } catch (e) {
      res.status(503).json({
        error: { code: "tier_unavailable", message: "Could not check your plan. Try again." },
      });
      return;
    }
  }

  try {
    const { data, error } = await tenantRpc(
      asTenantId(auth.tenant_id),
      revokingChatgpt ? "revoke_chatgpt_autopilot" : slug === "chatgpt_ads" ? "set_chatgpt_autopilot" : "set_channel_autorun",
      revokingChatgpt ? { p_actor_user_id: auth.user_id } : slug === "chatgpt_ads" ? { p_actor_user_id: auth.user_id, p_enabled: body.autorun } : { p_channel_slug: slug, p_autorun: body.autorun },
    );

    if (error) {
      res.status(500).json({
        error: { code: "write_failed", message: error.message },
      });
      return;
    }

    if (data !== true) {
      res.status(500).json({
        error: {
          code: "write_unconfirmed",
          message: "The change did not save. Try again.",
        },
      });
      return;
    }

    res.json({ channel_slug: slug, autorun: body.autorun, set_by: "founder" });
  } catch (e) {
    res.status(500).json({
      error: { code: "write_failed", message: (e as Error).message },
    });
  }
}
