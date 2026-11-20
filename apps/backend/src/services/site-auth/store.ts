
import { Pool } from "pg";
import { SHARD_RULE_ERRORS, SiteAuthError, type SiteAuthErrorCode } from "./errors";
import type { ClaimOutcome, ConfirmBegin, FormNoticeLease, FormNoticeRow, IdentityRow, MemberRow, OutboxRow, ShardStore } from "./types";
import { supabasePgConfig } from "@/services/site-shards/supabase-ca";

type Query = (sql: string, params: unknown[]) => Promise<Array<Record<string, any>>>;

function epochSeconds(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function identity(r: Record<string, any>, siteId?: string): IdentityRow {
  return {
    siteId: r.site_id ?? siteId,
    emailNorm: r.email_norm,
    alias: r.alias,
    state: r.state,
    role: r.role ?? null,
    memberStatus: r.member_status ?? null,
    sessionsValidAfter: epochSeconds(r.sessions_valid_after),
  };
}

function member(r: Record<string, any>): MemberRow {
  const created = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at);
  return { user_id: r.user_id, email: r.email, role: r.role, status: r.status, created_at: created };
}

export function mapShardError(e: unknown): unknown {
  const msg = (e as { message?: unknown })?.message;
  const head = typeof msg === "string" ? msg.split(":")[0].trim() : "";
  if (SHARD_RULE_ERRORS.has(head as SiteAuthErrorCode)) return new SiteAuthError(head as SiteAuthErrorCode);
  return e;
}

const leaseJson = (leases: FormNoticeLease[]) => JSON.stringify(leases.map((l) => ({ id: String(l.id), token: l.leaseToken })));

export function createShardStore(rawQuery: Query): ShardStore {
  const query: Query = async (sql, params) => {
    try {
      return await rawQuery(sql, params);
    } catch (e) {
      throw mapShardError(e);
    }
  };
  const one = async (sql: string, params: unknown[]) => (await query(sql, params))[0] ?? null;
  const bool = async (sql: string, params: unknown[]) => Boolean(Object.values((await one(sql, params)) ?? {})[0]);
  const memberOne = async (sql: string, params: unknown[]) => {
    const r = await one(sql, params);
    if (!r) throw new SiteAuthError("member_not_found");
    return member(r);
  };
  return {
    async identityByUser(uid) {
      const r = await one("select * from zsite_auth.identity_by_user_v2($1)", [uid]);
      return r ? identity(r) : null;
    },
    async identityByEmail(siteId, email) {
      const r = await one("select * from zsite_auth.identity_by_email($1, $2)", [siteId, email]);
      return r ? { ...identity(r, siteId), authUserId: r.auth_user_id, emailNorm: email } : null;
    },
    async resolveAlias(alias) {
      const rows = await query("select * from zsite_auth.resolve_alias($1)", [alias]);
      return rows.map((r) => ({
        siteId: r.site_id,
        authUserId: r.auth_user_id,
        emailNorm: r.email_norm,
        kind: r.kind,
        state: r.state,
      }));
    },

    async signupRequest(a) {
      await query("select zsite_auth.signup_request($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
        a.siteId, a.email, a.alias, a.uid, a.challengeId, a.tokenSha256, a.ttlSeconds, a.cooldownSeconds, a.maxLive,
      ]);
    },
    async signupConfirmBegin(siteId, sha, lease) {
      const r = await one("select * from zsite_auth.signup_confirm_begin($1, $2, $3)", [siteId, sha, lease]);
      if (r?.outcome === "ok") {
        return { outcome: "ok", authUserId: r.auth_user_id, email: r.email_norm, alias: r.alias } satisfies ConfirmBegin;
      }
      if (r?.outcome === "done") return { outcome: "done", authUserId: r.auth_user_id, alias: r.alias };
      const o = r?.outcome;
      return { outcome: o === "busy" || o === "expired" ? o : "invalid" };
    },
    signupConfirmRelease: (s, sha) => bool("select zsite_auth.signup_confirm_release($1, $2)", [s, sha]),
    signupQuarantine: (s, sha) => bool("select zsite_auth.signup_quarantine($1, $2)", [s, sha]),
    async signupConfirmFinish(siteId, sha) {
      const r = await one("select zsite_auth.signup_confirm_finish($1, $2) as o", [siteId, sha]);
      return r?.o === "ok" || r?.o === "conflict" || r?.o === "done" ? r.o : "invalid";
    },
    async signupPurge(limit) {
      const rows = await query("select * from zsite_auth.signup_purge($1)", [limit]);
      return rows.map((r) => ({ siteId: r.site_id, authUserId: r.auth_user_id, alias: r.alias }));
    },
    async outboxClaim(limit, lease) {
      const rows = await query("select * from zsite_auth.outbox_claim($1, $2)", [limit, lease]);
      return rows.map(
        (r): OutboxRow => ({ id: String(r.id), siteId: r.site_id, to: r.to_email, kind: r.kind, challengeId: r.challenge_id ?? null }),
      );
    },
    outboxDone: (id) => bool("select zsite_auth.outbox_done($1)", [id]),
    outboxDefer: (id, secs) => bool("select zsite_auth.outbox_defer($1, $2)", [id, secs]),

    async formNotifyClaim(limit, lease) {
      const rows = await query("select * from zsite_auth.form_notify_claim($1, $2)", [limit, lease]);
      return rows.map(
        (r): FormNoticeRow => ({
          id: String(r.id),
          leaseToken: String(r.lease_token),
          siteId: r.site_id,
          collection: r.collection,
          recordId: r.record_id,
          data: r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : {},
          fields: r.fields && typeof r.fields === "object" && !Array.isArray(r.fields) ? r.fields : {},
          createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        }),
      );
    },
    async formNotifyPurge(limit) {
      const rows = await query("select * from zsite_auth.form_notify_purge($1)", [limit]);
      return rows.map((r) => ({ reason: String(r.reason), n: Number(r.n) }));
    },
    async formNotifyBacklog() {
      const r = await one("select * from zsite_auth.form_notify_backlog()", []);
      return { pending: Number(r?.pending ?? 0), oldestAgeS: Number(r?.oldest_age_s ?? 0) };
    },
    async formNotifyDone(leases) {
      if (!leases.length) return 0;
      const r = await one("select zsite_auth.form_notify_done($1::jsonb) as n", [leaseJson(leases)]);
      return Number(r?.n ?? 0);
    },
    async formNotifyDefer(leases, secs) {
      if (!leases.length) return 0;
      const r = await one("select zsite_auth.form_notify_defer($1::jsonb, $2) as n", [leaseJson(leases), secs]);
      return Number(r?.n ?? 0);
    },

    async submissionStats(siteId, w) {
      const rows = await query(
        "select collection, via_action, to_char(day, 'YYYY-MM-DD') as day, n, prev_n, total_n, last_at from zsite_auth.site_submission_stats($1, $2, $3, $4, $5)",
        [siteId, w.since.toISOString(), w.until.toISOString(), w.prevSince.toISOString(), w.tz],
      );
      const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      return rows.map((r) => ({
        collection: String(r.collection),
        viaAction: r.via_action === true,
        day: typeof r.day === "string" ? r.day : null,
        n: num(r.n),
        prevN: num(r.prev_n),
        totalN: num(r.total_n),
        lastAt: r.last_at === null || r.last_at === undefined ? null : new Date(r.last_at).toISOString(),
      }));
    },

    async provisionIdentity(siteId, email, alias, uid) {
      const r = await one("select * from zsite_auth.provision_identity($1, $2, $3, $4)", [siteId, email, alias, uid]);
      if (r?.outcome === "created" || r?.outcome === "exists") {
        return { outcome: r.outcome, authUserId: r.auth_user_id, state: r.state };
      }
      return r?.outcome === "reserved" ? { outcome: "reserved" } : { outcome: "site_unavailable" };
    },
    bootstrapAdmin: (s, u) => bool("select zsite_auth.bootstrap_admin($1, $2)", [s, u]),
    revokeSessions: (s, u) => bool("select zsite_auth.revoke_sessions($1, $2)", [s, u]),
    async memberInviteReserve(siteId, actor, email, alias, uid, role) {
      const r = await one("select * from zsite_auth.member_invite_reserve($1, $2, $3, $4, $5, $6)", [
        siteId, actor, email, alias, uid, role,
      ]);
      const outcome = r?.outcome === "create" || r?.outcome === "exists" ? r.outcome : "held";
      return { outcome, authUserId: r?.auth_user_id ?? null };
    },
    memberInviteFinish: (s, a, u) => bool("select zsite_auth.member_invite_finish($1, $2, $3)", [s, a, u]),
    async memberList(siteId, actor, cursor, limit) {
      const rows = await query("select * from zsite_auth.member_list($1, $2, $3, $4)", [siteId, actor, cursor, limit]);
      return rows.map(member);
    },
    memberSetRole: (s, a, u, role) => memberOne("select * from zsite_auth.member_set_role($1, $2, $3, $4)", [s, a, u, role]),
    memberDisable: (s, a, u) => memberOne("select * from zsite_auth.member_disable($1, $2, $3)", [s, a, u]),
    memberRemoveBegin: (s, a, u) => bool("select zsite_auth.member_remove_begin($1, $2, $3)", [s, a, u]),
    memberEnable: (s, a, u) => memberOne("select * from zsite_auth.member_enable($1, $2, $3)", [s, a, u]),
    async memberReassignRecord(s, a, collection, recordId, to) {
      const r = await one("select * from zsite_auth.member_reassign_record($1, $2, $3, $4, $5)", [s, a, collection, recordId, to]);
      return { id: r!.id, owner_id: r!.owner_id };
    },
    memberDeleteDataBegin: (s, a, u, c) => bool("select zsite_auth.member_delete_data_begin($1, $2, $3, $4)", [s, a, u, c]),

    async beginEmailChange(siteId, uid, newEmail, newAlias, sha, ttl) {
      const r = await one("select zsite_auth.begin_email_change($1, $2, $3, $4, $5, $6) as o", [
        siteId, uid, newEmail, newAlias, sha, ttl,
      ]);
      return r?.o;
    },
    async claimEmailChange(siteId, sha) {
      const r = await one("select * from zsite_auth.claim_email_change($1, $2)", [siteId, sha]);
      if (r?.outcome !== "ok") return { outcome: (r?.outcome ?? "invalid") as "invalid" | "used" | "expired" };
      return {
        outcome: "ok",
        id: r.id,
        authUserId: r.auth_user_id,
        oldEmail: r.old_email_norm,
        newEmail: r.new_email_norm,
        newAlias: r.new_alias,
      } satisfies ClaimOutcome;
    },
    async commitEmailChange(id) {
      const r = await one("select * from zsite_auth.commit_email_change($1)", [id]);
      return { oldEmail: r!.old_email_norm, newEmail: r!.new_email_norm };
    },
    failEmailChange: (id) => bool("select zsite_auth.fail_email_change($1)", [id]),
    beginDeletion: (s, u) => bool("select zsite_auth.begin_deletion($1, $2)", [s, u]),
    async userObjectNames(siteId, uid, limit) {
      const rows = await query("select n from zsite_auth.user_object_names($1, $2, $3) n", [siteId, uid, limit]);
      return rows.map((r) => r.n as string);
    },
    async deleteAccountData(siteId, uid) {
      const r = await one("select zsite_auth.delete_account_data($1, $2) as n", [siteId, uid]);
      return Number(r?.n ?? 0);
    },
    finishDeletion: (u) => bool("select zsite_auth.finish_deletion($1)", [u]),
    async pendingDeletions(limit) {
      const rows = await query("select * from zsite_auth.pending_deletions($1)", [limit]);
      return rows.map((r) => ({ authUserId: r.auth_user_id, siteId: r.site_id }));
    },
    rateTake: (key, win, max) => bool("select zsite_auth.rate_take($1, $2, $3)", [key, win, max]),
    claimNonce: (nonce, ttl) => bool("select zsite_auth.claim_nonce($1, $2)", [nonce, ttl]),
  };
}

export function createPgShardStore(dbUrl: string): ShardStore {
  const pool = new Pool({ ...supabasePgConfig(dbUrl), max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8_000, query_timeout: 12_000 });
  pool.on("error", () => {});
  return createShardStore(async (sql, params) => (await pool.query(sql, params)).rows);
}
