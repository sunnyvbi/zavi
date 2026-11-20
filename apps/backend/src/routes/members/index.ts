
import { Router, type Request, type Response } from "express";
import { forwardAsyncErrors } from "@/services/http/async-errors";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { requireAuth } from "@/services/auth/middleware";
import { invalidateCachedTenant } from "@/services/auth/tenant-cache";
import { clearSessionTenantsForMembership } from "@/services/tenants/session-tenant";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { resolveInviteSender, sendWorkspaceInviteEmail } from "@/email/sendAuthEmail";
import { INVITER_FALLBACK } from "@/email/templates/workspace-invite";
import { resolveAuthRedirectBase } from "@/services/auth/redirect-base";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

type StableError = {
  status: number;
  body: { error: { code: string; message: string } };
};

function mapPgError(err: { code?: string; message?: string }): StableError {
  const msg = err.message ?? "";
  if (err.code === "42501") {
    return {
      status: 403,
      body: { error: { code: "forbidden", message: msg || "Forbidden." } },
    };
  }
  if (err.code === "P0001") {
    return {
      status: 409,
      body: { error: { code: "user_already_exists", message: msg || "User already exists." } },
    };
  }
  if (err.code === "22023") {
    return {
      status: 400,
      body: { error: { code: "invalid_argument", message: msg || "Invalid argument." } },
    };
  }
  if (err.code === "23505") {
    return {
      status: 409,
      body: { error: { code: "conflict", message: msg || "Conflict." } },
    };
  }
  if (err.code === "42704") {
    return {
      status: 404,
      body: { error: { code: "not_found", message: msg || "Not found." } },
    };
  }
  return {
    status: 500,
    body: { error: { code: "internal_error", message: msg || "Member operation failed." } },
  };
}

function mapAcceptInviteError(err: { code?: string; message?: string }): StableError {
  if (err.code !== "42501") return mapPgError(err);
  const msg = err.message ?? "";
  if (/already accepted/i.test(msg)) {
    return { status: 409, body: { error: { code: "already_accepted", message: "This invite was already accepted." } } };
  }
  if (/revoked/i.test(msg)) {
    return { status: 410, body: { error: { code: "invite_revoked", message: "This invite was cancelled." } } };
  }
  if (/seat_cap_exceeded/i.test(msg)) {
    return {
      status: 402,
      body: {
        error: {
          code: "seat_cap_exceeded",
          message: "This workspace is full on its current plan. Ask the person who invited you to upgrade or free a seat.",
        },
      },
    };
  }
  if (/different email/i.test(msg)) {
    return { status: 403, body: { error: { code: "email_mismatch", message: "This invite is for a different email address." } } };
  }
  return { status: 401, body: { error: { code: "unauthenticated", message: "Sign in to accept this invite." } } };
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

const inviteBody = z.object({
  email: z.string().email().max(320),
  role: z.enum(["admin", "member", "viewer"]),
});

const acceptBody = z.object({
  inviteId: z.string().uuid(),
});

const roleBody = z.object({
  role: z.enum(["admin", "member", "viewer"]),
});

const ALREADY_INVITED = "That person is already a member or already has an invite.";

const TIER_NAMES: Record<string, string> = { free: "Free", starter: "Starter", growth: "Growth", pro: "Pro" };

export function inviteFailure(err: { code?: string; message?: string }, ctx: { openInvites?: number } = {}): StableError {
  const raw = err.message ?? "";
  if (err.code === "42501" && raw.includes("seat_cap_exceeded")) {
    const max = /allows (\d+) seats/.exec(raw)?.[1];
    const tier = TIER_NAMES[/tier (\w+)/.exec(raw)?.[1] ?? ""];
    const seats = max ? `${max} ${max === "1" ? "seat" : "seats"}` : null;
    const message =
      ctx.openInvites === 0 && max === "1"
        ? `Your ${tier ? `${tier} plan` : "plan"} has 1 seat, and it's yours. Upgrade your plan to invite teammates.`
        : ctx.openInvites === 0
          ? `Your ${tier ? `${tier} plan` : "plan"}'s ${seats ?? "seats"} are all taken. Remove someone or upgrade your plan to invite another teammate.`
          : `Your plan has room for ${max ? `${max} ${max === "1" ? "person" : "people"}` : "no more people"}, counting pending invites. Cancel a pending invite or remove someone to invite another teammate.`;
    return { status: 403, body: { error: { code: "seat_cap_exceeded", message } } };
  }
  const m = mapPgError(err);
  const text: Record<string, string> = {
    forbidden: "Only owners and admins can invite teammates.",
    user_already_exists: ALREADY_INVITED,
    conflict: ALREADY_INVITED,
    invalid_argument: "Check the email address and role, then try again.",
  };
  m.body.error.message = text[m.body.error.code] ?? "Couldn't send the invite. Try again.";
  return m;
}

async function openInviteCount(tenantId: string): Promise<number | undefined> {
  try {
    const { data, error } = await serviceClient()
      .from("tenant_member_invites")
      .select("id")
      .eq("tenant_id", tenantId)
      .is("accepted_at", null)
      .is("revoked_at", null);
    return error ? undefined : (data ?? []).length;
  } catch {
    return undefined;
  }
}

async function alreadyInvited(tenantId: string, email: string): Promise<boolean> {
  const sb = serviceClient();
  const { data: open, error: openErr } = await sb
    .from("tenant_member_invites")
    .select("id, email")
    .eq("tenant_id", tenantId)
    .eq("email", email)
    .is("accepted_at", null)
    .is("revoked_at", null);
  if (openErr) throw new Error(openErr.message);
  if (((open ?? []) as Array<{ email?: string }>).some((i) => (i.email ?? "").toLowerCase() === email)) return true;
  const { data: isMember, error: memberErr } = await sb.rpc("is_tenant_member_email", { p_tenant_id: tenantId, p_email: email });
  if (memberErr) throw new Error(memberErr.message);
  if (isMember === true) return true;
  const { data: viewers, error: viewerErr } = await sb
    .from("tenant_users")
    .select("user_id, role")
    .eq("tenant_id", tenantId)
    .eq("role", "viewer");
  if (viewerErr) throw new Error(viewerErr.message);
  for (const row of ((viewers ?? []) as Array<{ user_id: string; role?: string }>).filter((r) => r.role === "viewer")) {
    const { data, error } = await sb.auth.admin.getUserById(row.user_id);
    if (error) throw new Error(error.message);
    if ((data?.user?.email ?? "").toLowerCase() === email) return true;
  }
  return false;
}

async function inviteHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = inviteBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const role = parsed.data.role;

  const userClient = serverClientFromBearer(auth.access_token);
  const { data: sessionTenant } = await userClient.rpc("app_active_tenant");
  const inviteTenant = typeof sessionTenant === "string" && sessionTenant ? sessionTenant : auth.tenant_id;
  const { error: gateErr } = await userClient.rpc("_assert_tenant_admin", { p_tenant_id: inviteTenant });
  if (gateErr) {
    const m = inviteFailure(gateErr);
    res.status(m.status).json(m.body);
    return;
  }
  let duplicate: boolean;
  try {
    duplicate = await alreadyInvited(inviteTenant, email);
  } catch (e) {
    console.warn(`[invite] duplicate check failed, no invite sent: ${(e as Error).message}`);
    res.status(503).json({
      error: {
        code: "invite_check_unavailable",
        message: "Couldn't check your team just now, so no invite was sent. Try again in a minute.",
      },
    });
    return;
  }
  if (duplicate) {
    res.status(409).json({ error: { code: "conflict", message: ALREADY_INVITED } });
    return;
  }
  const { data: inviteIdData, error: rpcErr } = await userClient.rpc("invite_member", {
    p_email: email,
    p_role: role,
    p_agent_slugs: [],
  });
  if (rpcErr) {
    const m = inviteFailure(rpcErr, { openInvites: await openInviteCount(inviteTenant) });
    res.status(m.status).json(m.body);
    return;
  }
  const inviteId = inviteIdData as string | null;
  if (!inviteId) {
    res.status(500).json({
      error: { code: "internal_error", message: "invite_member returned null" },
    });
    return;
  }

  const webBase = resolveAuthRedirectBase() ?? "";

  async function rollbackAndFail(message: string): Promise<void> {
    try {
      const { error: revokeErr } = await userClient.rpc("revoke_invite", {
        p_invite_id: inviteId,
      });
      if (revokeErr) {
        console.warn(
          `[invite] failed to revoke orphan invite ${inviteId}: ${revokeErr.message}`,
        );
      }
    } catch (revokeErr) {
      console.warn(
        `[invite] failed to revoke orphan invite ${inviteId}: ${(revokeErr as Error).message}`,
      );
    }
    console.error(`[invite] email send failed (invite rolled back): ${message}`);
    res.status(502).json({
      error: {
        code: "invite_email_failed",
        message: "We couldn't send the invite email, so nothing was sent. Try again in a moment.",
      },
    });
  }

  if (!webBase) {
    await rollbackAndFail("WEB_BASE_URL/WEB_ORIGIN not configured");
    return;
  }
  const acceptUrl = `${webBase}/invite/accept?id=${inviteId}&deeplink=invite`;

  const { data: stored, error: storedErr } = await serviceClient()
    .from("tenant_member_invites")
    .select("tenant_id, invited_by")
    .eq("id", inviteId)
    .maybeSingle<{ tenant_id: string; invited_by: string | null }>();
  if (storedErr || !stored?.tenant_id) {
    console.warn(`[invite] invite row read-back failed, sending without names: ${storedErr?.message ?? "not found"}`);
  }

  try {
    const sender = stored?.tenant_id
      ? await resolveInviteSender(stored.tenant_id, stored.invited_by ?? null)
      : { tenantName: null, inviterLabel: INVITER_FALLBACK, inviterEmail: null };
    await sendWorkspaceInviteEmail({ to: email, acceptUrl, ...sender });
  } catch (e) {
    await rollbackAndFail((e as Error).message);
    return;
  }

  void notifyFounderActivity({
    event: "teammate_invited",
    tenant_id: auth.tenant_id,
    user_id: auth.user_id,
    details: { invited: email, role },
  });
  res.status(201).json({ invite_id: inviteId });
}

async function acceptHandler(req: Request, res: Response): Promise<void> {
  const parsed = acceptBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }

  const { verifyBearer } = await import("@/services/auth/jwt");
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({
      error: { code: "unauthenticated", message: "Missing or invalid Bearer token." },
    });
    return;
  }

  const userClient = serverClientFromBearer(verified.access_token);
  const { error: rpcErr } = await userClient.rpc("accept_invite", {
    p_invite_id: parsed.data.inviteId,
  });
  if (rpcErr) {
    const m = mapAcceptInviteError(rpcErr);
    res.status(m.status).json(m.body);
    return;
  }

  invalidateCachedTenant(verified.user_id);

  res.status(200).json({ ok: true });
}

async function roleHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userId = req.params.userId;
  if (!userId || !UUID_RE.test(userId)) {
    res.status(400).json({ error: { code: "bad_request", message: "invalid userId" } });
    return;
  }

  const parsed = roleBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }

  const userClient = serverClientFromBearer(auth.access_token);
  const { error: rpcErr } = await userClient.rpc("set_member_role", {
    p_user_id: userId,
    p_role: parsed.data.role,
  });
  if (rpcErr) {
    const m = mapPgError(rpcErr);
    res.status(m.status).json(m.body);
    return;
  }
  res.status(200).json({ ok: true });
}

async function transferOwnershipHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const targetId = req.params.userId;
  if (!targetId || !UUID_RE.test(targetId)) {
    res.status(400).json({ error: { code: "bad_request", message: "invalid userId" } });
    return;
  }

  const callerId = auth.user_id;
  const tenantId = auth.tenant_id;

  if (targetId === callerId) {
    res.status(400).json({
      error: { code: "invalid_argument", message: "Cannot transfer ownership to yourself." },
    });
    return;
  }

  const sb = serviceClient();

  const { data: preRows, error: preErr } = await sb
    .from("tenant_users")
    .select("user_id, role")
    .eq("tenant_id", tenantId)
    .in("user_id", [callerId, targetId]);
  if (preErr) {
    const m = mapPgError(preErr);
    res.status(m.status).json(m.body);
    return;
  }
  const callerRow = preRows?.find((r) => r.user_id === callerId);
  const targetRow = preRows?.find((r) => r.user_id === targetId);
  if (!callerRow || callerRow.role !== "owner") {
    res.status(403).json({
      error: { code: "forbidden", message: "Only the owner can transfer ownership." },
    });
    return;
  }
  if (!targetRow) {
    res.status(404).json({
      error: { code: "not_found", message: "That user is not a member of this workspace." },
    });
    return;
  }
  if (targetRow.role !== "admin" && targetRow.role !== "member") {
    res.status(400).json({
      error: { code: "invalid_argument", message: "That user cannot receive ownership." },
    });
    return;
  }

  const audit = {
    tenant_id: tenantId,
    actor_user_id: callerId,
    old_owner_id: callerId,
    new_owner_id: targetId,
  };
  console.log(`[transfer_ownership] start ${JSON.stringify(audit)}`);

  async function reconcileAndRespond(stepErr: { code?: string; message?: string } | null): Promise<void> {
    const { data: postRows } = await sb
      .from("tenant_users")
      .select("user_id, role")
      .eq("tenant_id", tenantId)
      .in("user_id", [callerId, targetId]);
    const targetNow = postRows?.find((r) => r.user_id === targetId)?.role ?? null;

    if (targetNow === "owner") {
      invalidateCachedTenant(callerId);
      invalidateCachedTenant(targetId);
      console.log(`[transfer_ownership] success ${JSON.stringify(audit)}`);
      res.status(200).json({ ok: true });
      return;
    }

    const { count: ownerCount } = await sb
      .from("tenant_users")
      .select("user_id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("role", "owner");
    if ((ownerCount ?? 0) === 0) {
      const { error: restoreErr } = await sb
        .from("tenant_users")
        .update({ role: "owner" })
        .eq("tenant_id", tenantId)
        .eq("user_id", callerId);
      console.log(
        `[transfer_ownership] failed_restored_owner ${JSON.stringify({ ...audit, restore_error: restoreErr?.message ?? null })}`,
      );
    } else {
      console.log(
        `[transfer_ownership] failed_no_change ${JSON.stringify({ ...audit, owner_count: ownerCount })}`,
      );
    }
    const m = stepErr ? mapPgError(stepErr) : null;
    res.status(m?.status ?? 500).json(
      m?.body ?? {
        error: { code: "transfer_failed", message: "Ownership transfer failed; no change was made." },
      },
    );
  }

  let demotedRows = 0;
  let step1Err: { code?: string; message?: string } | null = null;
  {
    const { data: d1, error: e1 } = await sb
      .from("tenant_users")
      .update({ role: "admin" })
      .eq("tenant_id", tenantId)
      .eq("user_id", callerId)
      .eq("role", "owner")
      .select("user_id");
    step1Err = e1 ?? null;
    demotedRows = d1?.length ?? 0;
  }
  if (step1Err) {
    await reconcileAndRespond(step1Err);
    return;
  }
  if (demotedRows !== 1) {
    await reconcileAndRespond({ code: "23505", message: "Another ownership change is in progress." });
    return;
  }

  const { error: step2Err } = await sb
    .from("tenant_users")
    .update({ role: "owner" })
    .eq("tenant_id", tenantId)
    .eq("user_id", targetId)
    .in("role", ["admin", "member"]);

  await reconcileAndRespond(step2Err ?? null);
}

async function revokeMemberHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userId = req.params.userId;
  if (!userId || !UUID_RE.test(userId)) {
    res.status(400).json({ error: { code: "bad_request", message: "invalid userId" } });
    return;
  }

  const userClient = serverClientFromBearer(auth.access_token);
  const { error: rpcErr } = await userClient.rpc("revoke_member", {
    p_user_id: userId,
  });
  if (rpcErr) {
    const m = mapPgError(rpcErr);
    res.status(m.status).json(m.body);
    return;
  }

  const sb = serviceClient();
  const { data: remaining, error: remainingErr } = await sb
    .from("tenant_users")
    .select("tenant_id, role")
    .eq("user_id", userId);
  const rows = ((remaining ?? []) as Array<{ tenant_id: string; role: string }>).filter(
    (r) => r.tenant_id !== auth.tenant_id,
  );
  const nextTenant = (rows.find((r) => r.role === "owner") ?? rows[0])?.tenant_id ?? null;
  if (remainingErr) {
    console.warn(`[revoke_member] remaining-membership read failed for ${userId}: ${remainingErr.message}`);
  }
  const { error: profErr } = await sb
    .from("profiles")
    .update({ active_tenant_id: remainingErr ? null : nextTenant })
    .eq("user_id", userId)
    .eq("active_tenant_id", auth.tenant_id);
  if (profErr) {
    console.warn(
      `[revoke_member] profile reset failed for ${userId}: ${profErr.message}`,
    );
  }

  try {
    const { data: owned, error: ownedErr } = await sb
      .from("social_connected_accounts")
      .select("platform, handle")
      .eq("tenant_id", auth.tenant_id)
      .eq("owner_user_id", userId);
    if (ownedErr) throw ownedErr;
    for (const row of owned ?? []) {
      const { error: clrErr } = await sb.rpc("clear_social_connection", {
        p_tenant_id: auth.tenant_id,
        p_platform: (row as { platform: string }).platform,
        p_handle: (row as { handle: string }).handle,
      });
      if (clrErr) {
        void logEvent({
          level: "warn",
          source: "members.revoke",
          code: "social_cred_purge_failed",
          tenant_id: auth.tenant_id,
          meta: { platform: (row as { platform: string }).platform },
        });
      }
    }
  } catch {
    void logEvent({
      level: "warn",
      source: "members.revoke",
      code: "social_cred_purge_failed",
      tenant_id: auth.tenant_id,
    });
  }

  invalidateCachedTenant(userId);
  await clearSessionTenantsForMembership(userId, auth.tenant_id);

  res.status(200).json({ ok: true });
}

async function revokeInviteHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const inviteId = req.params.inviteId;
  if (!inviteId || !UUID_RE.test(inviteId)) {
    res.status(400).json({ error: { code: "bad_request", message: "invalid inviteId" } });
    return;
  }

  const userClient = serverClientFromBearer(auth.access_token);
  const { error: rpcErr } = await userClient.rpc("revoke_invite", {
    p_invite_id: inviteId,
  });
  if (rpcErr) {
    const m = mapPgError(rpcErr);
    res.status(m.status).json(m.body);
    return;
  }
  res.status(200).json({ ok: true });
}

type ListedMember = {
  user_id: string;
  email: string;
  role: string;
  joined_at: string | null;
};

async function listMembersHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sb = serviceClient();

  const { data: tuRows, error: tuErr } = await sb
    .from("tenant_users")
    .select("user_id, role, created_at")
    .eq("tenant_id", auth.tenant_id);
  if (tuErr) {
    res.status(500).json({ error: { code: "list_failed", message: tuErr.message } });
    return;
  }
  const rows = (tuRows ?? []) as Array<{
    user_id: string;
    role: string;
    created_at: string | null;
  }>;
  if (rows.length === 0) {
    res.json({ members: [] });
    return;
  }
  const userIds = rows.map((r) => r.user_id);

  const perPage = 1000;
  const emailByUserId = new Map<string, string>();
  const wantedIds = new Set(userIds);
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: usersResult, error: usersErr } = await sb.auth.admin.listUsers({
      page,
      perPage,
    });
    if (usersErr) {
      res.status(500).json({
        error: { code: "list_failed", message: usersErr.message },
      });
      return;
    }
    const pageUsers = usersResult?.users ?? [];
    for (const u of pageUsers) {
      if (u.id && u.email && wantedIds.has(u.id)) {
        emailByUserId.set(u.id, u.email);
        wantedIds.delete(u.id);
      }
    }
    if (wantedIds.size === 0) break;
    if (pageUsers.length < perPage) break;
    page += 1;
  }

  const members: ListedMember[] = rows.map((r) => ({
    user_id: r.user_id,
    email: emailByUserId.get(r.user_id) ?? "",
    role: r.role,
    joined_at: r.created_at,
  }));

  res.json({ members });
}

async function listInvitesHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const userClient = serverClientFromBearer(auth.access_token);
  const { data, error } = await userClient
    .from("tenant_member_invites")
    .select("id, email, role, invited_at, invited_by")
    .eq("tenant_id", auth.tenant_id)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .order("invited_at", { ascending: false })
    .limit(200);
  if (error) {
    res.status(500).json({
      error: { code: "list_failed", message: error.message },
    });
    return;
  }
  res.json({ invites: data ?? [] });
}

async function resendInviteHandler(req: Request, res: Response): Promise<void> {
  const inviteId = req.params.id;
  if (!inviteId || !UUID_RE.test(inviteId)) {
    res.status(400).json({ error: { code: "bad_request", message: "invalid invite id" } });
    return;
  }

  const sb = serviceClient();
  const { data: invite, error: readErr } = await sb
    .from("tenant_member_invites")
    .select("id, email, accepted_at, revoked_at, tenant_id, invited_by")
    .eq("id", inviteId)
    .maybeSingle();
  if (readErr) {
    res.status(500).json({ error: { code: "internal_error", message: readErr.message } });
    return;
  }
  if (!invite) {
    res.status(404).json({ error: { code: "not_found", message: "Invite not found." } });
    return;
  }
  if (invite.revoked_at) {
    res.status(410).json({ error: { code: "invite_revoked", message: "This invite was cancelled." } });
    return;
  }
  if (invite.accepted_at) {
    res.status(409).json({ error: { code: "already_accepted", message: "This invite was already accepted." } });
    return;
  }

  const webBase = resolveAuthRedirectBase() ?? "";
  if (!webBase) {
    res.status(500).json({
      error: { code: "internal_error", message: "WEB_BASE_URL/WEB_ORIGIN not configured" },
    });
    return;
  }
  const acceptUrl = `${webBase}/invite/accept?id=${inviteId}&deeplink=invite`;

  try {
    const sender = await resolveInviteSender(invite.tenant_id, invite.invited_by ?? null);
    await sendWorkspaceInviteEmail({ to: invite.email, acceptUrl, ...sender });
  } catch (e) {
    res.status(502).json({
      error: { code: "invite_email_failed", message: `Couldn't send the link: ${(e as Error).message}` },
    });
    return;
  }

  res.status(200).json({ ok: true, email_masked: maskEmail(invite.email) });
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const dotIdx = domain.lastIndexOf(".");
  const tld = dotIdx >= 0 ? domain.slice(dotIdx) : "";
  const label = dotIdx >= 0 ? domain.slice(0, dotIdx) : domain;
  const maskedLocal = (local?.[0] ?? "") + "***";
  const maskedLabel = (label?.[0] ?? "") + "***";
  return `${maskedLocal}@${maskedLabel}${tld}`;
}

export function membersRouter(): Router {
  const r = forwardAsyncErrors(Router());

  const resendLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req: Request) => `invite-resend:${req.params.id ?? "?"}:${req.ip ?? "?"}`,
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "Too many requests. Try again in a few minutes." },
      }),
  });

  r.post("/invite", inviteHandler);
  r.post("/accept", acceptHandler);
  r.post("/invite/:id/resend", resendLimiter, resendInviteHandler);
  r.get("/", listMembersHandler);
  r.get("/invites", listInvitesHandler);
  r.delete("/invites/:inviteId", revokeInviteHandler);
  r.post("/:userId/role", roleHandler);
  r.post("/:userId/transfer-ownership", transferOwnershipHandler);
  r.delete("/:userId", revokeMemberHandler);
  return r;
}
