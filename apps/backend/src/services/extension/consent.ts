
import {
  asTenantId,
  tenantClient,
  tenantRpc,
  tenantStorage,
} from "@/services/tenant-client";
import { CHAT_IMAGE_BUCKET } from "@/services/chat-images/store-chat-image";
import { EXTENSION_SCREENSHOTS_TABLE } from "@/services/extension/screenshots";
import { stopUserBrowserControl } from "@/services/extension/browser-ops";

export const EXTENSION_CONSENT_VERSION = "4";

const STRIP_BATCH = 500;

export type ExtensionConsentState = {
  granted: boolean;
  version: string | null;
  granted_at: string | null;
  revoked_at: string | null;
  current_version: string;
};

const NO_CONSENT: ExtensionConsentState = {
  granted: false,
  version: null,
  granted_at: null,
  revoked_at: null,
  current_version: EXTENSION_CONSENT_VERSION,
};

const SELECT = "version, granted_at, revoked_at";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toState(raw: unknown): ExtensionConsentState {
  const r = (raw ?? {}) as Record<string, unknown>;
  const version = str(r.version);
  const revoked_at = str(r.revoked_at);
  return {
    granted: revoked_at === null && version === EXTENSION_CONSENT_VERSION,
    version,
    granted_at: str(r.granted_at),
    revoked_at,
    current_version: EXTENSION_CONSENT_VERSION,
  };
}

export async function readExtensionConsent(
  tenant_id: string,
  user_id: string,
): Promise<ExtensionConsentState> {
  if (!tenant_id || !user_id) return NO_CONSENT;
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("extension_consent")
      .select(SELECT)
      .eq("user_id", user_id)
      .maybeSingle();
    if (error || !data) return NO_CONSENT;
    return toState(data);
  } catch {
    return NO_CONSENT;
  }
}

export async function hasCurrentExtensionConsent(
  tenant_id: string,
  user_id: string,
): Promise<boolean> {
  return (await readExtensionConsent(tenant_id, user_id)).granted;
}

export async function grantExtensionConsent(
  tenant_id: string,
  user_id: string,
): Promise<ExtensionConsentState> {
  const { data, error } = await tenantRpc(
    asTenantId(tenant_id),
    "grant_extension_consent",
    { p_user_id: user_id, p_version: EXTENSION_CONSENT_VERSION },
  );
  if (error) throw new Error(error.message);
  return toState(data);
}

export async function revokeExtensionConsent(
  tenant_id: string,
  user_id: string,
): Promise<{ state: ExtensionConsentState; runs_cleared: number }> {
  const { data, error } = await tenantRpc(
    asTenantId(tenant_id),
    "revoke_extension_consent",
    { p_user_id: user_id },
  );
  if (error) throw new Error(error.message);
  const [stopped] = await Promise.allSettled([stopUserBrowserControl(tenant_id, user_id)]);
  const [erased] = await Promise.allSettled([eraseUserExtensionScreenshots(tenant_id, user_id)]);
  if (erased.status === "rejected") throw erased.reason;
  if (stopped.status === "rejected") throw stopped.reason;
  const runs_cleared = erased.value;
  return { state: data ? toState(data) : NO_CONSENT, runs_cleared };
}

export async function eraseUserExtensionScreenshots(
  tenant_id: string,
  user_id: string,
): Promise<number> {
  if (!tenant_id || !user_id) return 0;
  const tid = asTenantId(tenant_id);
  const scoped = tenantClient(tid);

  const { data, error } = await scoped
    .from(EXTENSION_SCREENSHOTS_TABLE)
    .select("id, image_path, kind")
    .eq("user_id", user_id)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { id: string; image_path: string; kind?: string | null }[];

  if (rows.length > 0) {
    const prefix = `${tenant_id}/`;
    const paths = rows.map((r) => r.image_path);
    const foreign = paths.find((p) => !p.startsWith(prefix));
    if (foreign) {
      throw new Error(
        "extension consent: a screenshot ledger row points outside this tenant — refusing to erase",
      );
    }
    const { error: rmErr } = await tenantStorage(tid)
      .from(CHAT_IMAGE_BUCKET)
      .remove(paths);
    if (rmErr) throw new Error(rmErr.message);
    const stepPaths = rows.filter((r) => r.kind === "task_step").map((r) => r.image_path);
    for (let i = 0; i < stepPaths.length; i += 100) {
      const { error: artErr } = await scoped
        .from("run_artifacts")
        .delete()
        .eq("bucket", CHAT_IMAGE_BUCKET)
        .in("storage_path", stepPaths.slice(i, i + 100));
      if (artErr) throw new Error(artErr.message);
    }
  }

  let cleared = 0;
  for (;;) {
    const { data: runs, error: runErr } = await scoped
      .from("agent_runs")
      .select("id, payload")
      .eq("actor_user_id", user_id)
      .not("payload->>page_context", "is", null)
      .limit(STRIP_BATCH);
    if (runErr) throw new Error(runErr.message);
    const batch = (runs ?? []) as { id: string; payload: unknown }[];
    if (batch.length === 0) break;

    let clearedThisPass = 0;
    for (const run of batch) {
      const payload = (run.payload ?? {}) as Record<string, unknown>;
      if (!("page_context" in payload)) continue;
      const { page_context: _dropped, ...rest } = payload;
      const { error: upErr } = await scoped
        .from("agent_runs")
        .update({ payload: rest })
        .eq("id", run.id);
      if (upErr) throw new Error(upErr.message);
      clearedThisPass++;
    }
    if (clearedThisPass === 0) {
      throw new Error(
        `extension consent: ${batch.length} run(s) still carry page_context but none could be cleared — refusing to report a revocation that did not happen`,
      );
    }
    cleared += clearedThisPass;
  }

  if (rows.length > 0) {
    const { error: delErr } = await scoped
      .from(EXTENSION_SCREENSHOTS_TABLE)
      .update({ deleted_at: new Date().toISOString() })
      .in(
        "id",
        rows.map((r) => r.id),
      );
    if (delErr) throw new Error(delErr.message);
  }

  return cleared;
}

export async function stripTenantPageContext(tenant_id: string): Promise<number> {
  if (!tenant_id) return 0;
  const scoped = tenantClient(asTenantId(tenant_id));
  let cleared = 0;

  for (;;) {
    const { data, error } = await scoped
      .from("agent_runs")
      .select("id, payload")
      .not("payload->>page_context", "is", null)
      .limit(STRIP_BATCH);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { id: string; payload: unknown }[];
    if (rows.length === 0) return cleared;

    let clearedThisPass = 0;
    for (const row of rows) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      if (!("page_context" in payload)) continue;
      const { page_context: _dropped, ...rest } = payload;
      const { error: upErr } = await scoped
        .from("agent_runs")
        .update({ payload: rest })
        .eq("id", row.id);
      if (upErr) throw new Error(upErr.message);
      clearedThisPass++;
    }

    if (clearedThisPass === 0) {
      throw new Error(
        `extension consent: ${rows.length} run(s) still match page_context but none could be cleared — refusing to report a revocation that did not happen`,
      );
    }
    cleared += clearedThisPass;
  }
}
