
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { requireAuth } from "@/services/auth/middleware";
import {
  getInstallation,
  githubAppInstallStartUrl,
  listInstallationRepos,
} from "@/services/connectors/github/oauth";
import { serviceClient } from "@/services/supabase";
import { track } from "@/services/analytics/mixpanel";
import { serverClientFromBearer } from "@/services/supabase";
import { UMBRELLA_CONNECTOR_ACCOUNT_LOGIN } from "@/services/sandbox/repo-access-gate";
import { syncActiveTenant } from "@/services/tenants/active-tenant";
import { seedPendingProfiles } from "@/services/sandbox/repo-profiles";
import { inngest } from "@/../workers/client";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";
import { connectedLanding, safeReturnPath, stateWithReturn } from "./connector";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export async function githubStart(req: Request, res: Response): Promise<void> {
  if (req.query.installation_id) {
    await githubCallback(req, res);
    return;
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const rawState = stateWithReturn(
    crypto.randomBytes(32).toString("base64url"),
    safeReturnPath(req.query?.return_to),
  );
  const stateHash = sha256Hex(rawState);

  const { error } = await serviceClient().rpc("mint_oauth_state", {
    p_provider: "github",
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
    const url = await githubAppInstallStartUrl(rawState);
    if (wantsJson(req)) {
      res.json({ oauth_url: url });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    res.status(500).json({
      error: { code: "github_misconfigured", message: (e as Error).message },
    });
  }
}

function wantsJson(req: Request): boolean {
  const accept = String(req.headers["accept"] ?? "");
  return accept.includes("application/json");
}

export async function githubCallback(req: Request, res: Response): Promise<void> {
  const installation_id_str = String(req.query.installation_id ?? "");
  const setup_action = String(req.query.setup_action ?? "");
  const rawState = String(req.query.state ?? "");

  if (!installation_id_str) {
    res.status(400).json({
      error: { code: "missing_installation_id", message: "GitHub did not return ?installation_id=" },
    });
    return;
  }
  if (!rawState) {
    res.status(400).json({
      error: { code: "missing_state", message: "GitHub did not return ?state=" },
    });
    return;
  }

  const installation_id = parseInt(installation_id_str, 10);
  if (!Number.isFinite(installation_id) || installation_id <= 0) {
    res.status(400).json({
      error: { code: "bad_installation_id", message: `Cannot parse installation_id=${installation_id_str}` },
    });
    return;
  }

  const stateHash = sha256Hex(rawState);
  const { data: rows, error: cErr } = await serviceClient().rpc("consume_oauth_state", {
    p_provider: "github",
    p_state_hash: stateHash,
  });
  if (cErr) {
    res.status(500).json({
      error: { code: "state_consume_failed", message: cErr.message },
    });
    return;
  }
  const tenantUser = (rows as Array<{ tenant_id: string; user_id: string }> | null)?.[0];
  if (!tenantUser) {
    res.status(403).json({
      error: { code: "invalid_state", message: "OAuth state invalid, expired, or replayed." },
    });
    return;
  }

  try {
    const install = await getInstallation(installation_id);

    const repos = await listInstallationRepos({
      tenant_id: tenantUser.tenant_id,
      installation_id,
    });

    const { error: setErr } = await serviceClient().rpc("set_github_connection", {
      p_tenant_id: tenantUser.tenant_id,
      p_installation_id: installation_id,
      p_account_login: install.account_login,
      p_account_type: install.account_type,
      p_repo_ids: repos.map((r) => r.id),
      p_repo_full_names: repos.map((r) => r.full_name),
      p_scopes: [],
      p_repo_private: repos.map((r) => r.private),
    });
    if (setErr) {
      res.status(500).json({
        error: { code: "set_github_connection_failed", message: setErr.message },
      });
      return;
    }
    track("connector_connected", {
      tenant_id: tenantUser.tenant_id,
      user_id: tenantUser.user_id,
      connector: "github",
    });

    await seedDefaultRepoAfterConnect(
      tenantUser.tenant_id,
      repos.map((r) => r.full_name),
    );

    try {
      await seedPendingProfiles({
        tenant_id: tenantUser.tenant_id,
        repos: repos.map((r) => r.full_name),
      });
    } catch (e) {
      console.warn(
        `[connectors/github] seed pending repo profiles failed for tenant ${tenantUser.tenant_id}: ${(e as Error).message}`,
      );
    }
    try {
      await inngest.send({
        name: "repo.profile.build.requested",
        data: { tenant_id: tenantUser.tenant_id },
      });
    } catch (e) {
      console.warn(
        `[connectors/github] enqueue repo-profile-build failed for tenant ${tenantUser.tenant_id}: ${(e as Error).message}`,
      );
    }

    void notifyFounderActivity({ event: "first_connector", tenant_id: tenantUser.tenant_id, user_id: tenantUser.user_id, details: { connector: "github" } });

    await syncActiveTenant(tenantUser.user_id, tenantUser.tenant_id);

    const landing = new URL(connectedLanding("github", rawState));
    landing.searchParams.set("action", setup_action || "install");
    res.redirect(302, landing.toString());
  } catch (e) {
    res.status(502).json({
      error: { code: "github_install_failed", message: (e as Error).message },
    });
  }
}

export async function githubInstallUrl(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select("installation_id")
    .eq("tenant_id", auth.tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (error) {
    res.status(500).json({
      error: { code: "connector_metadata_read_failed", message: error.message },
    });
    return;
  }
  const installation_id = (data as { installation_id?: number | null } | null)
    ?.installation_id;
  if (!installation_id) {
    res.status(404).json({
      error: {
        code: "github_not_connected",
        message:
          "GitHub App is not installed for this tenant. Connect it from Settings → Connectors first.",
      },
    });
    return;
  }
  res.json({
    url: `https://github.com/settings/installations/${installation_id}`,
  });
}

export async function seedDefaultRepoAfterConnect(
  tenant_id: string,
  repoFullNames: string[],
): Promise<void> {
  const seed = repoFullNames.length === 1 ? repoFullNames[0] : null;
  try {
    const { data, error: readErr } = await serviceClient()
      .from("connector_metadata")
      .select("default_repo_full_name")
      .eq("tenant_id", tenant_id)
      .eq("slug", "github")
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    const current =
      (data as { default_repo_full_name?: string | null } | null)
        ?.default_repo_full_name ?? null;

    let write;
    if (current === null) {
      if (!seed) return;
      write = serviceClient()
        .from("connector_metadata")
        .update({ default_repo_full_name: seed })
        .eq("tenant_id", tenant_id)
        .eq("slug", "github")
        .is("default_repo_full_name", null);
    } else if (current.startsWith(`${UMBRELLA_CONNECTOR_ACCOUNT_LOGIN}/`)) {
      write = serviceClient()
        .from("connector_metadata")
        .update({ default_repo_full_name: seed })
        .eq("tenant_id", tenant_id)
        .eq("slug", "github")
        .eq("default_repo_full_name", current);
    } else {
      return;
    }
    const { error: defErr } = await write;
    if (defErr) throw new Error(defErr.message);
  } catch (e) {
    console.warn(
      `[connectors/github] seed default repo failed for tenant ${tenant_id}: ${(e as Error).message}`,
    );
  }
}

export async function githubDisconnect(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const authHeader = (req.headers.authorization as string | undefined) ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : authHeader;
  const sb = serverClientFromBearer(token);

  const { data: existing, error: readErr } = await sb
    .from("connector_metadata")
    .select("account_login")
    .eq("tenant_id", auth.tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (readErr) {
    res.status(500).json({
      error: { code: "connector_metadata_read_failed", message: readErr.message },
    });
    return;
  }
  if ((existing as { account_login?: string } | null)?.account_login === "Praxis-build") {
    res.status(409).json({
      error: {
        code: "not_disconnectable",
        message:
          "This GitHub connection is managed by your Zavi build and can't be disconnected here.",
      },
    });
    return;
  }

  const { error } = await sb.rpc("disconnect_github", {
    p_tenant_id: auth.tenant_id,
  });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") {
      res.status(403).json({ error: { code: "not_admin", message: error.message } });
      return;
    }
    if (code === "P0001") {
      res.status(409).json({
        error: {
          code: "not_disconnectable",
          message:
            "This GitHub connection is managed by your Zavi build and can't be disconnected here.",
        },
      });
      return;
    }
    if (code === "PGRST202" || code === "42883") {
      res.status(500).json({
        error: {
          code: "rpc_missing",
          message:
            "GitHub disconnect is temporarily unavailable: a pending database migration has not been applied.",
        },
      });
      return;
    }
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }
  res.status(200).json({ ok: true });
}
