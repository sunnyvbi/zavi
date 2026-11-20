
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { syncActiveTenant } from "@/services/tenants/active-tenant";
import {
  sanitizeAppSlug,
  serverIdForApp,
  connectorMetadataSlug,
} from "@/services/connectors/pipedream/slug";
import {
  createConnectToken,
  verifyAccountOwned,
  resolveConnectedAccount,
  deleteConnectedAccount,
  listApps,
  appExists,
  buildPipedreamMcpUrl,
} from "@/services/connectors/pipedream/api";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function backendPublicUrl(): string {
  const base = process.env.BACKEND_PUBLIC_URL?.trim();
  if (!base) {
    throw new Error("BACKEND_PUBLIC_URL must be set so Pipedream can reach the /return callback.");
  }
  return base.replace(/\/$/, "");
}

function webOrigin(): string {
  return (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
}

function resolveApp(req: Request): string | null {
  return sanitizeAppSlug(String(req.params.app ?? ""));
}

const PIPEDREAM_CLOSED: boolean = true;

function answerPipedreamClosed(res: Response): void {
  res.status(410).json({
    error: { code: "provider_switched", message: "This app now connects through Settings → Integrations." },
  });
}

export async function pipedreamApps(req: Request, res: Response): Promise<void> {
  if (PIPEDREAM_CLOSED) return answerPipedreamClosed(res);
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(100, Math.trunc(rawLimit))
    : undefined;
  if (cursor !== undefined && !/^[A-Za-z0-9_=-]+$/.test(cursor)) {
    res.status(400).json({ error: { code: "invalid_cursor", message: "malformed cursor" } });
    return;
  }
  try {
    const { apps, next_cursor } = await listApps({ q, cursor, limit });
    res.status(200).json({ apps, next_cursor });
  } catch (e) {
    const msg = (e as Error).message;
    if (cursor !== undefined && /HTTP 4\d\d/.test(msg)) {
      res.status(400).json({ error: { code: "invalid_cursor", message: "invalid or expired cursor" } });
      return;
    }
    res.status(502).json({ error: { code: "pipedream_apps_failed", message: msg } });
  }
}

export async function pipedreamConnectStart(req: Request, res: Response): Promise<void> {
  if (PIPEDREAM_CLOSED) return answerPipedreamClosed(res);
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const app = resolveApp(req);
  if (!app) {
    res.status(404).json({ error: { code: "unknown_app", message: "invalid pipedream app slug" } });
    return;
  }

  try {
    if (!(await appExists(app))) {
      res.status(404).json({ error: { code: "unknown_app", message: `no pipedream app "${app}"` } });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: { code: "pipedream_apps_failed", message: (e as Error).message } });
    return;
  }

  const rawState = crypto.randomBytes(32).toString("base64url");
  const { error: stateErr } = await serviceClient().rpc("mint_oauth_state", {
    p_provider: `pipedream:${app}`,
    p_tenant_id: auth.tenant_id,
    p_user_id: auth.user_id,
    p_state_hash: sha256Hex(rawState),
    p_ttl_seconds: 600,
  });
  if (stateErr) {
    res.status(500).json({ error: { code: "mint_state_failed", message: stateErr.message } });
    return;
  }

  const ret = `${backendPublicUrl()}/api/connectors/pipedream/${encodeURIComponent(app)}/return?state=${encodeURIComponent(rawState)}`;
  const errRet = `${webOrigin()}/workspace?tab=settings&pipedream_${encodeURIComponent(app)}=error`;
  try {
    const token = await createConnectToken({
      external_user_id: auth.tenant_id,
      app_slug: app,
      success_redirect_uri: ret,
      error_redirect_uri: errRet,
    });
    const base = token.connect_link_url;
    const connectLinkUrl = base
      ? `${base}${base.includes("?") ? "&" : "?"}app=${encodeURIComponent(app)}`
      : null;
    res.status(200).json({
      connect_token: token.connect_token,
      connect_link_url: connectLinkUrl,
      app,
    });
  } catch (e) {
    res.status(502).json({ error: { code: "pipedream_connect_failed", message: (e as Error).message } });
  }
}

export async function pipedreamReturn(req: Request, res: Response): Promise<void> {
  if (PIPEDREAM_CLOSED) return answerPipedreamClosed(res);
  const app = resolveApp(req);
  if (!app) {
    res.status(404).json({ error: { code: "unknown_app", message: "invalid pipedream app slug" } });
    return;
  }

  const rawState = String(req.query.state ?? "");
  if (!rawState) {
    res.status(400).json({ error: { code: "missing_params", message: "state required" } });
    return;
  }
  const claimedAccountId = String(req.query.account_id ?? "").trim();

  const { data: stateRows, error: stateErr } = await serviceClient().rpc("consume_oauth_state", {
    p_provider: `pipedream:${app}`,
    p_state_hash: sha256Hex(rawState),
  });
  const stateRow = (stateRows as Array<{ tenant_id: string; user_id: string }> | null)?.[0];
  if (stateErr || !stateRow) {
    res.status(403).json({ error: { code: "bad_state", message: "invalid or expired state" } });
    return;
  }

  let accountId: string;
  try {
    if (claimedAccountId) {
      const owned = await verifyAccountOwned({
        external_user_id: stateRow.tenant_id,
        app_slug: app,
        account_id: claimedAccountId,
      });
      if (!owned) {
        res
          .status(403)
          .json({ error: { code: "connection_not_owned", message: "account not active for this tenant" } });
        return;
      }
      accountId = claimedAccountId;
    } else {
      const resolved = await resolveConnectedAccount({
        external_user_id: stateRow.tenant_id,
        app_slug: app,
      });
      if (resolved.status === "none") {
        res.status(409).json({
          error: {
            code: "no_connected_account",
            message: `no active ${app} account for this tenant. Try connecting again`,
          },
        });
        return;
      }
      if (resolved.status === "ambiguous") {
        res.status(409).json({
          error: {
            code: "ambiguous_connected_account",
            message: `found ${resolved.count} ${app} accounts and cannot tell which one you just connected. Disconnect ${app} and connect it again`,
          },
        });
        return;
      }
      accountId = resolved.account.id;
    }
  } catch (e) {
    res.status(502).json({ error: { code: "pipedream_verify_failed", message: (e as Error).message } });
    return;
  }

  const { error: rpcErr } = await serviceClient().rpc("set_pipedream_app_connection", {
    p_tenant_id: stateRow.tenant_id,
    p_app_slug: app,
    p_server_id: serverIdForApp(app),
    p_account_id: accountId,
    p_url: buildPipedreamMcpUrl(),
  });
  if (rpcErr) {
    res.status(500).json({ error: { code: "set_pipedream_app_connection_failed", message: rpcErr.message } });
    return;
  }

  void notifyFounderActivity({ event: "first_connector", tenant_id: stateRow.tenant_id, user_id: stateRow.user_id, details: { connector: app } });

  await syncActiveTenant(stateRow.user_id, stateRow.tenant_id);
  res.redirect(
    302,
    `${webOrigin()}/workspace?tab=settings&pipedream_${encodeURIComponent(app)}=connected`,
  );
}

export async function pipedreamDisconnect(req: Request, res: Response): Promise<void> {
  if (PIPEDREAM_CLOSED) return answerPipedreamClosed(res);
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const app = resolveApp(req);
  if (!app) {
    res.status(404).json({ error: { code: "unknown_app", message: "invalid pipedream app slug" } });
    return;
  }
  const slug = connectorMetadataSlug(app);

  const { data: row } = await serviceClient()
    .from("connector_metadata")
    .select("team_id")
    .eq("tenant_id", auth.tenant_id)
    .eq("slug", slug)
    .maybeSingle();
  const accountId = (row as { team_id?: string } | null)?.team_id ?? "";

  if (accountId) {
    try {
      await deleteConnectedAccount(accountId);
    } catch (e) {
      console.warn(
        `[pipedream/disconnect] upstream delete soft-failed (${(e as Error).message}); clearing local row anyway.`,
      );
    }
  }

  const { error: srvErr } = await serviceClient()
    .from("tenant_mcp_servers")
    .update({ enabled: false })
    .eq("tenant_id", auth.tenant_id)
    .eq("server_id", serverIdForApp(app));
  const { error: metaErr } = await serviceClient()
    .from("connector_metadata")
    .delete()
    .eq("tenant_id", auth.tenant_id)
    .eq("slug", slug);
  if (srvErr || metaErr) {
    res.status(500).json({
      error: { code: "row_delete_failed", message: (srvErr ?? metaErr)?.message ?? "unknown" },
    });
    return;
  }

  res.status(200).json({ ok: true });
}
