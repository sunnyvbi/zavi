
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import {
  botScopes,
  BOT_SCOPES_VERSION,
  grantedScopesVersion,
  missingScopes,
} from "@/services/connectors/slack/oauth";
import { inferSuggestedPurpose } from "@/services/slack/infer-workspace-purpose";
import { slackFetch } from "@/services/tools/slack/_client";

async function fetchTeamIcon(tenant_id: string, team_id: string): Promise<string | null> {
  try {
    const r = await slackFetch<{ team?: { icon?: Record<string, unknown> } }>(
      tenant_id,
      "team.info",
      { team: team_id },
      team_id,
    );
    const icon = r.team?.icon;
    if (!icon) return null;
    const url =
      icon.image_230 ?? icon.image_132 ?? icon.image_88 ?? icon.image_68 ?? icon.image_44;
    return typeof url === "string" && url.startsWith("https://") ? url : null;
  } catch {
    return null;
  }
}

type WorkspaceRow = {
  team_id: string;
  team_name: string | null;
  label: string | null;
  purpose: string | null;
  default_agent_slug: string | null;
  scopes: string[] | null;
  is_primary: boolean | null;
  connected_at: string | null;
};

export async function slackScopeStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { data, error } = await serviceClient()
      .from("slack_workspaces")
      .select(
        "team_id, team_name, label, purpose, default_agent_slug, scopes, is_primary, connected_at",
      )
      .eq("tenant_id", auth.tenant_id)
      .order("is_primary", { ascending: false })
      .order("connected_at", { ascending: true });
    if (error) {
      res.status(500).json({
        error: { code: "scope_status_read_failed", message: error.message },
      });
      return;
    }
    const rows = (data as WorkspaceRow[] | null) ?? [];

    const channelNamesByTeam = new Map<string, string[]>();
    if (rows.length > 0) {
      const { data: chans } = await serviceClient()
        .from("slack_channels")
        .select("team_id, name")
        .eq("tenant_id", auth.tenant_id)
        .limit(2000);
      for (const c of (chans ?? []) as Array<{ team_id: string | null; name: string | null }>) {
        if (!c.team_id) continue;
        const arr = channelNamesByTeam.get(c.team_id) ?? [];
        if (c.name) arr.push(c.name);
        channelNamesByTeam.set(c.team_id, arr);
      }
    }

    const icons = await Promise.all(
      rows.map((r) => fetchTeamIcon(auth.tenant_id, r.team_id)),
    );

    const workspaces = rows.map((r, i) => {
      const granted = r.scopes ?? [];
      return {
        team_id: r.team_id,
        team_name: r.team_name ?? "",
        label: r.label ?? "",
        purpose: r.purpose ?? "general",
        team_icon_url: icons[i],
        suggested_purpose: inferSuggestedPurpose(
          r.team_name,
          channelNamesByTeam.get(r.team_id) ?? [],
        ),
        default_agent_slug: r.default_agent_slug ?? null,
        granted,
        missing: missingScopes(granted),
        version_granted: grantedScopesVersion(granted),
        is_primary: r.is_primary === true,
        connected_at: r.connected_at,
      };
    });

    if (rows.length === 0) {
      res.json({
        connected: false,
        required: botScopes(),
        version_current: BOT_SCOPES_VERSION,
        workspaces: [],
      });
      return;
    }

    const primary = workspaces[0];
    res.json({
      connected: true,
      granted: primary.granted,
      required: botScopes(),
      missing: primary.missing,
      version_granted: primary.version_granted,
      version_current: BOT_SCOPES_VERSION,
      connected_at: primary.connected_at,
      workspaces,
    });
  } catch (e) {
    res.status(500).json({
      error: { code: "scope_status_failed", message: (e as Error).message },
    });
  }
}
