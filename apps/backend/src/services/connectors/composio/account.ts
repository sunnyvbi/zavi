import { asTenantId, tenantClient } from "@/services/tenant-client";
import { CONNECTOR_CONNECT, railFor } from "@zavi/shared";
import { composioGetAccount, composioVerifyActive, type OwnedComposioAccount } from "./api";
import { ExpectedToolError } from "@/services/tools/types";
import { lookupAuthConfigId } from "./catalog";

export async function hasComposioSignIn(tenant_id: string, toolkit: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("connector_metadata")
    .select("slug").eq("tenant_id", tenant_id).eq("slug", `composio.${toolkit.toLowerCase()}`).maybeSingle();
  if (error) throw new Error(`connector_metadata read failed: ${error.message}`);
  return !!data;
}

export async function resolveOwnedComposioAccount(tenant_id: string, toolkit: string): Promise<OwnedComposioAccount | null> {
  const kit = toolkit.toLowerCase();
  if (railFor(kit) !== "composio") return null;
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("connector_metadata")
    .select("team_id, composio_auth_config_id").eq("slug", `composio.${kit}`).maybeSingle();
  if (error) throw new Error(`connector_metadata read failed: ${error.message}`);
  const row = data as { team_id?: string; composio_auth_config_id?: string | null } | null;
  const accountId = row?.team_id?.trim();
  if (!accountId) return null;
  const authConfigId = row?.composio_auth_config_id?.trim() || (await lookupAuthConfigId(kit));
  if (!authConfigId) return null;
  const owned = await composioVerifyActive({ user_id: tenant_id, auth_config_id: authConfigId, connected_account_id: accountId });
  return owned
    ? ({ tenant_id, toolkit: kit, connected_account_id: accountId, auth_config_id: authConfigId } as OwnedComposioAccount)
    : null;
}

type ComposioLoginState = { state: "none" | "active" | "unknown" } | { state: "stopped"; on: string | null };
async function composioLoginState(tenant_id: string, toolkit: string): Promise<ComposioLoginState> {
  let accountId: string | undefined;
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id)).from("connector_metadata")
      .select("team_id").eq("slug", `composio.${toolkit.toLowerCase()}`).maybeSingle();
    accountId = (data as { team_id?: string | null } | null)?.team_id?.trim();
    if (error || !accountId) return { state: "none" };
  } catch {
    return { state: "none" };
  }
  try {
    const st = await composioGetAccount(accountId);
    if (!st.status) return { state: "unknown" };
    if (st.status === "ACTIVE") return { state: "active" };
    if (st.user_id && st.user_id !== tenant_id) return { state: "unknown" };
    const t = st.updated_at ? new Date(st.updated_at) : null;
    const on = t && Number.isFinite(t.getTime()) ? t.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
    return { state: "stopped", on };
  } catch {
    return { state: "unknown" };
  }
}

function connectorSlugFor(kit: string): string {
  return CONNECTOR_CONNECT[kit] ? kit : `composio.${kit}`;
}

export async function composioConnectionStoppedError(tenant_id: string, toolkit: string, label: string): Promise<ExpectedToolError | null> {
  const kit = toolkit.toLowerCase();
  const st = await composioLoginState(tenant_id, kit);
  return st.state === "stopped" ? connectionStoppedError(kit, label, st.on) : null;
}

function connectionStoppedError(kit: string, label: string, on: string | null): ExpectedToolError {
  const reason = `${label} connection stopped working${on ? ` on ${on}` : ""}`;
  return new ExpectedToolError(`${kit}_connection_stopped`, `${reason}. Reconnect it.`, {
    founder_reason: reason,
    connector_slug: connectorSlugFor(kit),
    connector_mode: "reconnect",
  });
}

export async function honestComposioToolError(tenant_id: string, toolkit: string, label: string, e: unknown): Promise<unknown> {
  const kit = toolkit.toLowerCase();
  if (!(e instanceof ExpectedToolError) || e.code !== `${kit}_not_connected`) return e;
  const st = await composioLoginState(tenant_id, kit);
  if (st.state === "stopped") return connectionStoppedError(kit, label, st.on);
  if (st.state === "unknown") {
    return new ExpectedToolError(
      `${kit}_connection_unverified`,
      `${label} is set up, but Zavi could not check its login just now. Try again shortly; if it keeps failing, reconnect it.`,
      { connector_slug: connectorSlugFor(kit) },
    );
  }
  return e;
}
