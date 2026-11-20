import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const migration = (name: string) => readFileSync(join(__dirname, "../../../../../supabase/migrations", name), "utf8");

describe("revising a failed advertising action", () => {
  it("revises only a failure proven to have written nothing, and carries the hold note", async () => {
    const db = new PGlite();
    try {
      const core = migration("20260919035832_channel_actions.sql");
      const actions = core.match(/create table channel_actions \([\s\S]*?\n\);/)?.[0];
      const events = core.match(/create table channel_action_events \([\s\S]*?\n\);/)?.[0];
      if (!actions || !events) throw new Error("Missing action store schema");
      await db.exec(`create role anon; create role authenticated; create role service_role;
        create table tenants(id uuid primary key);
        create table tenant_users(tenant_id uuid, user_id uuid, role text);
        create table agent_runs(id uuid primary key);
        create table ad_object_changes(tenant_id uuid, action_table text, action_id uuid);
        create function classify_exec_failure(p jsonb) returns jsonb language sql immutable as
          $f$ select jsonb_build_object('bucket', case when p->>'code' = 'google_ads_mutate_partial_failure' then 'partial_risk' else 'temporary' end) $f$;
        ${actions} ${events}
        alter table channel_actions add column card_kind text, add column primary_label text,
          add column done_label text, add column how_to jsonb default '[]', add column target_key text,
          add column steps_done jsonb default '[]', add column cgo_hold jsonb;`);
      await db.exec(migration("20261106160001_revise_pending_ad_action.sql"));
      await db.exec(migration("20261107115100_preserve_revised_ad_edits.sql"));
      await db.exec(migration("20261111180000_revise_failed_ad_action.sql"));
      const tenant = randomUUID(), actor = randomUUID(), run = randomUUID();
      await db.query("insert into tenants values ($1)", [tenant]);
      await db.query("insert into tenant_users values ($1,$2,'owner')", [tenant, actor]);
      await db.query("insert into agent_runs values ($1)", [run]);
      let position = 0;
      const card = async (state: string, approvals = 1) => {
        const id = randomUUID();
        position += 10;
        await db.query(`insert into channel_actions(id,tenant_id,channel_slug,run_id,position,run_of,action_type,title,title_key,body,exec_class,exec_payload,cgo_hold)
          values ($1,$2,'meta_ads',$3,$4,$4,'create_ad','Ad',$5,'{}','meta_ads.create_ad','{"headline":"Before"}','{"reasons":["wallet_short"]}')`, [id, tenant, run, position, `ad-${position}`]);
        if (state) await db.query(`update channel_actions set approved_by=$2, ${state} where id=$1`, [id, actor]);
        for (let i = 0; i < approvals; i++) {
          await db.query(`insert into channel_action_events(tenant_id,action_id,event,actor_kind,actor_user_id,event_key) values ($1,$2,'approved','founder',$3,$4)`, [tenant, id, actor, randomUUID()]);
        }
        return id;
      };
      const revise = async (id: string) => (await db.query<{ value: { ok: boolean; code?: string; action_id?: string } }>(
        "select revise_pending_ad_action($1,$2,$3,$4,$5,$6,$7,$8) as value",
        [tenant, id, actor, { headline: "Before" }, {}, { headline: "After" }, {}, randomUUID()])).rows[0].value;

      const proven = `exec_status='failed', exec_result='{"code":"meta_ads_token_expired","nothing_written":true}'`;
      const clean = await revise(await card(proven));
      expect(clean.ok).toBe(true);
      const next = (await db.query<{ status: string; exec_status: string | null; approved_by: string | null; cgo_hold: unknown }>("select status,exec_status,approved_by,cgo_hold from channel_actions where id=$1", [clean.action_id])).rows[0];
      expect(next).toEqual({ status: "pending", exec_status: null, approved_by: null, cgo_hold: { reasons: ["wallet_short"] } });

      const refused = { ok: false, code: "action_changed" };
      expect(await revise(await card(`exec_status='failed', exec_result='{"code":"insufficient_credits","bucket":"needs_founder"}'`))).toEqual(refused);
      expect(await revise(await card(`exec_status='failed', exec_result='{"code":"meta_ads_launch_not_live","bucket":"needs_founder"}'`))).toEqual(refused);
      expect(await revise(await card(proven, 2))).toEqual(refused);
      expect(await revise(await card(proven, 0))).toEqual(refused);
      expect(await revise(await card(`exec_status='failed', exec_result='{"code":"x","nothing_written":true,"created":[{"id":"1"}]}'`))).toEqual(refused);
      const recorded = await card(proven);
      await db.query("insert into ad_object_changes values ($1,'channel_actions',$2)", [tenant, recorded]);
      expect(await revise(recorded)).toEqual(refused);
      expect(await revise(await card(`exec_status='failed', exec_result='{"nothing_written":true,"interrupted":true}'`))).toEqual(refused);
      expect(await revise(await card(`exec_status='failed', exec_result='{"nothing_written":true,"lease_expired":true}'`))).toEqual(refused);
      expect(await revise(await card(`exec_status='failed', exec_result='{"nothing_written":true,"code":"exec_outcome_unknown"}'`))).toEqual(refused);
      expect(await revise(await card(`exec_status='failed', exec_result='{"nothing_written":true,"bucket":"partial_risk"}'`))).toEqual(refused);
      expect(await revise(await card(`exec_status='executed', exec_result='{"nothing_written":true}'`))).toEqual(refused);
      expect(await revise(await card(`exec_status=null`))).toEqual(refused);
    } finally { await db.close(); }
  }, 20000);
});
