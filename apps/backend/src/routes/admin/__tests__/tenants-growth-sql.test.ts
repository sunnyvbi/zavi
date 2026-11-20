import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
let db: PGlite;
const U = "10000000-0000-4000-8000-000000000001",
  T = "20000000-0000-4000-8000-000000000001",
  S = "10000000-0000-4000-8000-000000000002";
const migration = (n: string) =>
  readFileSync(
    resolve(__dirname, "../../../../../../supabase/migrations", n),
    "utf8",
  );
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',created_at timestamptz default now(),last_sign_in_at timestamptz,is_anonymous boolean default false,deleted_at timestamptz,invited_at timestamptz,email_confirmed_at timestamptz);
 create table tenants(id uuid primary key,slug text,display_name text,kind text default 'real',created_at timestamptz default now(),product_url jsonb);
 create table tenant_users(tenant_id uuid,user_id uuid,role text default 'owner',created_at timestamptz default now());
 create table staff_users(user_id uuid,revoked_at timestamptz);create table staff_audit_log(actor_user_id uuid,actor_email text,action text,target_table text,target_id text,meta jsonb);
 create table agent_runs(tenant_id uuid,status text,parse_ok boolean,cost_usd numeric,enqueued_at timestamptz);create table agent_threads(id uuid primary key,tenant_id uuid,user_id uuid);create table agent_thread_messages(thread_id uuid,tenant_id uuid,sender_role text,created_at timestamptz default now());
 create table tenant_subscriptions(tenant_id uuid primary key,tier text,status text,comp_expires_at timestamptz,current_period_end timestamptz,cancel_at_period_end boolean default false);
 create table system_config(id integer,blob jsonb);insert into system_config values(1,'{}');
 create table tenant_fact(tenant_id uuid,key text,source text,value_text text);create table sites(tenant_id uuid,status text,live_url text,created_at timestamptz);create table connector_metadata(tenant_id uuid,slug text,connected_at timestamptz);
 create table social_connected_accounts(tenant_id uuid,platform text,status text);create table tenant_mcp_servers(tenant_id uuid,server_id text,enabled boolean);`);
  const s = migration("20260923190000_tenant_plan_comp_expiry.sql");
  await db.exec(
    s.slice(
      s.indexOf("create or replace function _tenant_tier"),
      s.indexOf("create or replace function _credit_allowance"),
    ),
  );
  await db.exec(
    "insert into agent_threads values('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',null); insert into agent_thread_messages values('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','user',now())",
  );
  await db.exec(migration("20261014040223_admin_tenants_growth_view.sql"));
  await db.exec(
    migration("20261111170000_admin_growth_test_workspaces_only.sql"),
  );
  expect((await db.query("select * from admin_growth_activity")).rows).toEqual(
    [],
  );
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(
    "truncate auth.users,tenants,tenant_users,staff_users,staff_audit_log,agent_runs,agent_threads,agent_thread_messages,tenant_subscriptions,admin_growth_classifications,tenant_fact,sites,connector_metadata,social_connected_accounts,tenant_mcp_servers cascade",
  );
  await db.query(
    "insert into auth.users(id,email,created_at) values($1,'founder@business.com',now()-interval '1 year'),($2,'staff@upcar.ai',now()-interval '1 year')",
    [U, S],
  );
  await db.query("insert into staff_users values($1,null)", [S]);
  await db.query(
    "insert into tenants(id,slug,display_name,created_at) values($1,'business','Business',now()-interval '1 year')",
    [T],
  );
  await db.query("insert into tenant_users(tenant_id,user_id) values($1,$2)", [
    T,
    U,
  ]);
});
async function snapshot() {
  return (
    await db.query<{ data: any }>(
      "select admin_tenants_growth((now() at time zone 'Asia/Kolkata')::date-89,(now() at time zone 'Asia/Kolkata')::date) data",
    )
  ).rows[0].data;
}
it("records signup location once and rejects historical relocation", async () => {
  await expect(
    db.query(
      "select record_admin_growth_signup_location($1,'IN','Pune',now())",
      [U],
    ),
  ).rejects.toThrow("signup window expired");
  await db.query("update auth.users set created_at=now() where id=$1", [U]);
  await db.query(
    "select record_admin_growth_signup_location($1,'IN','Pune',now())",
    [U],
  );
  await db.query(
    "select record_admin_growth_signup_location($1,'US','Boston',now())",
    [U],
  );
  expect(
    (await db.query("select country,city from admin_growth_signup_location"))
      .rows,
  ).toEqual([{ country: "IN", city: "Pune" }]);
});
it("leaves ownerless launch-video shells out of workspaces", async () => {
  await db.query(
    "insert into tenants(id,slug,display_name,kind) values(gen_random_uuid(),'shell','Shell','launch_video_shell')",
  );
  expect((await snapshot()).tenants.map((t: any) => t.id)).toEqual([T]);
});
it("does not count an unaccepted invitation as a signup", async () => {
  await db.query("update auth.users set invited_at=created_at where id=$1", [
    U,
  ]);
  expect((await snapshot()).users.find((u: any) => u.id === U)).toBeUndefined();
  await db.query(
    "update auth.users set last_sign_in_at=now(),email_confirmed_at=now() where id=$1",
    [U],
  );
  const user = (await snapshot()).users.find((u: any) => u.id === U);
  expect(new Date(user.signup_at).getTime()).toBeGreaterThan(
    Date.now() - 10000,
  );
});
it("keeps usage aligned with the selected IST dates and out of human activity", async () => {
  await db.query(
    "insert into agent_runs values($1,'success',true,2,'2026-10-12T18:30:00Z'),($1,'success',true,8,'2026-10-13T18:30:00Z')",
    [T],
  );
  const data = (
    await db.query<{ data: any }>(
      "select admin_tenants_growth('2026-10-13','2026-10-13',true) data",
    )
  ).rows[0].data;
  expect(data.usage.find((r: any) => r.tenant_id === T)).toMatchObject({
    runs: 1,
    cost_usd: 2,
    ok_rate: 1,
  });
  expect(data.activity).toHaveLength(0);
});
describe("staff growth SQL", () => {
  it("includes pre-workspace signups", async () => {
    const d = await snapshot();
    expect(d.users).toHaveLength(2);
    expect(d.tenants).toHaveLength(1);
    expect(d.tenants[0].owner_id).toBe(U);
    expect(d.users.find((u: any) => u.id === S).tenant_ids).toEqual([]);
  });
  it("requires confirmation of historical suggestions without changing deletion protection", async () => {
    await db.query("update tenants set display_name='Test shop' where id=$1", [
      T,
    ]);
    expect((await snapshot()).tenants[0]).toMatchObject({
      is_test: false,
      test_reasons: ["workspace name starts with test"],
    });
    await db.query(
      "select admin_growth_classify('tenant',array[$1::uuid],true,'Ravi approved list',$2)",
      [T, S],
    );
    expect((await snapshot()).tenants[0].is_test).toBe(true);
    expect((await db.query("select kind from tenants")).rows).toEqual([
      { kind: "real" },
    ]);
    await db.query(
      "select admin_growth_classify('tenant',array[$1::uuid],false,'Reviewed real customer',$2)",
      [T, S],
    );
    expect((await snapshot()).tenants[0].is_test).toBe(false);
  });
  it("auto-classifies new test aliases but not lookalike domains", async () => {
    await db.query(
      "update auth.users set email='alice+qa@gmail.com',created_at=now()+interval '1 second' where id=$1",
      [U],
    );
    expect((await snapshot()).users.find((u: any) => u.id === U).is_test).toBe(
      true,
    );
    await db.query(
      "update auth.users set email='person@notupcar.ai' where id=$1",
      [U],
    );
    expect((await snapshot()).users.find((u: any) => u.id === U).is_test).toBe(
      false,
    );
  });
  it("does not mark a workspace test because of its owner's email", async () => {
    await db.query(
      "update auth.users set email='ravi+test@upcar.ai',created_at=now()+interval '1 second' where id=$1",
      [U],
    );
    await db.query(
      "update tenants set created_at=now()+interval '1 second' where id=$1",
      [T],
    );
    const d = await snapshot();
    expect(d.users.find((u: any) => u.id === U).is_test).toBe(true);
    expect(d.tenants[0]).toMatchObject({ is_test: false, test_reasons: [] });
  });
  it("deduplicates messages/signins using IST midnight and excludes assistant replies", async () => {
    await db.query("insert into agent_threads values($1,$2,$3)", [T, T, U]);
    await db.query(
      "update auth.users set last_sign_in_at='2026-10-13T18:29:59Z' where id=$1",
      [U],
    );
    await db.query(
      "insert into agent_thread_messages values($1,$1,'user','2026-10-13T18:30:00Z'),($1,$1,'user','2026-10-13T18:31:00Z'),($1,$1,'assistant','2026-10-14T18:31:00Z')",
      [T],
    );
    expect(
      (
        await db.query(
          "select day::text from admin_growth_activity order by day",
        )
      ).rows,
    ).toEqual([{ day: "2026-10-13" }, { day: "2026-10-14" }]);
  });
  it("rolls back invalid bulk operations and rejects nonstaff", async () => {
    await expect(
      db.query(
        "select admin_growth_classify('tenant',array[$1::uuid,$2::uuid],true,'approved',$3)",
        [T, U, S],
      ),
    ).rejects.toThrow("unknown subject");
    expect(
      (await db.query("select count(*)::int n from staff_audit_log")).rows[0],
    ).toEqual({ n: 0 });
    await expect(
      db.query(
        "select admin_growth_classify('tenant',array[$1::uuid],true,'approved',$2)",
        [T, U],
      ),
    ).rejects.toThrow("active staff");
  });
  it("denies authenticated direct reads and RPC access", async () => {
    await db.exec("set role authenticated");
    try {
      await expect(snapshot()).rejects.toThrow("permission denied");
      await expect(
        db.query("select * from admin_growth_signup_location"),
      ).rejects.toThrow("permission denied");
    } finally {
      await db.exec("reset role");
    }
  });
  it("uses effective comp entitlement and does not reset start on renewal", async () => {
    await db.query(
      "insert into tenant_subscriptions(tenant_id,tier,status,comp_expires_at) values($1,'pro','canceled',now()+interval '1 month')",
      [T],
    );
    const row = (await snapshot()).tenants[0];
    expect(row).toMatchObject({ tier: "pro", is_comp: true });
    expect(row.plan_start).toBeTruthy();
    await db.query(
      "update tenant_subscriptions set current_period_end=now()+interval '2 months' where tenant_id=$1",
      [T],
    );
    expect((await snapshot()).tenants[0].plan_start).toBe(row.plan_start);
    await db.query(
      "update tenant_subscriptions set comp_expires_at=now()-interval '1 second' where tenant_id=$1",
      [T],
    );
    expect((await snapshot()).tenants[0].tier).toBe("free");
  });
  it("rejects reversed/future ranges", async () => {
    await expect(
      db.query("select admin_tenants_growth('2026-10-14','2026-10-01')"),
    ).rejects.toThrow("invalid date");
    await expect(
      db.query("select admin_tenants_growth(current_date,current_date+3)"),
    ).rejects.toThrow("invalid date");
  });
  it("aggregates 1000 workspaces and 90000 daily activity records in under two seconds", async () => {
    await db.exec(`insert into auth.users(id,email) select md5('user'||n)::uuid,'user'||n||'@business.com' from generate_series(1,1000)n;
 insert into tenants(id,slug,display_name) select md5('tenant'||n)::uuid,'company'||n,'Company'||n from generate_series(1,1000)n;
 insert into tenant_users(tenant_id,user_id) select md5('tenant'||n)::uuid,md5('user'||n)::uuid from generate_series(1,1000)n;
 insert into admin_growth_activity select md5('user'||n)::uuid,((now() at time zone 'Asia/Kolkata')::date-d),now()-make_interval(days=>d) from generate_series(1,1000)n,generate_series(0,89)d;`);
    const start = performance.now(),
      d = await snapshot();
    expect(d.tenants).toHaveLength(1001);
    expect(d.activity).toHaveLength(90000);
    expect(performance.now() - start).toBeLessThan(2000);
  }, 15000);
});

it("keeps auth and chat writes successful when activity storage fails", async () => {
  await db.exec(
    "alter table admin_growth_activity add constraint injected_activity_failure check (false) not valid",
  );
  try {
    await db.query("update auth.users set last_sign_in_at=now() where id=$1", [
      U,
    ]);
    await db.query("insert into agent_threads values($1,$2,$3)", [T, T, U]);
    await db.query(
      "insert into agent_thread_messages values($1,$1,'user',now())",
      [T],
    );
    expect(
      (
        await db.query(
          "select last_sign_in_at is not null ok from auth.users where id=$1",
          [U],
        )
      ).rows[0],
    ).toEqual({ ok: true });
    expect(
      (await db.query("select count(*)::int n from agent_thread_messages"))
        .rows[0],
    ).toEqual({ n: 1 });
    expect(
      (await db.query("select * from admin_growth_activity")).rows,
    ).toEqual([]);
  } finally {
    await db.exec(
      "alter table admin_growth_activity drop constraint injected_activity_failure",
    );
  }
  await db.query("update auth.users set last_sign_in_at=now() where id=$1", [
    U,
  ]);
  expect(
    (await db.query("select count(*)::int n from admin_growth_activity"))
      .rows[0],
  ).toEqual({ n: 1 });
});
it("shows the onboarding marketing URL without a separately confirmed fact", async () => {
  await db.query("update tenants set product_url=$2::jsonb where id=$1", [
    T,
    JSON.stringify({ marketing: "https://founder.example" }),
  ]);
  expect((await snapshot()).tenants[0].added_url).toBe(
    "https://founder.example",
  );
  await db.query(
    "insert into tenant_fact values($1,'domain','human_confirmed','https://confirmed.example')",
    [T],
  );
  expect((await snapshot()).tenants[0].added_url).toBe(
    "https://confirmed.example",
  );
});
it("does not label a generated site or malformed marketing value as founder-added", async () => {
  await db.query("update tenants set product_url=$2::jsonb where id=$1", [
    T,
    JSON.stringify({ marketing: "https://built.example/" }),
  ]);
  await db.query(
    "insert into sites values($1,'live','https://built.example',now())",
    [T],
  );
  const row = (await snapshot()).tenants[0];
  expect(row.added_url).toBeNull();
  expect(row.built_urls).toEqual(["https://built.example"]);
  await db.exec("truncate sites");
  await db.query(
    "insert into tenant_fact values($1,'domain','provisioned','https://built.example')",
    [T],
  );
  expect((await snapshot()).tenants[0].added_url).toBeNull();
  await db.exec("truncate tenant_fact");
  for (const marketing of [null, 123, { url: "https://wrong.example" }, "  "]) {
    await db.query("update tenants set product_url=$2::jsonb where id=$1", [
      T,
      JSON.stringify({ marketing }),
    ]);
    expect((await snapshot()).tenants[0].added_url).toBeNull();
  }
});
it("keeps expired comps free and starts a converted paid plan only once", async () => {
  await db.query(
    "insert into tenant_subscriptions(tenant_id,tier,status,comp_expires_at) values($1,'pro','active',now()-interval '1 day')",
    [T],
  );
  expect(
    (await db.query<{ growth_plan_started_at: string | null }>("select growth_plan_started_at from tenant_subscriptions"))
      .rows[0].growth_plan_started_at,
  ).toBeNull();
  await db.query(
    "update tenant_subscriptions set current_period_end=now()+interval '1 month' where tenant_id=$1",
    [T],
  );
  expect((await snapshot()).tenants[0]).toMatchObject({
    tier: "free",
    plan_start: null,
  });
  await db.query(
    "update tenant_subscriptions set comp_expires_at=null where tenant_id=$1",
    [T],
  );
  const paid = (await snapshot()).tenants[0];
  expect(paid.tier).toBe("pro");
  expect(paid.plan_start).toBeTruthy();
  await db.query(
    "update tenant_subscriptions set current_period_end=now()+interval '2 months' where tenant_id=$1",
    [T],
  );
  expect((await snapshot()).tenants[0].plan_start).toBe(paid.plan_start);
});
