
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient, anonClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

export function sessionIdOfToken(accessToken: string): string | null {
  const part = accessToken.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { session_id?: unknown };
    return typeof claims.session_id === "string" && claims.session_id.length > 0 ? claims.session_id : null;
  } catch {
    return null;
  }
}

const TENANT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Body = z.object({
  tenant_id: z.string().regex(TENANT_UUID_RE, "tenant_id must be a UUID"),
  user_id: z.string().uuid().optional(),
});

export async function staffLoginAs(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "invalid body" },
    });
    return;
  }
  const { tenant_id } = parsed.data;
  const sb = serviceClient();

  const { data: tenant, error: tErr } = await sb
    .from("tenants")
    .select("id, slug, display_name")
    .eq("id", tenant_id)
    .maybeSingle<{ id: string; slug: string; display_name: string | null }>();
  if (tErr) {
    res.status(500).json({ error: { code: "tenant_lookup_failed", message: tErr.message } });
    return;
  }
  if (!tenant) {
    res.status(404).json({ error: { code: "tenant_not_found", message: "no such tenant" } });
    return;
  }

  let targetUserId: string;
  if (parsed.data.user_id) {
    const { data: mem, error: mErr } = await sb
      .from("tenant_users")
      .select("user_id")
      .eq("tenant_id", tenant_id)
      .eq("user_id", parsed.data.user_id)
      .maybeSingle<{ user_id: string }>();
    if (mErr) {
      res.status(500).json({ error: { code: "member_lookup_failed", message: mErr.message } });
      return;
    }
    if (!mem) {
      res.status(400).json({
        error: { code: "not_a_member", message: "user_id is not a member of tenant_id" },
      });
      return;
    }
    targetUserId = mem.user_id;
  } else {
    const { data: owner, error: oErr } = await sb
      .from("tenant_users")
      .select("user_id, created_at")
      .eq("tenant_id", tenant_id)
      .eq("role", "owner")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<{ user_id: string; created_at: string }>();
    if (oErr) {
      res.status(500).json({ error: { code: "owner_lookup_failed", message: oErr.message } });
      return;
    }
    if (!owner?.user_id) {
      res.status(404).json({
        error: { code: "no_owner", message: "tenant has no owner to impersonate" },
      });
      return;
    }
    targetUserId = owner.user_id;
  }

  const { data: userData, error: uErr } = await sb.auth.admin.getUserById(targetUserId);
  if (uErr || !userData?.user) {
    res.status(404).json({
      error: { code: "target_not_found", message: uErr?.message ?? "target user not found" },
    });
    return;
  }
  const target = userData.user;

  const targetAppMeta = (target.app_metadata ?? {}) as Record<string, unknown>;
  if (targetAppMeta.role === "staff") {
    res.status(403).json({
      error: { code: "staff_target_forbidden", message: "cannot impersonate a staff account" },
    });
    return;
  }

  const email = target.email;
  if (!email) {
    res.status(400).json({
      error: { code: "target_no_email", message: "target user has no email; cannot mint session" },
    });
    return;
  }

  const link = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error || !link.data?.properties?.hashed_token) {
    res.status(502).json({
      error: {
        code: "mint_failed",
        message: link.error?.message ?? "generateLink returned no token_hash",
      },
    });
    return;
  }
  const tokenHash = link.data.properties.hashed_token;

  const { data: verified, error: vErr } = await anonClient().auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  if (vErr || !verified?.session?.access_token || !verified.session.refresh_token) {
    res.status(502).json({
      error: { code: "session_mint_failed", message: vErr?.message ?? "verifyOtp returned no session" },
    });
    return;
  }
  const session = verified.session;

  const sessionId = sessionIdOfToken(session.access_token);
  if (!sessionId) {
    await sb.auth.admin.signOut(session.access_token, "local").catch(() => undefined);
    res.status(502).json({
      error: { code: "session_id_missing", message: "minted session carries no session_id; refused" },
    });
    return;
  }

  const { error: aErr } = await sb.rpc("admin_action_log_append", {
    p_staff_email: staff.email,
    p_tenant_id: tenant_id,
    p_task_id: null,
    p_action: "login_as",
    p_target: email,
    p_before: null,
    p_after: { target_user_id: targetUserId, tenant_slug: tenant.slug, session_id: sessionId },
    p_on_behalf: true,
  });
  if (aErr) {
    await sb.auth.admin.signOut(session.access_token, "local").catch(() => undefined);
    res.status(500).json({ error: { code: "audit_failed", message: aErr.message } });
    return;
  }

  await logEvent({
    level: "warn",
    source: "staff-login-as",
    code: "staff.login_as",
    message: `staff ${staff.email} logged in as ${email} (tenant ${tenant.slug})`,
    tenant_id,
  });

  res.json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in ?? null,
    expires_at: session.expires_at ?? null,
    target: {
      user_id: targetUserId,
      email,
      tenant_id,
      tenant_name: tenant.display_name || tenant.slug,
      tenant_slug: tenant.slug,
    },
  });
}
