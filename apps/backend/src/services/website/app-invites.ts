
import { createHash, randomBytes } from "node:crypto";
import type { Client } from "pg";
import type { TenantId } from "@/services/tenant-client";
import { AppDataError, withGeneratedAppClient, writeSiteAudit } from "@/services/website/app-data";

export const APP_INVITE_ROLES = ["user", "admin"] as const;
export type AppInviteRole = (typeof APP_INVITE_ROLES)[number];
export const APP_INVITE_TTL_DAYS = 7;
const MAX_PENDING_LISTED = 100;
const INVITE_COLUMNS = ["id", "token_hash", "role", "created_at", "expires_at", "used_at", "revoked_at"];

export type AppInvite = { id: string; role: string; created_at: string; expires_at: string };

export function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function iso(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function toInvite(row: Record<string, unknown>): AppInvite {
  return {
    id: String(row.id),
    role: String(row.role),
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
  };
}

async function assertRolesConfigured(client: Client): Promise<void> {
  const r = await client.query<{ users_role: boolean; invite_cols: number }>(
    `SELECT
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'role') AS users_role,
       (SELECT count(*)::int FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'invites'
           AND column_name = ANY($1::text[])) AS invite_cols`,
    [INVITE_COLUMNS],
  );
  const row = r.rows[0];
  if (!row?.users_role || Number(row.invite_cols) !== INVITE_COLUMNS.length) {
    throw new AppDataError("roles_not_configured", "Roles aren't set up on this site yet.");
  }
}

async function assertInviteEmailColumn(client: Client): Promise<void> {
  const r = await client.query<{ has_email: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'invites' AND column_name = 'email') AS has_email`,
  );
  if (!r.rows[0]?.has_email) {
    throw new AppDataError("roles_not_configured", "Invites on this site can't be tied to an email yet.");
  }
}

async function inTransaction<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function insertInvite(
  client: Client,
  token: string,
  role: AppInviteRole,
  inactive: boolean,
  email: string | null,
): Promise<AppInvite> {
  const r =
    email === null
      ? await client.query(
          `INSERT INTO public.invites (token_hash, role, expires_at, revoked_at)
         VALUES ($1, $2, now() + make_interval(days => $3), CASE WHEN $4 THEN now() ELSE NULL END)
         RETURNING id::text AS id, role::text AS role, created_at, expires_at`,
          [hashInviteToken(token), role, APP_INVITE_TTL_DAYS, inactive],
        )
      : await client.query(
          `INSERT INTO public.invites (token_hash, role, expires_at, revoked_at, email)
         VALUES ($1, $2, now() + make_interval(days => $3), CASE WHEN $4 THEN now() ELSE NULL END, lower($5))
         RETURNING id::text AS id, role::text AS role, created_at, expires_at`,
          [hashInviteToken(token), role, APP_INVITE_TTL_DAYS, inactive, email],
        );
  const created = toInvite(r.rows[0] as Record<string, unknown>);
  await writeSiteAudit(client, "app_invite_created", null, { invite_id: created.id, role: created.role });
  return created;
}

export async function createAppInvite(
  tenantId: TenantId,
  role: AppInviteRole,
  inactive = false,
  email: string | null = null,
): Promise<{ token: string; invite: AppInvite }> {
  return withGeneratedAppClient(tenantId, async (client) => {
    await assertRolesConfigured(client);
    if (email !== null) await assertInviteEmailColumn(client);
    const token = newInviteToken();
    const invite = await inTransaction(client, () => insertInvite(client, token, role, inactive, email));
    return { token, invite };
  });
}

export async function createOwnerAdminInvite(
  tenantId: TenantId,
  email: string,
): Promise<{ token: string; invite: AppInvite }> {
  return withGeneratedAppClient(tenantId, async (client) => {
    await assertRolesConfigured(client);
    await assertInviteEmailColumn(client);
    const token = newInviteToken();
    const invite = await inTransaction(client, async () => {
      const created = await insertInvite(client, token, "admin", true, email);
      const superseded = await client.query(
        `UPDATE public.invites SET revoked_at = now()
          WHERE role = 'admin' AND email IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL
            AND id <> $1::bigint
          RETURNING id::text AS id, role::text AS role`,
        [created.id],
      );
      for (const row of superseded.rows as Array<{ id: string; role: string }>) {
        await writeSiteAudit(client, "app_invite_revoked", null, { invite_id: String(row.id), role: String(row.role) });
      }
      return created;
    });
    return { token, invite };
  });
}

export async function activateAppInvite(tenantId: TenantId, id: string): Promise<AppInvite> {
  if (!/^[1-9]\d{0,18}$/.test(id)) throw new AppDataError("app_invite_not_found", "Invite not found.");
  return withGeneratedAppClient(tenantId, async (client) => {
    await assertRolesConfigured(client);
    const r = await client.query(
      `UPDATE public.invites SET revoked_at = NULL
        WHERE id = $1::bigint AND used_at IS NULL AND revoked_at IS NOT NULL AND expires_at > now()
        RETURNING id::text AS id, role::text AS role, created_at, expires_at`,
      [id],
    );
    if (r.rowCount === 1) return toInvite(r.rows[0] as Record<string, unknown>);
    const active = await client.query(
      `SELECT id::text AS id, role::text AS role, created_at, expires_at
         FROM public.invites
        WHERE id = $1::bigint AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [id],
    );
    if (active.rowCount !== 1) throw new AppDataError("app_invite_not_found", "Invite not found.");
    return toInvite(active.rows[0] as Record<string, unknown>);
  });
}

export async function hasOwnerAdminInvite(tenantId: TenantId, email: string): Promise<boolean> {
  return withGeneratedAppClient(tenantId, async (client) => {
    await assertRolesConfigured(client);
    await assertInviteEmailColumn(client);
    const r = await client.query(
      `SELECT 1 FROM public.invites
        WHERE role = 'admin' AND email = lower($1) AND revoked_at IS NULL
          AND (used_at IS NOT NULL OR expires_at > now())
        LIMIT 1`,
      [email],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

export async function listPendingAppInvites(tenantId: TenantId): Promise<AppInvite[]> {
  return withGeneratedAppClient(tenantId, async (client) => {
    await assertRolesConfigured(client);
    const r = await client.query(
      `SELECT id::text AS id, role::text AS role, created_at, expires_at
         FROM public.invites
        WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC, id DESC
        LIMIT ${MAX_PENDING_LISTED}`,
    );
    return (r.rows as Record<string, unknown>[]).map(toInvite);
  });
}

export async function revokeAppInvite(tenantId: TenantId, id: string): Promise<AppInvite> {
  if (!/^[1-9]\d{0,18}$/.test(id)) throw new AppDataError("app_invite_not_found", "Invite not found.");
  return withGeneratedAppClient(tenantId, async (client) => {
    await assertRolesConfigured(client);
    return inTransaction(client, async () => {
      const r = await client.query(
        `UPDATE public.invites SET revoked_at = now()
          WHERE id = $1::bigint AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          RETURNING id::text AS id, role::text AS role, created_at, expires_at`,
        [id],
      );
      if (r.rowCount !== 1) throw new AppDataError("app_invite_not_found", "Invite not found.");
      const revoked = toInvite(r.rows[0] as Record<string, unknown>);
      await writeSiteAudit(client, "app_invite_revoked", null, { invite_id: revoked.id, role: revoked.role });
      return revoked;
    });
  });
}
