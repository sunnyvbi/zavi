
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { selfAccountClient } from "@/services/tenant-client";
import { invalidateCachedTenant } from "@/services/auth/tenant-cache";
import { logEvent } from "@/services/logging/logEvent";
import { alert } from "@/services/logging/alert";
import { notifyAccountDeleted } from "@/services/account/deletion-alert";

export const PURGE_GRACE_DAYS = 30;

export const MARK_SOFT_DELETED_TRIES = 3;

export type DeletionSource = "mobile" | "web" | "api" | "staff";

export type MembershipRow = {
  tenant_id: string;
  user_id: string;
  role: string | null;
};

export type DeletionPlan = {
  deleted_tenants: string[];
  left_tenants: string[];
  blocked_tenants: string[];
};

export type DeleteAccountResult = {
  deleted_user_id: string;
  deleted_tenants: string[];
  left_tenants: string[];
};

export class AccountDeletionError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AccountDeletionError";
    this.status = status;
    this.code = code;
  }
}

export function planAccountDeletion(
  userId: string,
  rows: MembershipRow[],
): DeletionPlan {
  const byTenant = new Map<string, MembershipRow[]>();
  for (const row of rows) {
    const list = byTenant.get(row.tenant_id);
    if (list) list.push(row);
    else byTenant.set(row.tenant_id, [row]);
  }

  const plan: DeletionPlan = { deleted_tenants: [], left_tenants: [], blocked_tenants: [] };

  for (const [tenantId, members] of byTenant) {
    if (!members.some((m) => m.user_id === userId)) continue;

    const others = members.filter((m) => m.user_id !== userId);
    if (others.length === 0) {
      plan.deleted_tenants.push(tenantId);
      continue;
    }

    const owners = members.filter((m) => m.role === "owner");
    if (owners.length === 1 && owners[0].user_id === userId) {
      plan.blocked_tenants.push(tenantId);
      continue;
    }

    plan.left_tenants.push(tenantId);
  }

  plan.deleted_tenants.sort();
  plan.left_tenants.sort();
  plan.blocked_tenants.sort();
  return plan;
}

function hashEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

async function loadMemberships(
  sb: SupabaseClient,
  userId: string,
): Promise<MembershipRow[]> {
  const { data: mine, error: mineErr } = await sb
    .from("tenant_users")
    .select("tenant_id")
    .eq("user_id", userId);
  if (mineErr) {
    throw new AccountDeletionError(500, "internal", `membership read failed: ${mineErr.message}`);
  }
  const tenantIds = [...new Set((mine ?? []).map((r: { tenant_id: string }) => r.tenant_id))];
  if (tenantIds.length === 0) return [];

  const { data: all, error: allErr } = await sb
    .from("tenant_users")
    .select("tenant_id, user_id, role")
    .in("tenant_id", tenantIds);
  if (allErr) {
    throw new AccountDeletionError(500, "internal", `member read failed: ${allErr.message}`);
  }
  return (all ?? []) as MembershipRow[];
}

async function nameTenants(sb: SupabaseClient, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { data } = await sb.from("tenants").select("id, display_name").in("id", ids);
  const names = new Map((data ?? []).map((t: { id: string; display_name: string | null }) => [t.id, t.display_name]));
  return ids.map((id) => names.get(id) || id);
}

export async function softDeleteAccount(input: {
  user_id: string;
  access_token: string;
  session_id: string | null;
  source: DeletionSource;
}): Promise<DeleteAccountResult> {
  const { user_id, access_token, session_id, source } = input;
  const sb = selfAccountClient(
    "account deletion spans every tenant the verified caller belongs to (App Store 5.1.1(v))",
  );

  const { data: staffBlock, error: staffErr } = await sb.rpc("account_deletion_staff_block", {
    p_user_id: user_id,
    p_session_id: session_id,
  });
  if (staffErr) {
    throw new AccountDeletionError(503, "check_unavailable", "Couldn't verify this request. Please try again in a minute.");
  }
  if (staffBlock === "staff_session" || staffBlock === "unknown_session") {
    throw new AccountDeletionError(
      403,
      staffBlock,
      "This sign-in can't delete the account. If you are the account owner, sign out, sign in again, and retry.",
    );
  }
  if (staffBlock === "recent_staff_login") {
    throw new AccountDeletionError(
      409,
      "recent_staff_access",
      "Zavi support signed in to this account in the last 24 hours, so deletion is paused until 24 hours after that. Try again later, or email support@zaviagent.com.",
    );
  }
  if (staffBlock !== null && staffBlock !== undefined) {
    throw new AccountDeletionError(503, "check_unavailable", "Couldn't verify this request. Please try again in a minute.");
  }

  const plan = planAccountDeletion(user_id, await loadMemberships(sb, user_id));

  if (plan.blocked_tenants.length > 0) {
    const names = await nameTenants(sb, plan.blocked_tenants);
    const message =
      names.length === 1
        ? `You are the only owner of ${names[0]}, which still has other members. ` +
          "Make someone else an owner there, or remove the other members, then try again."
        : `You are the only owner of these workspaces, which still have other members: ${names.join(", ")}. ` +
          "Make someone else an owner in each, or remove the other members, then try again.";
    throw new AccountDeletionError(409, "owner_transfer_required", message);
  }

  const { data: userRow } = await sb.auth.admin.getUserById(user_id);
  const purgeAfter = new Date(Date.now() + PURGE_GRACE_DAYS * 86_400_000).toISOString();
  const deletionId = randomUUID();

  type Settled = "soft_deleted" | "failed" | "noop" | "unknown";
  const abort = async (why: string): Promise<Settled> => {
    let last = "unknown";
    for (let i = 0; i < 2; i++) {
      try {
        const { data, error } = await sb.rpc("account_deletion_abort", { p_deletion_id: deletionId, p_definite: true });
        if (error) throw new Error(error.message);
        if (data === "soft_deleted" || data === "failed" || data === "noop") return data;
        last = `unexpected answer ${JSON.stringify(data)}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    await alert({
      source: "account.delete",
      code: "deletion_abort_failed",
      msg:
        `Account deletion ${deletionId} (${why}) could not be settled: ${last}. ` +
        `Once the database answers, run select account_deletion_abort('${deletionId}', true) (the kill never ran).`,
      email: { dedupeKey: `account-delete-abort:${deletionId}` },
    }).catch((e: unknown) => console.error(`[account.delete] page failed: ${e instanceof Error ? e.message : String(e)}`));
    return "unknown";
  };

  let beginErr: { message: string } | null = null;
  try {
    ({ error: beginErr } = await sb.rpc("account_deletion_begin", {
      p_deletion_id: deletionId,
      p_user_id: user_id,
      p_email_sha256: hashEmail(userRow?.user?.email),
      p_source: source,
      p_purge_after: purgeAfter,
      p_deleted_tenant_ids: plan.deleted_tenants,
      p_left_tenant_ids: plan.left_tenants,
    }));
  } catch (e) {
    beginErr = { message: e instanceof Error ? e.message : String(e) };
  }
  let settledGone = false;
  if (beginErr) {
    settledGone = (await abort("begin failed")) === "soft_deleted";
  }
  if (beginErr && !settledGone) {
    if (/workspace_changed/.test(beginErr.message)) {
      throw new AccountDeletionError(
        409,
        "workspace_changed",
        "Someone joined one of your workspaces while you were deleting your account. Check your workspaces and try again.",
      );
    }
    if (/already_in_progress/.test(beginErr.message)) {
      throw new AccountDeletionError(
        409,
        "deletion_in_progress",
        "Your account is already being deleted. If this keeps happening, email support@zaviagent.com.",
      );
    }
    throw new AccountDeletionError(500, "internal", `audit write failed: ${beginErr.message}`);
  }

  let markErr: string | null = null;
  if (!settledGone) {
    await sb.auth.admin.signOut(access_token, "global").catch(() => {});

    let authErr: { message: string; status?: number } | null = null;
    try {
      ({ error: authErr } = await sb.auth.admin.deleteUser(user_id, true));
    } catch (e) {
      authErr = { message: e instanceof Error ? e.message : String(e) };
    }
    if (authErr) {
      const definite = typeof authErr.status === "number" && authErr.status >= 400 && authErr.status < 500;
      if (!definite) {
        await alert({
          source: "account.delete",
          code: "deletion_unconfirmed",
          msg:
            `Account deletion ${deletionId}: the login delete gave no clear answer (${authErr.message.slice(0, 200)}). ` +
            `The request stays pending. After an hour, run select account_deletion_abort('${deletionId}'): soft_deleted ` +
            `means the login is gone (finish the teardown by hand), failed means it is live (the person can retry).`,
          email: { dedupeKey: `account-delete-unconfirmed:${deletionId}` },
        }).catch((e: unknown) => console.error(`[account.delete] page failed: ${e instanceof Error ? e.message : String(e)}`));
        throw new AccountDeletionError(
          500,
          "internal",
          `account deletion unconfirmed: ${authErr.message}`,
        );
      }
      if ((await abort("login delete refused")) !== "soft_deleted") {
        throw new AccountDeletionError(
          500,
          "internal",
          `account deletion failed: ${authErr.message}`,
        );
      }
    } else {
      markErr = await markSoftDeleted(sb, deletionId);
    }
  }

  const teardownErrors: string[] = [];
  if (markErr) teardownErrors.push(`mark_soft_deleted: ${markErr}`);
  const step = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      teardownErrors.push(`${label}: ${(e as Error).message ?? "unknown"}`);
    }
  };
  const orThrow = (error: { message: string } | null): void => {
    if (error) throw new Error(error.message);
  };

  for (const tenantId of plan.deleted_tenants) {
    await step(`disable_schedules:${tenantId}`, async () => {
      orThrow((await sb.from("tenant_agent_schedules").update({ enabled: false }).eq("tenant_id", tenantId)).error);
    });
    await step(`delete_sites:${tenantId}`, async () => {
      const { deleteTenantSites } = await import("@/services/sites/teardown");
      const left = (await deleteTenantSites(tenantId)).filter(
        (s) => !s.result.complete && (s.result.pending.length > 0 || !!s.result.error),
      );
      if (left.length > 0) {
        throw new Error(
          `incomplete: ${left.map((s) => `${s.site_id} (${s.result.pending.join(", ")})`).join("; ")}`.slice(0, 500),
        );
      }
    });
    await step(`revoke_invites:${tenantId}`, async () => {
      orThrow(
        (
          await sb
            .from("tenant_member_invites")
            .update({ revoked_at: new Date().toISOString() })
            .eq("tenant_id", tenantId)
            .is("accepted_at", null)
            .is("revoked_at", null)
        ).error,
      );
    });
    await step(`purge_credentials:${tenantId}`, async () => {
      orThrow((await sb.rpc("purge_tenant_credentials", { p_tenant_id: tenantId })).error);
    });
  }

  for (const tenantId of plan.left_tenants) {
    await step(`clear_social:${tenantId}`, async () => {
      const { data, error } = await sb
        .from("social_connected_accounts")
        .select("platform, handle")
        .eq("tenant_id", tenantId)
        .eq("owner_user_id", user_id);
      orThrow(error);
      for (const row of (data ?? []) as { platform: string; handle: string }[]) {
        orThrow(
          (
            await sb.rpc("clear_social_connection", {
              p_tenant_id: tenantId,
              p_platform: row.platform,
              p_handle: row.handle,
            })
          ).error,
        );
      }
    });
  }

  await step("drop_memberships", async () => {
    orThrow((await sb.from("tenant_users").delete().eq("user_id", user_id)).error);
  });

  await step("mark_profile", async () => {
    orThrow(
      (
        await sb
          .from("profiles")
          .update({ deleted_at: new Date().toISOString(), active_tenant_id: null })
          .eq("user_id", user_id)
      ).error,
    );
  });

  await step("drop_session_pins", async () => {
    orThrow((await sb.from("session_tenants").delete().eq("user_id", user_id)).error);
  });

  invalidateCachedTenant(user_id);

  if (teardownErrors.length > 0) {
    await sb
      .from("account_deletions")
      .update({ teardown_errors: teardownErrors.slice(0, 20) })
      .eq("id", deletionId);
  }

  void logEvent({
    level: teardownErrors.length > 0 ? "warn" : "info",
    source: "account.delete",
    code: teardownErrors.length > 0 ? "soft_deleted_with_errors" : "soft_deleted",
    meta: {
      source,
      deleted_tenants: plan.deleted_tenants.length,
      left_tenants: plan.left_tenants.length,
      teardown_errors: teardownErrors.length,
    },
  });

  void notifyAccountDeleted({
    sb,
    deletion_id: deletionId,
    source,
    email: userRow?.user?.email ?? null,
    signed_up_at: userRow?.user?.created_at ?? null,
    last_sign_in_at: userRow?.user?.last_sign_in_at ?? null,
    deleted_tenants: plan.deleted_tenants,
    left_tenants: plan.left_tenants,
    teardown_errors: teardownErrors.length,
  }).catch(() => {});

  return {
    deleted_user_id: user_id,
    deleted_tenants: plan.deleted_tenants,
    left_tenants: plan.left_tenants,
  };
}

async function markSoftDeleted(sb: SupabaseClient, deletionId: string): Promise<string | null> {
  let last = "unknown";
  for (let i = 0; i < MARK_SOFT_DELETED_TRIES; i++) {
    try {
      const { data, error } = await sb
        .from("account_deletions")
        .update({ status: "soft_deleted" })
        .eq("id", deletionId)
        .eq("status", "pending")
        .select("id");
      if (!error && Array.isArray(data) && data.length === 1) return null;
      if (!error) {
        last = "the request was no longer pending";
        break;
      }
      last = error.message;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  await alert({
    source: "account.delete",
    code: "soft_deleted_status_not_written",
    msg:
      `Account deletion ${deletionId}: the login was soft-deleted but the request could not be switched to ` +
      `'soft_deleted' (${last.slice(0, 120)}); it will not be purged as it is. ` +
      `Set account_deletions.status = 'soft_deleted' for this id once checked.`,
    email: { dedupeKey: `account-delete-mark:${deletionId}` },
  }).catch((e: unknown) => console.error(`[account.delete] page failed: ${e instanceof Error ? e.message : String(e)}`));
  return last;
}
