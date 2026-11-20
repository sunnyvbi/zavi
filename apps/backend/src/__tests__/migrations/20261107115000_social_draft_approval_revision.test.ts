import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

const read = (name: string) => readFileSync(join(__dirname, "../../../../../supabase/migrations", name), "utf8");

it("compares the body and approves in one transaction with tenant and membership checks", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table decisions(id uuid primary key, tenant_id uuid, decision_class text, status text, body jsonb, approved_by uuid, approved_at timestamptz, rejected_by uuid, rejected_at timestamptz);
      create table tenant_users(tenant_id uuid, user_id uuid, role text);`);
    const actorSql = read("20260704224841_gap5_s5_split_rejected_by_and_resolver.sql");
    const start = actorSql.indexOf("create or replace function decide_decision_as_actor(");
    await db.exec(actorSql.slice(start, actorSql.indexOf("end $$;", start) + 7));
    await db.exec(read("20261107115000_social_draft_approval_revision.sql"));
    const permission = (role: string) => db.query<{ allowed: boolean }>("select has_function_privilege($1,'approve_social_draft_as_actor(uuid,uuid,uuid,jsonb,jsonb,text)','execute') as allowed", [role]);
    expect((await permission("authenticated")).rows[0].allowed).toBe(false);
    expect((await permission("anon")).rows[0].allowed).toBe(false);
    expect((await permission("service_role")).rows[0].allowed).toBe(true);
    const tenant = randomUUID(), actor = randomUUID(), id = randomUUID();
    const original = { channel: "x", payload: { text: "Shown" } };
    const edited = { channel: "x", payload: { text: "Saved elsewhere" } };
    await db.query("insert into tenant_users values ($1,$2,'owner')", [tenant, actor]);
    await db.query("insert into decisions values ($1,$2,'social.publish.v2','proposed',$3,null,null,null,null)", [id, tenant, original]);
    const approve = (expected: unknown, body: unknown, tid = tenant, uid = actor) => db.query<{ result: { changed: boolean; status: string } }>("select approve_social_draft_as_actor($1,$2,$3,$4,$5) as result", [id, tid, uid, expected, body]);
    await expect(approve(original, original, randomUUID())).rejects.toThrow("cross_tenant");
    await expect(approve(original, original, tenant, randomUUID())).rejects.toThrow("not_member");
    await db.query("update decisions set body=$1 where id=$2", [edited, id]);
    await expect(approve(original, original)).rejects.toThrow("stale_card");
    expect((await db.query("select status,body from decisions")).rows[0]).toEqual({ status: "proposed", body: edited });
    const scheduled = { ...edited, scheduled_at: "2099-01-01T00:00:00Z" };
    expect((await approve(edited, scheduled)).rows[0].result).toEqual({ changed: true, status: "approved" });
    expect((await db.query("select status,body,approved_by from decisions")).rows[0]).toEqual({ status: "approved", body: scheduled, approved_by: actor });
    expect((await approve(edited, original)).rows[0].result).toEqual({ changed: false, status: "approved" });
    expect((await db.query<{ body: unknown }>("select body from decisions")).rows[0].body).toEqual(scheduled);
  } finally { await db.close(); }
}, 20000);
