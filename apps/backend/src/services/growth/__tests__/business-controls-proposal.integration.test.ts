import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, afterAll, it, expect, vi } from "vitest";
import { seedBudgetSchema } from "./budget-sql-fixture";
import { BUSINESS_CONTROL_DEFAULTS } from "../business-control-policy";

const tenant = "11111111-1111-1111-1111-111111111111",
  actor = "22222222-2222-2222-2222-222222222222";
const decision = "33333333-3333-4333-8333-333333333333",
  other = "44444444-4444-4444-4444-444444444444";
const policy = {
  ...BUSINESS_CONTROL_DEFAULTS,
  enabled: true,
  max_cpa_usd: 75,
  min_spend_usd: 150,
};
let db: any;
let server: import("node:http").Server | undefined;
let base = "";
let finishQa: (() => void) | undefined;
function query(table: string, tenantId?: string) {
  if (!["decisions", "growth_business_policies"].includes(table))
    throw new Error("Unexpected fixture table");
  let fields = "*";
  const values: unknown[] = [],
    clauses: string[] = [];
  const q: any = {
    select: (v: string) => {
      if (!/^[a-z_, ]+$/.test(v)) throw new Error("Invalid fields");
      fields = v;
      return q;
    },
    eq: (k: string, v: unknown) => {
      if (!/^[a-z_]+$/.test(k)) throw new Error("Invalid key");
      values.push(v);
      clauses.push(`${k}=$${values.length}`);
      return q;
    },
    maybeSingle: async () => ({
      data:
        (
          await db.query(
            `select ${fields} from ${table}${clauses.length ? " where " + clauses.join(" and ") : ""}`,
            values,
          )
        ).rows[0] ?? null,
      error: null,
    }),
  };
  if (tenantId) q.eq("tenant_id", tenantId);
  return q;
}
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (table: string) => query(table) }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: (t: string) => ({ from: (table: string) => query(table, t) }),
  tenantRpc: async (t: string, fn: string, args: any) => {
    if (fn !== "approve_growth_business_controls")
      throw new Error("Unexpected RPC");
    try {
      return {
        data: (
          await db.query(
            "select approve_growth_business_controls($1,$2,$3,$4,$5,$6) r",
            [
              t,
              args.p_actor,
              args.p_decision_id,
              args.p_policy,
              args.p_expected_policy,
              args.p_revision,
            ],
          )
        ).rows[0].r,
        error: null,
      };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  },
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (req: any, res: any) => {
    if (req.headers["x-local-session"] !== "fixture") {
      res.status(401).json({ error: { message: "Fixture session required" } });
      return null;
    }
    return {
      tenant_id: tenant,
      user_id: actor,
      tenant_overridden: req.headers["x-local-override"] === "true",
    };
  },
}));
vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRole: async () =>
    (
      await db.query(
        "select role from tenant_users where tenant_id=$1 and user_id=$2",
        [tenant, actor],
      )
    ).rows[0]?.role,
  loadTenantRoleFor: async (a: string, t: string) =>
    (
      await db.query(
        "select role from tenant_users where tenant_id=$1 and user_id=$2",
        [t, a],
      )
    ).rows[0]?.role,
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({
  logDecisionNotTaken: vi.fn(),
}));
vi.mock("@/services/memory/stamp-outcome", () => ({
  stampOutcomeForDecision: vi.fn(),
}));
vi.mock("@/services/growth/bind-action-outcome", () => ({
  bindActionOutcome: vi.fn(),
}));

beforeAll(async () => {
  const { PGlite } = createRequire(
    process.env.ADS_SQL_TEST_MODULES
      ? resolve(process.env.ADS_SQL_TEST_MODULES, "../package.json")
      : __filename,
  )("@electric-sql/pglite");
  db = new PGlite();
  await seedBudgetSchema(db);
  await db.exec(`create table agent_threads(id uuid primary key,tenant_id uuid references tenants on delete cascade,last_message_at timestamptz not null default '2026-01-01');
    create table agent_thread_messages(id uuid primary key default gen_random_uuid(), thread_id uuid references agent_threads on delete cascade,
      tenant_id uuid references tenants on delete cascade,sender_role text,body text,meta jsonb);`);
  await db.exec(`alter table decision_classes add column click_allowlistable boolean, add column severity text;
    alter table decisions add column status text default 'proposed', add column approved_by uuid,
    add column approved_by_source text, add column approved_at timestamptz, add column dispatched_at timestamptz, add column dispatch_error text;`);
  for (const file of [
    "20261009074317_growth_business_controls.sql",
    "20261101174300_business_controls_chat_approval.sql",
  ])
    await db.exec(
      readFileSync(resolve("../../supabase/migrations", file), "utf8"),
    );
  const { default: express } = await import("express");
  const { approvalsApprove } = await import("@/routes/approvals/decide");
  const { getBusinessControlsProposal } =
    await import("@/routes/workspace/growth-controls");
  const app = express();
  app.use(express.json());
  app.get(
    "/api/workspace/growth-controls/proposals/:decision_id",
    getBusinessControlsProposal,
  );
  app.post("/api/approvals/:decision_id/approve", approvalsApprove);
  if (process.env.BUSINESS_CONTROLS_QA_DIR) {
    app.use(express.static(process.env.BUSINESS_CONTROLS_QA_DIR));
    app.post("/__qa/finish", (_req, res) => {
      res.json({ ok: true });
      finishQa?.();
    });
  }
  server = app.listen(
    Number(process.env.BUSINESS_CONTROLS_QA_PORT ?? 0),
    "127.0.0.1",
  );
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}, 30000);
afterAll(async () => {
  if (process.env.BUSINESS_CONTROLS_QA_PORT) {
    console.log(`Local isolated browser QA: ${base}`);
    await new Promise<void>((resolve) => {
      finishQa = resolve;
    });
  }
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  await db?.close();
}, 3600000);
beforeEach(async () => {
  await db.exec("truncate tenants cascade");
  await db.query("insert into tenants values ($1),($2)", [tenant, other]);
  await db.query("insert into tenant_users values ($1,$2,'owner')", [
    tenant,
    actor,
  ]);
  await db.query(
    "insert into decisions(id,tenant_id,decision_class,body) values($1,$2,'growth.save_business_controls',$3)",
    [
      decision,
      tenant,
      {
        policy,
        revision: 0,
        rationale: "Illustrative proposed limits, not verified profit.",
      },
    ],
  );
});
const approve = async (
  edited: unknown = policy,
  expected: unknown = policy,
  revision = 0,
  t = tenant,
  a = actor,
) =>
  (
    await db.query(
      "select approve_growth_business_controls($1,$2,$3,$4,$5,$6) r",
      [t, a, decision, edited, expected, revision],
    )
  ).rows[0].r;
const read = async () =>
  (await db.query("select body,status,approved_at from decisions where id=$1", [decision]))
    .rows[0];

it("saves the edited values and durable receipt atomically, with stops off", async () => {
  expect(await approve({ ...policy, max_cpa_usd: 80 })).toEqual({
    status: "saved",
    changed: true,
  });
  const row = await read();
  expect(row.status).toBe("acted");
  expect(row.approved_at).not.toBeNull();
  expect(row.body).toMatchObject({
    policy: { max_cpa_usd: 80, automatic_stops: false },
    proposed_policy: policy,
    saved_revision: 1,
  });
  expect(
    (await db.query("select policy,revision from growth_business_policies"))
      .rows[0],
  ).toEqual({ policy: { ...policy, max_cpa_usd: 80 }, revision: 1 });
});
it("an identical replay reports saved once; different values are stale, never saved", async () => {
  await approve();
  expect(await approve()).toEqual({ status: "saved", changed: false });
  expect(await approve({ ...policy, automatic_stops: true })).toEqual({
    status: "stale_card",
  });
  expect((await read()).body.policy.automatic_stops).toBe(false);
  expect(
    (await db.query("select revision from growth_business_policies")).rows[0]
      .revision,
  ).toBe(1);
});
it.each(["member", "viewer"])(
  "refuses a %s without changing either row",
  async (role) => {
    await db.query("update tenant_users set role=$1", [role]);
    await expect(approve()).rejects.toThrow();
    expect((await read()).status).toBe("proposed");
    expect(
      (await db.query("select * from growth_business_policies")).rows,
    ).toHaveLength(0);
  },
);
it("accepts an admin", async () => {
  await db.exec("update tenant_users set role='admin'");
  expect((await approve()).status).toBe("saved");
});
it("refuses a foreign tenant even if the actor manages it", async () => {
  await db.query("insert into tenant_users values ($1,$2,'owner')", [
    other,
    actor,
  ]);
  expect((await approve(policy, policy, 0, other)).status).toBe("not_found");
  expect((await read()).status).toBe("proposed");
});
it("detects a settings-page save since proposal creation", async () => {
  await db.query("select save_growth_business_policy($1,$2,$3,0)", [
    tenant,
    actor,
    policy,
  ]);
  expect((await approve()).status).toBe("stale_card");
  expect((await read()).status).toBe("proposed");
});
it("detects a changed proposal", async () => {
  expect((await approve(policy, { ...policy, max_cpa_usd: 20 })).status).toBe(
    "stale_card",
  );
});
it("validation failure rolls back and leaves the card pending", async () => {
  await expect(approve({ ...policy, min_results: 0 })).rejects.toThrow();
  expect((await read()).status).toBe("proposed");
  expect(
    (await db.query("select * from growth_business_policies")).rows,
  ).toHaveLength(0);
});
it("a rejected proposal cannot be applied", async () => {
  await db.exec("update decisions set status='rejected'");
  expect((await approve()).status).toBe("stale_card");
});
it("generic approvals and worker claims cannot bypass the card", async () => {
  for (const status of ["approved", "dispatching", "dispatched", "acted"])
    await expect(
      db.query("update decisions set status=$1 where id=$2", [
        status,
        decision,
      ]),
    ).rejects.toThrow(/Review the editable/);
});
it("authenticated users cannot call the service-only approval RPC", async () => {
  expect(
    (
      await db.query(
        "select has_function_privilege('authenticated','public.approve_growth_business_controls(uuid,uuid,uuid,jsonb,jsonb,bigint)','execute') allowed",
      )
    ).rows[0].allowed,
  ).toBe(false);
});

it("records the edited settings once in the originating chat, never in a foreign workspace", async () => {
  await db.query("insert into agent_threads values($1,$2)", [actor, tenant]);
  await db.query(
    "insert into agent_runs(id,tenant_id,payload) values($1,$2,$3)",
    [decision, tenant, { thread_id: actor }],
  );
  await db.query("update decisions set agent_run_id=$1 where id=$1", [
    decision,
  ]);
  await approve({ ...policy, max_cpa_usd: 80 });
  await approve();
  const messages = (
    await db.query("select body,meta from agent_thread_messages")
  ).rows;
  expect(messages).toHaveLength(1);
  expect(messages[0].body).toContain("maximum CPA: $80");
  expect(messages[0].meta).toMatchObject({
    policy: { max_cpa_usd: 80 },
    saved_revision: 1,
  });
  const thread = (
    await db.query("select last_message_at from agent_threads where id=$1", [actor])
  ).rows[0];
  expect(new Date(thread.last_message_at).getTime()).toBeGreaterThan(
    new Date("2026-01-02").getTime(),
  );
});
it("does not send a receipt to a cross-tenant thread reference", async () => {
  await db.query("insert into agent_threads values($1,$2)", [actor, other]);
  await db.query(
    "insert into agent_runs(id,tenant_id,payload) values($1,$2,$3)",
    [decision, tenant, { thread_id: actor }],
  );
  await db.query("update decisions set agent_run_id=$1 where id=$1", [
    decision,
  ]);
  expect((await approve()).status).toBe("saved");
  expect(
    (await db.query("select * from agent_thread_messages")).rows,
  ).toHaveLength(0);
  expect(
    new Date(
      (await db.query("select last_message_at from agent_threads")).rows[0]
        .last_message_at,
    ).toISOString(),
  ).toBe(new Date("2026-01-01").toISOString());
});
it("reports Pro required without saving, while a disabled policy is allowed on a lower plan", async () => {
  await db.exec(
    "create or replace function _tenant_tier(p uuid) returns text language sql stable as $$ select 'growth'::text $$",
  );
  try {
    const response = await httpApprove({
      business_controls: { policy, expected_policy: policy, revision: 0 },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatchObject({
      code: "plan_required",
      message: expect.stringContaining("Pro plan"),
    });
    expect((await read()).status).toBe("proposed");
    expect(
      (await db.query("select * from growth_business_policies")).rows,
    ).toHaveLength(0);
    expect(
      (
        await httpApprove({
          business_controls: {
            policy: { ...policy, enabled: false },
            expected_policy: policy,
            revision: 0,
          },
        })
      ).status,
    ).toBe(200);
  } finally {
    await db.exec(
      "create or replace function _tenant_tier(p uuid) returns text language sql stable as $$ select 'pro'::text $$",
    );
  }
});

const headers = {
  "Content-Type": "application/json",
  "x-local-session": "fixture",
};
const httpApprove = (body: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/approvals/${decision}/approve`, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
  });
it("real HTTP read/edit/approve persists through the shared service and production SQL", async () => {
  const before = await fetch(
    `${base}/api/workspace/growth-controls/proposals/${decision}`,
    { headers },
  );
  expect(before.status).toBe(200);
  expect((await before.json()).current_policy).toBeNull();
  const response = await httpApprove({
    business_controls: {
      policy: { ...policy, max_cpa_usd: 85 },
      expected_policy: policy,
      revision: 0,
    },
  });
  expect(response.status).toBe(200);
  const after = await (
    await fetch(`${base}/api/workspace/growth-controls/proposals/${decision}`, {
      headers,
    })
  ).json();
  expect(after.proposal.status).toBe("acted");
  expect(after.current_policy).toMatchObject({
    max_cpa_usd: 85,
    revision: 1,
    automatic_stops: false,
  });
});
it("HTTP refuses anonymous, member, override, malformed and bare approvals", async () => {
  expect((await httpApprove({}, { "x-local-session": "" })).status).toBe(401);
  const body = {
    business_controls: { policy, expected_policy: policy, revision: 0 },
  };
  expect((await httpApprove(body, { "x-local-override": "true" })).status).toBe(
    409,
  );
  expect((await httpApprove({})).status).toBe(409);
  expect((await httpApprove({ business_controls: {} })).status).toBe(400);
  await db.exec("update tenant_users set role='member'");
  expect((await httpApprove(body)).status).toBe(403);
  expect((await read()).status).toBe("proposed");
});
it("HTTP conflict leaves policy and proposal unchanged; retain a fresh fixture for optional browser QA", async () => {
  await db.query("select save_growth_business_policy($1,$2,$3,0)", [
    tenant,
    actor,
    policy,
  ]);
  expect(
    (
      await httpApprove({
        business_controls: { policy, expected_policy: policy, revision: 0 },
      })
    ).status,
  ).toBe(409);
  expect((await read()).status).toBe("proposed");
  await db.exec("delete from growth_business_policies");
});
