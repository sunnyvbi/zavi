import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { isUntouchedPending } from "@/services/channels/supersede-actions";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260919060402_channel_action_exec.sql"),
  "utf8",
);
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const RPCS = [
  "record_channel_exec_action(uuid, uuid, jsonb)",
  "approve_channel_action(uuid, uuid, text, uuid, text)",
  "claim_channel_action_exec(uuid)",
  "settle_channel_action_exec(uuid, uuid, boolean, jsonb, text, uuid)",
];
const esc = (s: string) => s.replace(/[()]/g, (c) => `\\${c}`);

describe("pending advertising revision transaction", () => {
  it("isolates tenants, refuses approval races, preserves the original and replays a save once", async () => {
    const db = new PGlite();
    try {
      const core = readFileSync(join(__dirname, "../../../../../supabase/migrations/20260919035832_channel_actions.sql"), "utf8");
      const actions = core.match(/create table channel_actions \([\s\S]*?\n\);/)?.[0];
      const events = core.match(/create table channel_action_events \([\s\S]*?\n\);/)?.[0];
      if (!actions || !events) throw new Error("Missing action store schema");
      await db.exec(`create role anon; create role authenticated; create role service_role;
        create table tenants(id uuid primary key);
        create table tenant_users(tenant_id uuid, user_id uuid, role text);
        create table agent_runs(id uuid primary key);
        ${actions} ${events}
        alter table channel_actions add column card_kind text, add column primary_label text,
          add column done_label text, add column how_to jsonb default '[]', add column target_key text,
          add column steps_done jsonb default '[]';`);
      await db.exec(readFileSync(join(__dirname, "../../../../../supabase/migrations/20261106160001_revise_pending_ad_action.sql"), "utf8"));
      await db.exec(readFileSync(join(__dirname, "../../../../../supabase/migrations/20261107115100_preserve_revised_ad_edits.sql"), "utf8"));
      const tenant = randomUUID(), other = randomUUID(), actor = randomUUID(), run = randomUUID(), action = randomUUID(), request = randomUUID();
      await db.query("insert into tenants values ($1),($2)", [tenant, other]);
      await db.query("insert into tenant_users values ($1,$2,'owner')", [tenant, actor]);
      await db.query("insert into agent_runs values ($1)", [run]);
      await db.query(`insert into channel_actions(id,tenant_id,channel_slug,run_id,position,run_of,action_type,title,title_key,body,exec_class,exec_payload)
        values ($1,$2,'meta_ads',$3,1,1,'create_ad','Ad','ad','{}','meta_ads.create_ad','{"headline":"Before"}')`, [action, tenant, run]);
      const revise = (tid: string, payload = { headline: "After" }) => db.query<{ value: { ok: boolean; code?: string; action_id?: string; replayed?: boolean } }>(
        "select revise_pending_ad_action($1,$2,$3,$4,$5,$6,$7,$8) as value",
        [tid, action, actor, { headline: "Before" }, {}, payload, {}, request]);
      expect((await revise(other)).rows[0].value).toEqual({ ok: false, code: "not_found" });
      await db.query("update channel_actions set exec_status='queued' where id=$1", [action]);
      expect((await revise(tenant)).rows[0].value).toEqual({ ok: false, code: "action_changed" });
      await db.query("update channel_actions set exec_status=null where id=$1", [action]);
      const saved = (await revise(tenant)).rows[0].value;
      expect(saved.ok).toBe(true);
      expect(saved.action_id).not.toBe(action);
      expect((await revise(tenant)).rows[0].value).toMatchObject({ ok: true, action_id: saved.action_id, replayed: true });
      expect((await revise(tenant, { headline: "Different" })).rows[0].value).toEqual({ ok: false, code: "action_changed" });
      const rows = (await db.query<{ id: string; status: string; exec_payload: unknown; edited_body: unknown; exec_status: string | null; approved_by: string | null }>("select id,status,exec_payload,edited_body,exec_status,approved_by from channel_actions order by position")).rows;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: action, status: "redone", exec_payload: { headline: "Before" } });
      expect(rows[1]).toMatchObject({ id: saved.action_id, status: "pending", exec_payload: { headline: "After" }, exec_status: null, approved_by: null });
      expect(rows[1].edited_body).toEqual({ ad_review_edited: true });
      expect(isUntouchedPending({ ...rows[1], run_id: run, steps_done: [], exec_class: "meta_ads.create_ad", customer: true })).toBe(false);
      const retirement = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261020160000_uncertain_failed_twin_stays_open.sql"), "utf8");
      const start = retirement.indexOf("create or replace function chain_channel_action_repeat(");
      await db.exec(retirement.slice(start, retirement.indexOf("end $$;", start) + 7));
      const newer = randomUUID();
      await db.query(`insert into channel_actions(id,tenant_id,channel_slug,run_id,position,run_of,action_type,title,title_key,body,proposed_at)
        values ($1,$2,'meta_ads',$3,3,3,'create_ad','New suggestion','new','{}',now()+interval '1 minute')`, [newer, tenant, run]);
      expect((await db.query<{ result: unknown }>("select chain_channel_action_repeat($1,$2,$3) as result", [tenant, saved.action_id, newer])).rows[0].result).toEqual({ ok: false, code: "touched" });
      expect((await db.query<{ status: string }>("select status from channel_actions where id=$1", [saved.action_id])).rows[0].status).toBe("pending");
      await db.query("update channel_actions set edited_body=null,body='{\"ad_review_edited\":true}' where id=$1", [saved.action_id]);
      await db.exec(readFileSync(join(__dirname, "../../../../../supabase/migrations/20261107115100_preserve_revised_ad_edits.sql"), "utf8"));
      expect((await db.query<{ edited_body: unknown }>("select edited_body from channel_actions where id=$1", [saved.action_id])).rows[0].edited_body).toEqual({ ad_review_edited: true });
      expect((await db.query<{ note: string }>("select note from channel_action_events where action_id=$1", [action])).rows[0].note).toBe("Revised by you.");
    } finally { await db.close(); }
  }, 20000);
});

describe("20260919060402_channel_action_exec.sql", () => {
  it("every RPC is security definer with search_path public, pg_temp", () => {
    const defs = code.match(/language plpgsql security definer set search_path = public, pg_temp/gi) ?? [];
    expect(defs).toHaveLength(RPCS.length);
  });

  it.each(RPCS)("%s is revoked from public/anon/authenticated, service_role only", (sig) => {
    expect(code).toMatch(new RegExp(`revoke all on function ${esc(sig)}\\s+from public, anon, authenticated`, "i"));
    expect(code).toMatch(new RegExp(`grant execute on function ${esc(sig)}\\s+to service_role`, "i"));
    expect(code).not.toMatch(new RegExp(`grant execute on function ${esc(sig)}[^;]*authenticated`, "i"));
  });

  it("the propose writer re-derives tenant AND channel from agent_runs, and raises on a mismatch", () => {
    expect(code).toMatch(
      /select tenant_id, channel_slug into v_tenant, v_channel\s+from agent_runs where id = p_run_id/i,
    );
    expect(code).toMatch(/p_tenant_id is distinct from v_tenant then\s+raise exception/i);
    expect(code).toMatch(/'code', 'unstamped_run'/);
  });

  it("the propose writer NEVER queues: exec_status is left null at insert", () => {
    const fn = code.slice(
      code.indexOf("create or replace function record_channel_exec_action"),
      code.indexOf("create or replace function approve_channel_action"),
    );
    expect(fn).not.toMatch(/exec_status/);
    expect(fn).toMatch(/v_payload := p_action->'exec_payload'/);
  });

  it("approve is the ONLY writer of exec_status = 'queued'", () => {
    const queued = code.match(/exec_status\s*=\s*'queued'/g) ?? [];
    expect(code).toMatch(/set exec_status\s+= 'queued'/i);
    expect(queued.length).toBeGreaterThan(0);
    const approveFn = code.slice(
      code.indexOf("create or replace function approve_channel_action"),
      code.indexOf("create or replace function claim_channel_action_exec"),
    );
    expect(approveFn).toMatch(/set exec_status\s+= 'queued'/i);
    const otherFns = code.replace(approveFn, "");
    expect(otherFns).not.toMatch(/set exec_status\s*=\s*'queued'/i);
  });

  it("approve refuses a non-executable action and is a no-op while in flight", () => {
    expect(code).toMatch(/if v_row\.exec_class is null then\s+return jsonb_build_object\('ok', false, 'code', 'not_executable'\)/i);
    expect(code).toMatch(/if v_row\.exec_status in \('queued', 'dispatching'\) then[\s\S]{0,200}'queued', true/i);
    expect(code).toMatch(/'code', 'already_executed'/);
  });

  it("approve requires a real tenant member as the approver (capGovernsDispatch reads it)", () => {
    expect(code).toMatch(/'code', 'approver_required'/);
    expect(code).toMatch(
      /from tenant_users tu\s+where tu\.tenant_id = p_tenant_id and tu\.user_id = p_actor_user_id/i,
    );
    expect(code).toMatch(/p_source is not null and p_source <> 'staff'[\s\S]{0,120}'invalid_source'/i);
  });

  it("the claim is a CAS on 'queued' and takes NO tenant: it RETURNS one", () => {
    expect(code).toMatch(
      /update channel_actions\s+set exec_status\s+= 'dispatching',[\s\S]{0,200}where id = p_action_id\s+and exec_status = 'queued'/i,
    );
    expect(code).toMatch(/create or replace function claim_channel_action_exec\(\s*p_action_id uuid\s*\)/i);
    expect(code).toMatch(/'tenant_id', v_row\.tenant_id/);
  });

  it("the claim stamps an owner and a time, and hands the owner back", () => {
    expect(code).toMatch(/add column if not exists exec_claim_id\s+uuid/i);
    expect(code).toMatch(/add column if not exists exec_claimed_at\s+timestamptz/i);
    const claim = code.slice(
      code.indexOf("create or replace function claim_channel_action_exec"),
      code.indexOf("create or replace function settle_channel_action_exec"),
    );
    expect(claim).toMatch(/v_claim uuid := gen_random_uuid\(\)/i);
    expect(claim).toMatch(/exec_claim_id\s+= v_claim/i);
    expect(claim).toMatch(/exec_claimed_at = now\(\)/i);
    expect(claim).toMatch(/'claim_id', v_claim/);
  });

  it("a 'dispatching' row is abandoned ONLY once its lease has run out", () => {
    const claim = code.slice(
      code.indexOf("create or replace function claim_channel_action_exec"),
      code.indexOf("create or replace function settle_channel_action_exec"),
    );
    expect(claim).toMatch(
      /'lease_expired',\s+v_row\.exec_status = 'dispatching'\s+and \(v_row\.exec_claimed_at is null\s+or v_row\.exec_claimed_at < now\(\) - interval '10 minutes'\)/i,
    );
  });

  it("a non-owner may never report success, and may only fail an EXPIRED claim", () => {
    const settle = code.slice(
      code.indexOf("create or replace function settle_channel_action_exec"),
      code.indexOf("revoke all on function record_channel_exec_action"),
    );
    expect(settle).toMatch(/p_claim_id\s+uuid default null/i);
    expect(settle).toMatch(/v_owner := p_claim_id is not null/i);
    expect(settle).toMatch(/if not v_owner then\s+if p_ok then[\s\S]{0,200}'not_owner'/i);
    expect(settle).toMatch(
      /exec_claimed_at >= now\(\) - interval '10 minutes'[\s\S]{0,200}'lease_held'/i,
    );
    expect(settle).toMatch(/'replayed', true/);
  });

  it("the two lease timeouts are the SAME number, stated once per function", () => {
    expect(code.match(/interval '10 minutes'/g) ?? []).toHaveLength(2);
  });

  it("a fresh approve clears the previous attempt's owner", () => {
    const approveFn = code.slice(
      code.indexOf("create or replace function approve_channel_action"),
      code.indexOf("create or replace function claim_channel_action_exec"),
    );
    expect(approveFn).toMatch(/exec_claim_id\s+= null/i);
    expect(approveFn).toMatch(/exec_claimed_at\s+= null/i);
  });

  it("the old 5-argument settle is dropped, so no stale overload can be called", () => {
    expect(code).toMatch(
      /drop function if exists settle_channel_action_exec\(uuid, uuid, boolean, jsonb, text\);/i,
    );
  });

  it("settle is the only exit from 'dispatching', and a failure leaves the action OPEN", () => {
    expect(code).toMatch(/if v_row\.exec_status is distinct from 'dispatching' then[\s\S]{0,160}'not_dispatching'/i);
    const settle = code.slice(
      code.indexOf("create or replace function settle_channel_action_exec"),
      code.indexOf("revoke all on function record_channel_exec_action"),
    );
    expect(settle).toMatch(/set status\s+= 'acted',[\s\S]{0,200}exec_status = 'executed'/i);
    expect(settle).toMatch(/set exec_status = 'failed'/i);
    expect(settle.match(/set\s+status\s*=/gi) ?? []).toHaveLength(1);
  });

  it("the one-time archive never stamps dispatched_at and never says 'acted'", () => {
    const archive = code.slice(code.indexOf("update decisions"));
    expect(archive).toMatch(/set status = 'archived', archived_at = now\(\)/);
    expect(archive).not.toMatch(/dispatched_at/);
    expect(archive).not.toMatch(/status = 'acted'/);
  });

  it("the archive is scoped by the RUN's channel stamp, so youtube_ads and chat are untouched", () => {
    const archive = code.slice(code.indexOf("update decisions"));
    expect(archive).toMatch(
      /decision_class = 'channel\.recipe_step'[\s\S]{0,200}r\.channel_slug in \('google_ads', 'x_organic'\)/,
    );
    expect(archive).toMatch(
      /decision_class like 'google\\_ads\.%'[\s\S]{0,200}r\.channel_slug = 'google_ads'/,
    );
    expect(archive).not.toMatch(/channel_slug is null/);
  });

  it("no age-based expiry on the ACTION crept in: pending is never left by age", () => {
    expect(code).not.toMatch(/interval\s+'\d+ (days?|hours?)'/i);
    const ages = code.match(/interval '[^']+'/g) ?? [];
    expect(new Set(ages)).toEqual(new Set(["interval '10 minutes'"]));
    expect(code).not.toMatch(/set status\s*=[^;]*interval/i);
  });
});
