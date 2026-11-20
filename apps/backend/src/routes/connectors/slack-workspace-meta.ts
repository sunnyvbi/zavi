
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";

const VALID_PURPOSES = new Set(["support", "dev", "exec", "general"]);

export async function setSlackWorkspaceMetaHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as {
    team_id?: unknown;
    purpose?: unknown;
    label?: unknown;
    default_agent_slug?: unknown;
    is_primary?: unknown;
  };

  const team_id = typeof body.team_id === "string" ? body.team_id.trim() : "";
  if (!team_id) {
    res.status(400).json({
      error: { code: "missing_team_id", message: "team_id is required" },
    });
    return;
  }

  let purpose: string | null = null;
  if (body.purpose !== undefined && body.purpose !== null) {
    purpose = String(body.purpose).trim().toLowerCase();
    if (!VALID_PURPOSES.has(purpose)) {
      res.status(400).json({
        error: {
          code: "invalid_purpose",
          message: `purpose must be one of: ${[...VALID_PURPOSES].join(", ")}`,
        },
      });
      return;
    }
  }

  let label: string | null = null;
  if (body.label !== undefined && body.label !== null) {
    label = String(body.label).trim().slice(0, 80);
  }

  let default_agent_slug: string | null = null;
  if (body.default_agent_slug !== undefined && body.default_agent_slug !== null) {
    const raw = String(body.default_agent_slug).trim();
    if (raw.length > 0 && !/^[a-z0-9-]{1,64}$/.test(raw)) {
      res.status(400).json({
        error: {
          code: "invalid_default_agent_slug",
          message: "default_agent_slug must be a lowercase slug (a-z0-9-)",
        },
      });
      return;
    }
    default_agent_slug = raw;
  }

  const is_primary =
    typeof body.is_primary === "boolean" ? body.is_primary : null;

  const { data: owned } = await serviceClient()
    .from("slack_workspaces")
    .select("team_id")
    .eq("tenant_id", auth.tenant_id)
    .eq("team_id", team_id)
    .maybeSingle<{ team_id: string }>();
  if (!owned) {
    res.status(404).json({
      error: {
        code: "workspace_not_found",
        message: "No connected Slack workspace with that team_id for this tenant.",
      },
    });
    return;
  }

  const { error } = await serviceClient().rpc("set_slack_workspace_meta", {
    p_tenant_id: auth.tenant_id,
    p_team_id: team_id,
    p_purpose: purpose,
    p_label: label,
    p_default_agent_slug: default_agent_slug,
    p_is_primary: is_primary,
  });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42704") {
      res.status(404).json({
        error: { code: "workspace_not_found", message: error.message },
      });
      return;
    }
    res.status(500).json({
      error: { code: "rpc_failed", message: error.message },
    });
    return;
  }

  res.status(200).json({ ok: true, team_id });
}
