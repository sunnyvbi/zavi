
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { requireAuth } from "@/services/auth/middleware";
import {
  slackOAuthStartUrl,
  exchangeCode,
  BOT_SCOPES_VERSION,
} from "@/services/connectors/slack/oauth";
import { serviceClient } from "@/services/supabase";
import { linkSlackInstaller } from "@/services/slack/resolve-member";
import { track } from "@/services/analytics/mixpanel";
import { syncActiveTenant } from "@/services/tenants/active-tenant";
import { inngest } from "@/../workers/client";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

function webOrigin(): string {
  return (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
}

function redirectSlackError(res: Response, code: string): void {
  res.redirect(
    302,
    `${webOrigin()}/workspace?tab=settings&slack_error=${encodeURIComponent(code)}`,
  );
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export async function slackStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const rawState = crypto.randomBytes(32).toString("base64url");
  const stateHash = sha256Hex(rawState);

  const { error } = await serviceClient().rpc("mint_oauth_state", {
    p_provider: "slack",
    p_tenant_id: auth.tenant_id,
    p_user_id: auth.user_id,
    p_state_hash: stateHash,
    p_ttl_seconds: 600,
  });
  if (error) {
    res.status(500).json({
      error: { code: "state_mint_failed", message: error.message },
    });
    return;
  }

  try {
    const url = slackOAuthStartUrl(rawState);
    if (wantsJson(req)) {
      res.json({ oauth_url: url });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    res.status(500).json({
      error: { code: "slack_misconfigured", message: (e as Error).message },
    });
  }
}

function wantsJson(req: Request): boolean {
  const accept = String(req.headers["accept"] ?? "");
  return accept.includes("application/json");
}

export async function slackCallback(req: Request, res: Response): Promise<void> {
  const code = String(req.query.code ?? "");
  const rawState = String(req.query.state ?? "");
  if (!code) {
    redirectSlackError(res, "missing_code");
    return;
  }
  if (!rawState) {
    redirectSlackError(res, "missing_state");
    return;
  }

  const stateHash = sha256Hex(rawState);
  const { data: rows, error: cErr } = await serviceClient().rpc(
    "consume_oauth_state",
    { p_provider: "slack", p_state_hash: stateHash },
  );
  if (cErr) {
    console.warn("[slack-callback] consume_oauth_state failed:", cErr.message);
    redirectSlackError(res, "state_consume_failed");
    return;
  }
  const tenantUser = (rows as Array<{ tenant_id: string; user_id: string }> | null)?.[0];
  if (!tenantUser) {
    redirectSlackError(res, "invalid_state");
    return;
  }
  try {
    const exch = await exchangeCode(code);
    const { error: setErr } = await serviceClient().rpc("set_slack_connection", {
      p_tenant_id: tenantUser.tenant_id,
      p_token: exch.access_token,
      p_team_id: exch.team_id,
      p_team_name: exch.team_name,
      p_scopes: exch.scope.split(",").filter(Boolean),
      p_bot_user_id: exch.bot_user_id,
    });
    if (setErr) {
      console.warn(
        "[slack-callback] set_slack_connection failed for tenant",
        tenantUser.tenant_id,
        setErr.message,
      );
      redirectSlackError(res, "save_failed");
      return;
    }
    track("connector_connected", {
      tenant_id: tenantUser.tenant_id,
      user_id: tenantUser.user_id,
      connector: "slack",
    });

    const installerLinked = await linkSlackInstaller(serviceClient(), {
      tenant_id: tenantUser.tenant_id,
      team_id: exch.team_id,
      slack_user_id: exch.authed_user_id,
      user_id: tenantUser.user_id,
    });
    if (!installerLinked && exch.authed_user_id) {
      console.warn("[slack-callback] installer identity not linked for tenant", tenantUser.tenant_id);
    }

    const { data: prevMeta } = await serviceClient()
      .from("connector_metadata")
      .select("scopes_version")
      .eq("tenant_id", tenantUser.tenant_id)
      .eq("slug", "slack")
      .maybeSingle<{ scopes_version: number | null }>();
    const previousScopesVersion = prevMeta?.scopes_version ?? 0;

    const { data: wsRow } = await serviceClient()
      .from("slack_workspaces")
      .select("is_primary")
      .eq("tenant_id", tenantUser.tenant_id)
      .eq("team_id", exch.team_id)
      .maybeSingle<{ is_primary: boolean | null }>();
    const isPrimaryWorkspace = wsRow?.is_primary === true;

    if (isPrimaryWorkspace) {
      const { error: versionErr } = await serviceClient().rpc(
        "set_connector_scopes_version",
        {
          p_tenant_id: tenantUser.tenant_id,
          p_slug: "slack",
          p_version: BOT_SCOPES_VERSION,
        },
      );
      if (versionErr) {
        console.warn(
          "set_connector_scopes_version failed for tenant",
          tenantUser.tenant_id,
          versionErr.message,
        );
      }
    }

    const W2_REQUIRED = ["mpim:read", "mpim:history"];
    const grantedScopes = exch.scope.split(",").filter(Boolean);
    const w2Granted = W2_REQUIRED.every((s) => grantedScopes.includes(s));
    if (w2Granted && previousScopesVersion < 4) {
      const { error: auditErr } = await serviceClient()
        .from("staff_audit_log")
        .insert({
          actor_user_id: tenantUser.user_id,
          actor_email: "",
          action: "slack_w2_consent",
          target_table: "connector_metadata",
          target_id: tenantUser.tenant_id,
          tenant_id: tenantUser.tenant_id,
          meta: {
            scopes_granted: grantedScopes,
            consent_text_version: 1,
            previous_scopes_version: previousScopesVersion,
            new_scopes_version: BOT_SCOPES_VERSION,
            slack_team_id: exch.team_id,
            slack_team_name: exch.team_name,
            bot_user_id: exch.bot_user_id,
          },
        });
      if (auditErr) {
        console.warn(
          "[slack-w2-consent-audit] insert failed for tenant",
          tenantUser.tenant_id,
          auditErr.message,
        );
      }
    }

    try {
      await inngest.send({
        name: "slack.oauth.completed",
        data: {
          tenant_id: tenantUser.tenant_id,
          team_id: exch.team_id,
          scopes_version: BOT_SCOPES_VERSION,
        },
      });
    } catch (e) {
      console.warn(
        "inngest slack.oauth.completed emit failed for tenant",
        tenantUser.tenant_id,
        (e as Error).message,
      );
    }

    try {
      await inngest.send({
        name: "slack.workspace.intro",
        data: {
          tenant_id: tenantUser.tenant_id,
          team_id: exch.team_id,
          installer_slack_user_id: exch.authed_user_id || null,
        },
      });
    } catch (e) {
      console.warn(
        "inngest slack.workspace.intro emit failed for tenant",
        tenantUser.tenant_id,
        (e as Error).message,
      );
    }

    void notifyFounderActivity({ event: "first_connector", tenant_id: tenantUser.tenant_id, user_id: tenantUser.user_id, details: { connector: "slack" } });

    await syncActiveTenant(tenantUser.user_id, tenantUser.tenant_id);
    res.redirect(
      302,
      `${webOrigin()}/workspace?tab=settings&slack=connected&team=${encodeURIComponent(exch.team_id)}`,
    );
  } catch (e) {
    console.warn(
      "[slack-callback] exchange/flow failed:",
      (e as Error).message,
    );
    redirectSlackError(res, "exchange_failed");
  }
}
