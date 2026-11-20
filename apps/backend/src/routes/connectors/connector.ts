
import { recordConnectorEvent } from "@/services/connectors/core/connector-events";
import type { Request, Response } from "express";
import { handleConnectorAccountSwap } from "@/services/connectors/core/token";
import crypto from "node:crypto";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { loadTenantRole, loadTenantRoleFor } from "@/services/auth/tenant-role";
import { sendConnectorAdminOnly } from "@/services/auth/viewer";
import { serviceClient } from "@/services/supabase";
import { serverClientFromBearer } from "@/services/supabase";
import { getSecret } from "@/services/secrets/vault";
import { syncActiveTenant } from "@/services/tenants/active-tenant";
import { getConnector, isKnownConnector } from "@/services/connectors/core/registry";
import type { ConnectorOAuth } from "@/services/connectors/core/types";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

function webOrigin(): string {
  return (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function callbackUrl(slug: string): string {
  const base = process.env.BACKEND_PUBLIC_URL;
  if (!base) {
    throw new Error(
      "BACKEND_PUBLIC_URL must be set so the OAuth provider can reach the callback.",
    );
  }
  return `${base.replace(/\/$/, "")}/api/connectors/${slug}/callback`;
}

const RETURN_PAGE_RE = /^\/workspace(?:\/[A-Za-z0-9-]+)?\/?$/;
const RETURN_BASE = "https://workspace.local";

export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(raw, RETURN_BASE);
  } catch {
    return null;
  }
  if (url.origin !== RETURN_BASE || !RETURN_PAGE_RE.test(url.pathname)) return null;
  if (url.searchParams.get("tab") === "settings") return null;
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  return normalized.length > 512 ? null : normalized;
}

export function stateWithReturn(random: string, returnPath: string | null): string {
  return returnPath ? `${random}.${Buffer.from(returnPath, "utf8").toString("base64url")}` : random;
}

function returnFromState(rawState: string): string | null {
  const dot = rawState.indexOf(".");
  if (dot < 0) return null;
  return safeReturnPath(Buffer.from(rawState.slice(dot + 1), "base64url").toString("utf8"));
}

function connectedPath(slug: string, rawState: string): string {
  const back = returnFromState(rawState);
  if (!back) return `/workspace?tab=settings&${slug}=connected`;
  const url = new URL(back, RETURN_BASE);
  url.searchParams.set(slug, "connected");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function connectedLanding(slug: string, rawState: string): string {
  return `${webOrigin()}${connectedPath(slug, rawState)}`;
}

function signInNotFinishedLanding(slug: string): string {
  const failed = new URLSearchParams({ tab: "settings", connect_error: "permission_denied", provider: slug });
  return `${webOrigin()}/workspace?${failed.toString()}`;
}

function wantsJson(req: Request): boolean {
  return String(req.headers["accept"] ?? "").includes("application/json");
}

async function mayChangeConnection(auth: AuthedRequest, res: Response): Promise<boolean> {
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({
      error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to connect or change accounts." },
    });
    return false;
  }
  let role: string | null;
  try {
    role = await loadTenantRole(auth);
  } catch {
    res.status(503).json({
      error: { code: "authorization_unavailable", message: "Zavi could not check your role in this workspace. Try again in a moment." },
    });
    return false;
  }
  if (role !== "owner" && role !== "admin") {
    sendConnectorAdminOnly(res);
    return false;
  }
  return true;
}

export async function connectorStart(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.connector ?? "");
  if (!isKnownConnector(slug)) {
    res.status(404).json({
      error: { code: "unknown_connector", message: `No connector "${slug}".` },
    });
    return;
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await mayChangeConnection(auth, res))) return;

  const rawState = stateWithReturn(
    crypto.randomBytes(32).toString("base64url"),
    safeReturnPath(req.query?.return_to),
  );
  const stateHash = sha256Hex(rawState);

  const { error } = await serviceClient().rpc("mint_oauth_state", {
    p_provider: slug,
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
    const connector = getConnector(slug)!;
    const url = connector.authorizeUrl(rawState, callbackUrl(slug));
    if (wantsJson(req)) {
      res.json({ oauth_url: url });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    console.error("connector_start_misconfigured", {
      slug,
      tenant_id: auth.tenant_id,
      detail: (e as Error).message,
    });
    res.status(503).json({
      error: {
        code: "connector_misconfigured",
        message:
          "This connector isn’t available yet. Zavi hasn’t finished setting it up; email support@zaviagent.com if you need it turned on.",
      },
    });
  }
}

export async function connectorCallback(
  req: Request,
  res: Response,
): Promise<void> {
  const slug = String(req.params.connector ?? "");
  if (!isKnownConnector(slug)) {
    res.status(404).json({
      error: { code: "unknown_connector", message: `No connector "${slug}".` },
    });
    return;
  }
  const codeParam = getConnector(slug)?.codeParam ?? "code";
  const code = String(req.query[codeParam] ?? "");
  const rawState = String(req.query.state ?? "");
  if (!code && (rawState || req.query.error)) {
    res.redirect(302, signInNotFinishedLanding(slug));
    return;
  }
  if (!code || !rawState) {
    res.status(400).json({
      error: { code: "missing_params", message: "OAuth did not return code+state." },
    });
    return;
  }

  const connector = getConnector(slug)!;
  if (connector.bindCallbackToSession) {
    const finish = new URLSearchParams({ connector: slug, code, state: rawState });
    res.redirect(302, `${webOrigin()}/connectors/finish#${finish.toString()}`);
    return;
  }

  const tenantUser = await consumeState(slug, rawState, res, true);
  if (!tenantUser) return;
  const role = await loadTenantRoleFor(tenantUser.user_id, tenantUser.tenant_id).catch(() => null);
  if (role !== "owner" && role !== "admin") {
    res.redirect(302, signInNotFinishedLanding(slug));
    return;
  }
  const landing = await storeConnection(slug, connector, code, rawState, tenantUser, res);
  if (landing) res.redirect(302, `${webOrigin()}${landing}`);
}

export async function connectorComplete(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.connector ?? "");
  const connector = isKnownConnector(slug) ? getConnector(slug) : null;
  if (!connector?.bindCallbackToSession) {
    res.status(404).json({
      error: { code: "unknown_connector", message: `No connector "${slug}".` },
    });
    return;
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await mayChangeConnection(auth, res))) return;
  const body = (req.body ?? {}) as { code?: unknown; state?: unknown };
  const code = typeof body.code === "string" && body.code.length <= 4096 ? body.code : "";
  const rawState = typeof body.state === "string" && body.state.length <= 2048 ? body.state : "";
  if (!code || !rawState) {
    res.status(400).json({
      error: { code: "missing_params", message: "OAuth did not return code+state." },
    });
    return;
  }

  const mismatch = () => {
    console.warn("connector_complete_session_mismatch", { slug, tenant_id: auth.tenant_id });
    res.status(403).json({
      error: {
        code: "state_session_mismatch",
        message: "This sign-in was started by another person or workspace. Nothing was connected. Start the connection again from your own workspace.",
      },
    });
  };
  const started = await serviceClient()
    .from("oauth_states")
    .select("tenant_id,user_id")
    .eq("provider", slug)
    .eq("state_hash", sha256Hex(rawState))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (started.error) {
    res.status(500).json({
      error: { code: "state_consume_failed", message: "The sign-in could not be checked. Try again." },
    });
    return;
  }
  const owner = started.data as { tenant_id: string; user_id: string } | null;
  if (!owner) {
    res.status(403).json({
      error: { code: "invalid_state", message: "OAuth state invalid, expired, or replayed." },
    });
    return;
  }
  if (owner.user_id !== auth.user_id || owner.tenant_id !== auth.tenant_id) return mismatch();
  const tenantUser = await consumeState(slug, rawState, res);
  if (!tenantUser) return;
  if (tenantUser.user_id !== auth.user_id || tenantUser.tenant_id !== auth.tenant_id) return mismatch();
  const landing = await storeConnection(slug, connector, code, rawState, tenantUser, res);
  if (landing) res.json({ ok: true, redirect: landing });
}

const SIGN_IN_NOT_FINISHED = "The sign-in did not finish, so nothing was connected. Start the connection again from your workspace.";

async function consumeState(
  slug: string,
  rawState: string,
  res: Response,
  toBrowser = false,
): Promise<{ tenant_id: string; user_id: string } | null> {
  const { data: rows, error: cErr } = await serviceClient().rpc(
    "consume_oauth_state",
    { p_provider: slug, p_state_hash: sha256Hex(rawState) },
  );
  if (cErr && toBrowser) {
    console.warn("connector_state_consume_failed", { slug, detail: cErr.message });
    res.redirect(302, signInNotFinishedLanding(slug));
    return null;
  }
  if (cErr) {
    res.status(500).json({
      error: { code: "state_consume_failed", message: cErr.message },
    });
    return null;
  }
  const tenantUser = (
    rows as Array<{ tenant_id: string; user_id: string }> | null
  )?.[0];
  if (!tenantUser && toBrowser) {
    res.redirect(302, signInNotFinishedLanding(slug));
    return null;
  }
  if (!tenantUser) {
    res.status(403).json({
      error: { code: "invalid_state", message: "OAuth state invalid, expired, or replayed." },
    });
    return null;
  }
  return tenantUser;
}

async function storeConnection(
  slug: string,
  connector: ConnectorOAuth,
  code: string,
  rawState: string,
  tenantUser: { tenant_id: string; user_id: string },
  res: Response,
): Promise<string | null> {
  try {
    const exch = await connector.exchangeCode(code, callbackUrl(slug), rawState);
    const { data: priorRow } = await serviceClient()
      .from("connector_metadata")
      .select("team_id")
      .eq("tenant_id", tenantUser.tenant_id)
      .eq("slug", slug)
      .maybeSingle();
    const priorTeamId = (priorRow as { team_id?: string | null } | null)?.team_id ?? null;

    const { error: setErr } = await serviceClient().rpc(
      "set_connector_connection",
      {
        p_tenant_id: tenantUser.tenant_id,
        p_slug: slug,
        p_server_id: connector.serverId,
        p_secrets: exch.secrets,
        p_expires_at: exch.expiresInSec
          ? new Date(Date.now() + exch.expiresInSec * 1000).toISOString()
          : null,
        p_team_id: exch.metadata.team_id,
        p_team_name: exch.metadata.team_name,
        p_scopes: exch.metadata.scopes,
      },
    );
    if (setErr) {
      res.status(500).json({
        error: { code: "set_connector_connection_failed", message: connector.bindCallbackToSession ? SIGN_IN_NOT_FINISHED : setErr.message },
      });
      return null;
    }

    if (priorTeamId && exch.metadata.team_id && priorTeamId !== exch.metadata.team_id) {
      await handleConnectorAccountSwap(tenantUser.tenant_id, slug);
    }
    if (connector.onConnect) {
      await connector.onConnect(tenantUser.tenant_id).catch((e: unknown) => {
        console.error("connector_on_connect_failed", { slug, tenant_id: tenantUser.tenant_id, detail: (e as Error).message });
      });
    }
    await recordConnectorEvent({ tenant_id: tenantUser.tenant_id, slug, action: "connect", actor_user_id: tenantUser.user_id, via: "oauth_callback" });
    void notifyFounderActivity({ event: "first_connector", tenant_id: tenantUser.tenant_id, user_id: tenantUser.user_id, details: { connector: slug } });
    await syncActiveTenant(tenantUser.user_id, tenantUser.tenant_id);
    return connectedPath(slug, rawState);
  } catch (e) {
    console.warn("connector_exchange_failed", { slug, tenant_id: tenantUser.tenant_id, detail: (e as Error).message });
    res.status(502).json({
      error: { code: "connector_exchange_failed", message: connector.bindCallbackToSession ? SIGN_IN_NOT_FINISHED : (e as Error).message },
    });
    return null;
  }
}

export async function connectorDisconnect(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.connector ?? "");
  const connector = getConnector(slug);
  if (!connector) {
    res.status(404).json({
      error: { code: "unknown_connector", message: `No connector "${slug}".` },
    });
    return;
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const vendorToken = connector.revokeToken
    ? await readTokenForRevoke(slug, auth.tenant_id)
    : null;

  const { error } = await serverClientFromBearer(auth.access_token).rpc(
    "disconnect_connector",
    {
      p_tenant_id: auth.tenant_id,
      p_slug: slug,
      p_server_id: connector.serverId,
    },
  );
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") {
      res.status(403).json({ error: { code: "not_admin", message: error.message } });
      return;
    }
    if (code === "PGRST202" || code === "42883") {
      res.status(500).json({
        error: {
          code: "rpc_missing",
          message:
            "Disconnect is temporarily unavailable: a pending database migration has not been applied.",
        },
      });
      return;
    }
    console.error("connector_disconnect_failed", {
      slug,
      tenant_id: auth.tenant_id,
      error_code: code,
    });
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  await handleConnectorAccountSwap(auth.tenant_id, slug);
  if (connector.onDisconnect) {
    await connector.onDisconnect(auth.tenant_id).catch((e: unknown) => {
      console.error("connector_on_disconnect_failed", { slug, tenant_id: auth.tenant_id, detail: (e as Error).message });
    });
  }

  const revoked =
    connector.revokeToken && vendorToken
      ? await revokeAtVendor(connector.revokeToken, slug, vendorToken)
      : false;

  res.json({ ok: true, revoked });
}

async function readTokenForRevoke(slug: string, tenantId: string): Promise<string | null> {
  try {
    return await getSecret(tenantId, `${slug}.access_token`);
  } catch (e) {
    console.warn("connector_revoke_token_read_failed", {
      slug,
      message: (e as Error).message,
    });
    return null;
  }
}

async function revokeAtVendor(
  revoke: NonNullable<ConnectorOAuth["revokeToken"]>,
  slug: string,
  accessToken: string,
): Promise<boolean> {
  try {
    await revoke(accessToken);
    return true;
  } catch (e) {
    console.warn("connector_revoke_failed", { slug, message: (e as Error).message });
    return false;
  }
}
