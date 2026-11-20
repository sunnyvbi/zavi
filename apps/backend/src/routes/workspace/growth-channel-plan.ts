
import type { Request, Response } from "express";
import { CHANNELS, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { clearCgoPauseReasons } from "@/services/growth/goal-owner";

const KNOWN_CHANNEL_SLUGS: ReadonlySet<string> = new Set(CHANNELS.map((c) => c.slug));

export async function postGrowthChannelPlan(
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

  const allowed = await requireTenantRole(auth, ["owner", "admin"], res);
  if (!allowed) return;

  const slug = String(req.params.slug ?? "").trim();
  if (!KNOWN_CHANNEL_SLUGS.has(slug)) {
    res.status(400).json({
      error: { code: "unknown_channel", message: "That is not a channel." },
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.in_plan !== "boolean") {
    res.status(400).json({
      error: { code: "bad_request", message: "in_plan must be true or false." },
    });
    return;
  }
  if (body.in_plan && RETIRED_CHANNEL_SLUGS.has(slug)) {
    res.status(400).json({
      error: { code: "channel_retired", message: "Zavi no longer runs this channel." },
    });
    return;
  }

  try {
    const { data, error } = await tenantRpc(
      asTenantId(auth.tenant_id),
      "set_channel_in_plan",
      { p_channel_slug: slug, p_in_plan: body.in_plan, p_actor_user_id: auth.user_id },
    );

    if (error) {
      res.status(500).json({
        error: { code: "write_failed", message: error.message },
      });
      return;
    }

    if (data === "already_in_plan") {
      res.json({ channel_slug: slug, in_plan: true, set_by: "plan" });
      return;
    }

    const outcome =
      data === "stopped"
        ? { in_plan: false, set_by: "founder_stopped" as const }
        : data === "restored_plan"
          ? { in_plan: true, set_by: "plan" as const }
          : data === "restored_founder"
            ? { in_plan: true, set_by: "founder" as const }
            : data === "ok"
              ? { in_plan: body.in_plan, set_by: "founder" as const }
              : null;

    if (!outcome) {
      res.status(500).json({
        error: {
          code: "write_unconfirmed",
          message: "The change did not save. Try again.",
        },
      });
      return;
    }

    await clearCgoPauseReasons(auth.tenant_id, slug);
    res.json({ channel_slug: slug, ...outcome });
  } catch (e) {
    res.status(500).json({
      error: { code: "write_failed", message: (e as Error).message },
    });
  }
}
