import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verdictFor } from "@/services/channels/exec-failure";
import { FIELD_REQUIRED, MUTATE_NOT_ALLOWED } from "@/services/channels/__tests__/exec-failure.fixtures";

const dir = join(__dirname, "../../../../../supabase/migrations");
const BUCKET = readFileSync(join(dir, "20261009100000_channel_action_exec_bucket.sql"), "utf8");
const APPROVE = readFileSync(join(dir, "20261009100050_approve_channel_action_refuse_blocked.sql"), "utf8");

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table tenant_users (tenant_id uuid not null, user_id uuid not null, primary key (tenant_id, user_id));
  create table channel_actions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    channel_slug text not null,
    run_id uuid not null,
    title text not null default 't',
    body jsonb not null default '{}',
    status text not null default 'pending'
      check (status in ('pending','acted','rejected','snoozed','redone','stale','displaced')),
    status_at timestamptz,
    note text check (note is null or char_length(note) <= 1000),
    exec_class text,
    exec_payload jsonb,
    exec_status text check (exec_status in ('queued','dispatching','executed','failed')),
    exec_result jsonb,
    executed_at timestamptz,
    approved_by uuid,
    approved_by_source text,
    exec_claim_id uuid,
    exec_claimed_at timestamptz,
    unique (tenant_id, id)
  );
  create table channel_action_events (
    id bigint generated always as identity primary key,
    tenant_id uuid not null,
    action_id uuid not null references channel_actions(id) on delete cascade,
    event text not null check (event in (
      'proposed','acted','rejected','snoozed','redo_requested','redone','stale_flagged',
      'displaced','revised','approved','executed','exec_failed')),
    actor_kind text not null check (actor_kind in ('founder','channel_run','system')),
    actor_user_id uuid,
    run_id uuid,
    note text check (note is null or char_length(note) <= 1000),
    event_key text not null check (char_length(event_key) between 1 and 200),
    at timestamptz not null default now(),
    unique (action_id, event_key)
  );
`;

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const T = randomUUID();
const T2 = randomUUID();
const USER = randomUUID();
const BLOCKED_NOTE = "Google Ads refused this change, so Zavi closed the card. We've been alerted; nothing for you to do.";

describe.skipIf(!PG_URL)("exec bucket migrations, live", () => {
  let db: Client;
  const legacy: Record<string, string> = {};

  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> =>
    (await db.query(sql, params)).rows[0] as R;
  const row = (id: string) =>
    one<{ status: string; note: string | null; exec_status: string | null; exec_result: Record<string, unknown> | null }>(
      "select status, note, exec_status, exec_result from channel_actions where id = $1",
      [id],
    );
  const alerts = async (id: string) =>
    Number((await one<{ n: string }>("select count(*) n from ops_alert_outbox where dedupe_key = $1", [`blocked:${id}`])).n);
  const insert = async (o: Record<string, unknown>): Promise<string> => {
    const r = await one<{ id: string }>(
      `insert into channel_actions (tenant_id, channel_slug, run_id, status, exec_class, exec_status, exec_result, exec_claim_id, exec_claimed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [o.tenant_id ?? T, o.channel_slug ?? "google_ads", o.run_id ?? randomUUID(), o.status ?? "pending", o.exec_class ?? "google_ads.create_campaign",
       o.exec_status ?? null, o.exec_result === undefined ? null : JSON.stringify(o.exec_result), o.exec_claim_id ?? null, o.exec_claimed_at ?? null],
    );
    return r.id;
  };
  const dispatching = (o: Record<string, unknown> = {}) => {
    const claim = randomUUID();
    return insert({ exec_status: "dispatching", exec_claim_id: claim, exec_claimed_at: new Date().toISOString(), ...o }).then((id) => ({ id, claim }));
  };
  const settle = (id: string, claim: string | null, ok: boolean, result: Record<string, unknown>, error: string | null) =>
    one<{ r: Record<string, unknown> }>("select settle_channel_action_exec($1, $2, $3, $4::jsonb, $5, $6) r", [T, id, ok, JSON.stringify(result), error, claim]).then((x) => x.r);
  const approve = (id: string, key = randomUUID()) =>
    one<{ r: Record<string, unknown> }>("select approve_channel_action($1, $2, $3, $4) r", [T, id, key, USER]).then((x) => x.r);

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.channel_actions')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database (channel_actions already exists)");
    await db.query("begin");
    await db.query(BOOTSTRAP);
    await db.query("insert into tenant_users values ($1, $2)", [T, USER]);
    legacy.openBlocked = await insert({ status: "pending", exec_status: "failed", exec_result: { error: MUTATE_NOT_ALLOWED } });
    legacy.rejectedBlocked = await insert({ status: "rejected", exec_status: "failed", exec_result: { error: FIELD_REQUIRED } });
    legacy.openTemporary = await insert({ status: "snoozed", exec_status: "failed", exec_result: { error: "socket hang up" }, channel_slug: "meta_ads", exec_class: "meta_ads.set_status" });
    legacy.held = await insert({ status: "pending", exec_status: "failed", exec_result: { error: "held", held_for_founder: true } });
    legacy.executed = await insert({ status: "acted", exec_status: "executed", exec_result: { notice: null } });
    await db.query(BUCKET);
    await db.query(APPROVE);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  describe("the legacy stamp (migration step 6)", () => {
    it("closes the open blocked card, with the clean note, one event and one alert", async () => {
      const r = await row(legacy.openBlocked);
      expect(r.status).toBe("stale");
      expect(r.note).toBe(BLOCKED_NOTE);
      expect(r.exec_result).toMatchObject({ error: MUTATE_NOT_ALLOWED, bucket: "blocked_on_us", fix: null, platform_code: "UNKNOWN,MUTATE_NOT_ALLOWED,RESOURCE_NOT_FOUND" });
      expect(await alerts(legacy.openBlocked)).toBe(1);
      const ev = await one<{ n: string }>("select count(*) n from channel_action_events where action_id = $1 and event = 'stale_flagged'", [legacy.openBlocked]);
      expect(Number(ev.n)).toBe(1);
    });
    it("stamps a closed blocked card without re-opening, re-closing or alerting it", async () => {
      const r = await row(legacy.rejectedBlocked);
      expect(r.status).toBe("rejected");
      expect(r.exec_result).toMatchObject({ bucket: "blocked_on_us", platform_code: "REQUIRED" });
      expect(await alerts(legacy.rejectedBlocked)).toBe(0);
    });
    it("a temporary failure stays open; a founder hold and an executed row get no verdict", async () => {
      expect(await row(legacy.openTemporary)).toMatchObject({ status: "snoozed", exec_result: { bucket: "temporary" } });
      expect((await row(legacy.held)).exec_result).toEqual({ error: "held", held_for_founder: true });
      expect((await row(legacy.executed)).exec_result).toEqual({ notice: null });
    });
    it("the legacy blocked card cannot be approved again", async () => {
      expect(await approve(legacy.openBlocked)).toEqual({ ok: false, code: "exec_blocked_no_retry" });
    });
  });

  describe("settle_channel_action_exec", () => {
    it("a blocked failure with the facade's verdict closes once and alerts once, however often it is retried", async () => {
      const { id, claim } = await dispatching();
      const v = verdictFor({ error: MUTATE_NOT_ALLOWED }, "google_ads.create_campaign")!;
      const { note, ...stamp } = v;
      const first = await settle(id, claim, false, { error: MUTATE_NOT_ALLOWED, ...stamp }, note);
      expect(first).toEqual({ ok: true, executed: false });
      const again = await settle(id, claim, false, { error: MUTATE_NOT_ALLOWED, ...stamp }, note);
      expect(again).toMatchObject({ ok: true, replayed: true });
      expect(await row(id)).toMatchObject({ status: "stale", note: BLOCKED_NOTE, exec_status: "failed", exec_result: { bucket: "blocked_on_us" } });
      expect(await alerts(id)).toBe(1);
      expect(await approve(id)).toEqual({ ok: false, code: "exec_blocked_no_retry" });
    });
    it("a failure with NO verdict (an old container) is classified in SQL", async () => {
      const { id, claim } = await dispatching();
      await settle(id, claim, false, { error: FIELD_REQUIRED }, "raw");
      expect(await row(id)).toMatchObject({ status: "stale", note: BLOCKED_NOTE, exec_result: { error: FIELD_REQUIRED, bucket: "blocked_on_us", platform_code: "REQUIRED" } });
      expect(await alerts(id)).toBe(1);
    });
    it("a temporary failure stays open and a re-approve starts a fresh attempt", async () => {
      const { id, claim } = await dispatching({ channel_slug: "meta_ads", exec_class: "meta_ads.set_status" });
      await settle(id, claim, false, { error: "socket hang up", bucket: "temporary", fix: null, platform_code: null }, "socket hang up");
      expect(await row(id)).toMatchObject({ status: "pending", note: "socket hang up", exec_result: { bucket: "temporary" } });
      expect(await alerts(id)).toBe(0);
      expect(await approve(id)).toMatchObject({ ok: true, replayed: false });
      expect(await row(id)).toMatchObject({ exec_status: "queued", exec_result: null });
    });
    it("needs_founder stays approvable (the fix happens outside the card)", async () => {
      const { id, claim } = await dispatching({ channel_slug: "meta_ads", exec_class: "meta_ads.set_status" });
      await settle(id, claim, false, { error: "token", code: "meta_ads_token_expired", bucket: "needs_founder", fix: "reconnect", platform_code: null }, "token");
      expect(await row(id)).toMatchObject({ status: "pending", exec_result: { bucket: "needs_founder", fix: "reconnect" } });
      expect(await approve(id)).toMatchObject({ ok: true });
    });
    it("a partial-risk verdict is refused like a partial-risk code", async () => {
      const { id, claim } = await dispatching();
      await settle(id, claim, false, { error: "x", code: "google_ads_mutate_incomplete", bucket: "partial_risk", fix: null, platform_code: null }, "x");
      expect(await row(id)).toMatchObject({ status: "pending", exec_result: { bucket: "partial_risk" } });
      expect(await approve(id)).toEqual({ ok: false, code: "exec_partial_no_retry" });
    });
    it("a retried click whose attempt failed blocked in between hears blocked, never a replayed 'queued'", async () => {
      const { id, claim } = await dispatching();
      await settle(id, claim, false, { error: "socket hang up", bucket: "temporary", fix: null, platform_code: null }, "socket hang up");
      const key = randomUUID();
      expect(await approve(id, key)).toMatchObject({ ok: true, replayed: false });
      const claim2 = randomUUID();
      await db.query("update channel_actions set exec_status = 'dispatching', exec_claim_id = $2, exec_claimed_at = now() where id = $1", [id, claim2]);
      const v = verdictFor({ error: MUTATE_NOT_ALLOWED }, "google_ads.create_campaign")!;
      const { note, ...stamp } = v;
      await settle(id, claim2, false, { error: MUTATE_NOT_ALLOWED, ...stamp }, note);
      expect(await approve(id, key)).toEqual({ ok: false, code: "exec_blocked_no_retry" });
    });
    it("junk in the verdict is not stored: an unknown fix and a non-string code are dropped", async () => {
      const { id, claim } = await dispatching();
      await settle(id, claim, false, { error: "socket hang up", bucket: "temporary", fix: "drop table", platform_code: 7 }, "e");
      expect((await row(id)).exec_result).toMatchObject({ bucket: "temporary", fix: null, platform_code: null });
    });
    it("a founder hold is stamped with nothing and stays approvable", async () => {
      const { id, claim } = await dispatching();
      await settle(id, claim, false, { error: "held", held_for_founder: true }, "held");
      expect((await row(id)).exec_result).toEqual({ error: "held", held_for_founder: true });
      expect(await approve(id)).toMatchObject({ ok: true });
    });
    it("a success is untouched by the verdict helper", async () => {
      const { id, claim } = await dispatching();
      expect(await settle(id, claim, true, { notice: "n" }, null)).toEqual({ ok: true, executed: true });
      expect(await row(id)).toMatchObject({ status: "acted", exec_status: "executed", exec_result: { notice: "n" } });
    });
    it("a blocked failure on a card that is no longer open is stamped but not closed or alerted", async () => {
      const { id, claim } = await dispatching({ status: "rejected" });
      await settle(id, claim, false, { error: MUTATE_NOT_ALLOWED }, "raw");
      expect(await row(id)).toMatchObject({ status: "rejected", note: "raw", exec_result: { bucket: "blocked_on_us" } });
      expect(await alerts(id)).toBe(0);
    });
  });

  describe("set_channel_action_video_media", () => {
    const video = async () => {
      const run = randomUUID();
      const { id, claim } = await dispatching({ run_id: run, channel_slug: "generated_video", exec_class: "generated_video.render.v1" });
      return { id, claim, run };
    };
    const media = (v: { id: string; claim: string; run: string }, code: string | null, verdict: Record<string, unknown> | null) =>
      one<{ r: Record<string, unknown> }>(
        "select set_channel_action_video_media($1, $2, $3, $4, false, null, $5, $6, $7::jsonb) r",
        [v.id, T, v.run, v.claim, "Not enough credits", code, verdict === null ? null : JSON.stringify(verdict)],
      ).then((x) => x.r);

    it("stores the facade's verdict next to the code", async () => {
      const v = await video();
      expect(await media(v, "insufficient_credits", { bucket: "needs_founder", fix: "credits", platform_code: null, note: null })).toEqual({ ok: true, executed: false });
      expect((await row(v.id)).exec_result).toEqual({ error: "Not enough credits", code: "insufficient_credits", bucket: "needs_founder", fix: "credits", platform_code: null });
    });
    it("with no verdict (an old container) classifies the stored code in SQL", async () => {
      const v = await video();
      await media(v, "insufficient_credits", null);
      expect((await row(v.id)).exec_result).toMatchObject({ bucket: "needs_founder", fix: "credits" });
    });
    it("the old 8-argument overload is gone", async () => {
      const r = await one<{ n: string }>("select count(*) n from pg_proc where proname = 'set_channel_action_video_media'");
      expect(Number(r.n)).toBe(1);
    });
  });

  describe("stamp_channel_action_exec_verdict + list_failed_open_channel_actions", () => {
    const stamp = (tenant: string, id: string, verdict: Record<string, unknown>, force = false) =>
      one<{ r: Record<string, unknown> }>("select stamp_channel_action_exec_verdict($1, $2, $3::jsonb, $4) r", [tenant, id, JSON.stringify(verdict), force]).then((x) => x.r);

    it("replays a stamped card; refuses a foreign tenant and a card that did not fail", async () => {
      expect(await stamp(T, legacy.openTemporary, { bucket: "blocked_on_us" })).toEqual({ ok: true, replayed: true });
      expect(await stamp(T2, legacy.openTemporary, { bucket: "temporary" })).toEqual({ ok: false, code: "not_found" });
      expect(await stamp(T, legacy.executed, { bucket: "temporary" })).toEqual({ ok: false, code: "not_failed" });
      expect((await row(legacy.openTemporary)).status).toBe("snoozed");
    });
    it("force re-classifies (and closes + alerts once when the new verdict is blocked); an identical verdict replays", async () => {
      const id = await insert({ status: "pending", exec_status: "failed", exec_result: { error: "odd", bucket: "temporary", fix: null, platform_code: null } });
      expect(await stamp(T, id, { bucket: "temporary", fix: null, platform_code: null }, true)).toEqual({ ok: true, replayed: true });
      expect(await stamp(T, id, { bucket: "blocked_on_us", fix: null, platform_code: "X" }, true)).toMatchObject({ ok: true, replayed: false, closed: true, bucket: "blocked_on_us" });
      expect(await row(id)).toMatchObject({ status: "stale", exec_result: { bucket: "blocked_on_us", platform_code: "X" } });
      expect(await alerts(id)).toBe(1);
      await stamp(T, id, { bucket: "temporary" }, true);
      expect((await row(id)).status).toBe("stale");
      expect(await alerts(id)).toBe(1);
    });
    it("pages failed OPEN cards by id", async () => {
      const all = (await db.query("select id from list_failed_open_channel_actions(null, 500)")).rows.map((r) => r.id as string);
      expect(all).toEqual([...all].sort());
      expect(all).toContain(legacy.openTemporary);
      expect(all).not.toContain(legacy.openBlocked);
      expect(all).not.toContain(legacy.rejectedBlocked);
      const page = (await db.query("select id from list_failed_open_channel_actions($1, 1)", [all[0]])).rows.map((r) => r.id);
      expect(page).toEqual(all.slice(1, 2));
    });
  });

  describe("ops_alert_outbox", () => {
    it("claims due rows under a lease; the attempt is a fencing token; failures back off; 10 failures park the row", async () => {
      await db.query("update ops_alert_outbox set status = 'sent'");
      expect(await one<{ r: boolean }>("select enqueue_ops_alert('k1', 'src', 'code', null, 'msg') r")).toEqual({ r: true });
      expect(await one<{ r: boolean }>("select enqueue_ops_alert('k1', 'src', 'code', null, 'msg again') r")).toEqual({ r: false });
      const c1 = (await db.query("select * from claim_ops_alerts(10)")).rows;
      expect(c1.map((r) => [r.dedupe_key, r.attempts, r.status])).toEqual([["k1", 1, "sending"]]);
      expect((await db.query("select * from claim_ops_alerts(10)")).rows).toEqual([]);
      expect(await one("select finish_ops_alert($1, 2, true, null) r", [c1[0].id])).toEqual({ r: false });
      expect(await one("select finish_ops_alert($1, 1, false, 'webhook 503') r", [c1[0].id])).toEqual({ r: true });
      const after = await one<{ status: string; last_error: string; due_in: number }>(
        "select status, last_error, extract(epoch from next_attempt_at - now())::int due_in from ops_alert_outbox where id = $1", [c1[0].id]);
      expect(after).toMatchObject({ status: "pending", last_error: "webhook 503" });
      expect(after.due_in).toBeGreaterThanOrEqual(29);
      await db.query("update ops_alert_outbox set attempts = 9, next_attempt_at = now() - interval '1 second' where id = $1", [c1[0].id]);
      const c2 = (await db.query("select * from claim_ops_alerts(10)")).rows;
      expect(c2[0].attempts).toBe(10);
      await one("select finish_ops_alert($1, 10, false, 'webhook 503') r", [c1[0].id]);
      expect((await one<{ status: string }>("select status from ops_alert_outbox where id = $1", [c1[0].id])).status).toBe("failed");
    });
    it("a delivered alert is marked sent", async () => {
      await one("select enqueue_ops_alert('k2', 'src', 'code', null, 'm')");
      const c = (await db.query("select * from claim_ops_alerts(10)")).rows.find((r) => r.dedupe_key === "k2");
      expect(await one("select finish_ops_alert($1, $2, true, null) r", [c.id, c.attempts])).toEqual({ r: true });
      expect(await one("select status, sent_at is not null s from ops_alert_outbox where id = $1", [c.id])).toEqual({ status: "sent", s: true });
    });
    it("enqueue refuses an empty key", async () => {
      await db.query("savepoint s");
      await expect(db.query("select enqueue_ops_alert('  ', 'src', 'code', null, 'm')")).rejects.toThrow(/required/);
      await db.query("rollback to savepoint s");
    });
  });

  it("grants: service_role only; the verdict helper is callable by no API role", async () => {
    const can = async (role: string, sig: string) =>
      (await one<{ c: boolean }>("select has_function_privilege($1, $2, 'execute') c", [role, sig])).c;
    for (const sig of [
      "settle_channel_action_exec(uuid, uuid, boolean, jsonb, text, uuid)",
      "set_channel_action_video_media(uuid, uuid, uuid, uuid, boolean, jsonb, text, text, jsonb)",
      "approve_channel_action(uuid, uuid, text, uuid, text)",
      "stamp_channel_action_exec_verdict(uuid, uuid, jsonb, boolean)",
      "list_failed_open_channel_actions(uuid, int)",
      "enqueue_ops_alert(text, text, text, uuid, text)",
      "claim_ops_alerts(int)",
      "finish_ops_alert(bigint, int, boolean, text)",
    ]) {
      expect(await can("service_role", sig), sig).toBe(true);
      expect(await can("authenticated", sig), sig).toBe(false);
      expect(await can("anon", sig), sig).toBe(false);
    }
    for (const role of ["service_role", "authenticated", "anon"]) {
      expect(await can(role, "apply_exec_failure_verdict(uuid, uuid, uuid, jsonb)"), role).toBe(false);
    }
  });
});
