
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { writeStaffAudit } from "@/services/staff/audit";

const REASON = "admin/super-users: staff-access management (staff_users)";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Identity = { email: string | null; name: string | null };

async function resolveIdentities(
  sb: ReturnType<typeof staffCrossTenantClient>,
  wanted?: Set<string>,
): Promise<Map<string, Identity>> {
  const out = new Map<string, Identity>();
  try {
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break;
      const users = data?.users ?? [];
      for (const u of users) {
        if (wanted && !wanted.has(u.id)) continue;
        const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
        out.set(u.id, {
          email: u.email ?? null,
          name: (meta.full_name as string) ?? (meta.name as string) ?? null,
        });
      }
      if (users.length < 1000) break;
    }
  } catch {
  }
  return out;
}

type StaffRow = {
  user_id: string;
  email: string | null;
  role: string;
  granted_at: string;
  granted_by_email: string | null;
};

export async function staffSuperUsersList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient(REASON);

  const { data, error } = await sb
    .from("staff_users")
    .select("user_id, email, role, granted_at, granted_by_email")
    .is("revoked_at", null)
    .order("granted_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: { code: "list_failed", message: error.message } });
    return;
  }

  const rows = (data ?? []) as StaffRow[];
  const identities = await resolveIdentities(sb, new Set(rows.map((r) => r.user_id)));

  const staff = rows.map((r) => {
    const id = identities.get(r.user_id);
    return {
      user_id: r.user_id,
      email: id?.email ?? r.email ?? null,
      name: id?.name ?? null,
      role: r.role,
      granted_at: r.granted_at,
      granted_by: r.granted_by_email,
    };
  });

  res.json({ staff, summary: { count: staff.length } });
}

export async function staffSuperUsersCandidates(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient(REASON);

  const q = (typeof req.query.search === "string" ? req.query.search : "").trim().toLowerCase();
  if (q.length < 2) {
    res.json({ candidates: [], note: "Type at least 2 characters." });
    return;
  }

  const activeRes = await sb.from("staff_users").select("user_id").is("revoked_at", null);
  const activeIds = new Set(((activeRes.data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));

  const all = await resolveIdentities(sb);
  const candidates: Array<{ user_id: string; email: string | null; name: string | null; is_staff: boolean }> = [];
  for (const [user_id, id] of all) {
    const hay = `${id.email ?? ""} ${id.name ?? ""}`.toLowerCase();
    if (!hay.includes(q)) continue;
    candidates.push({ user_id, email: id.email, name: id.name, is_staff: activeIds.has(user_id) });
    if (candidates.length >= 25) break;
  }

  res.json({ candidates });
}

export async function staffSuperUsersGrant(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const sb = staffCrossTenantClient(REASON);

  const body = (req.body ?? {}) as { user_id?: unknown; note?: unknown };
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (!UUID_RE.test(userId)) {
    res.status(400).json({ error: { code: "bad_user_id", message: "user_id must be a UUID." } });
    return;
  }

  const userRes = await sb.auth.admin.getUserById(userId);
  const authUser = userRes.data?.user;
  if (userRes.error || !authUser) {
    res.status(404).json({ error: { code: "user_not_found", message: "No auth user with that id." } });
    return;
  }

  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  const { error } = await sb.from("staff_users").upsert(
    {
      user_id: userId,
      email: authUser.email ?? null,
      role: "staff",
      granted_by: staff.user_id,
      granted_by_email: staff.email,
      granted_at: new Date().toISOString(),
      revoked_at: null,
      revoked_by: null,
      revoked_by_email: null,
      note,
    },
    { onConflict: "user_id" },
  );
  if (error) {
    res.status(500).json({ error: { code: "grant_failed", message: error.message } });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "staff.grant",
    target_table: "staff_users",
    target_id: userId,
    meta: { target_email: authUser.email ?? null },
  });

  res.json({ ok: true, user_id: userId, email: authUser.email ?? null });
}

export async function staffSuperUsersRevoke(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const sb = staffCrossTenantClient(REASON);

  const body = (req.body ?? {}) as { user_id?: unknown };
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (!UUID_RE.test(userId)) {
    res.status(400).json({ error: { code: "bad_user_id", message: "user_id must be a UUID." } });
    return;
  }

  const activeRes = await sb.from("staff_users").select("user_id, email").is("revoked_at", null);
  if (activeRes.error) {
    res.status(500).json({ error: { code: "revoke_failed", message: activeRes.error.message } });
    return;
  }
  const active = (activeRes.data ?? []) as Array<{ user_id: string; email: string | null }>;
  const target = active.find((r) => r.user_id === userId);

  if (!target) {
    res.json({ ok: true, user_id: userId, already_revoked: true });
    return;
  }

  if (active.length <= 1) {
    res.status(409).json({
      error: {
        code: "last_staff",
        message: "Cannot revoke the only remaining staff member. Grant another first.",
      },
    });
    return;
  }

  const { error } = await sb
    .from("staff_users")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: staff.user_id,
      revoked_by_email: staff.email,
    })
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) {
    res.status(500).json({ error: { code: "revoke_failed", message: error.message } });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "staff.revoke",
    target_table: "staff_users",
    target_id: userId,
    meta: { target_email: target.email },
  });

  res.json({ ok: true, user_id: userId });
}
