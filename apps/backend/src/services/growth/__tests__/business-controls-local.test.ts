import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { beforeAll, beforeEach, afterAll, it, expect, vi } from "vitest";
import { seedBudgetSchema } from "./budget-sql-fixture";
import { BUSINESS_CONTROL_DEFAULTS } from "../business-control-policy";
import {
  getGrowthControls,
  putGrowthControls,
  postGrowthExperiment,
} from "@/routes/workspace/growth-controls";
import { monitorExperiments } from "../business-control-runtime";
const t = "11111111-1111-1111-1111-111111111111",
  u = "99999999-9999-9999-9999-999999999999";
let db: any, server: Server, base: string;
let pauseFails = false;
let finishBrowserQa: (() => void) | undefined;
const identity = (req: any) => req.headers["x-local-qa-role"];
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (req: any, res: any) => {
    if (!identity(req)) {
      res
        .status(401)
        .json({ error: { message: "Local fixture session required" } });
      return null;
    }
    return { tenant_id: t, user_id: u, local_role: identity(req) };
  },
}));
vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRole: async (a: any) => a.local_role,
  requireTenantRole: async (a: any, roles: string[], res: any) => {
    if (roles.includes(a.local_role)) return true;
    res.status(403).json({ error: { message: "Owner or admin required" } });
    return false;
  },
}));
vi.mock("@/services/agents/entitlement", () => ({
  loadTierGateConfig: async () => ({}),
  resolveTenantTier: async () => "pro",
}));
vi.mock("@/services/growth/ad-spend-controller", () => ({
  readMetaInventory: async () => ({ objects: [] }),
  readGoogleInventory: async () => ({ objects: [] }),
}));
vi.mock("@/services/growth/unattended-policy", () => ({
  loadTracking: async () => ({ ok: false }),
}));
vi.mock("@/services/growth/ad-goal-match", () => ({
  loadAdGoalMode: async () => ({ ok: true, mode: "count" }),
}));
vi.mock("@/services/growth/cgo-ad-orders", () => ({
  submitCgoAdAction: async (input: any) => {
    if (pauseFails)
      return { ok: false, why: "Fixture provider refused the pause" };
    const id = randomUUID();
    await db.query(
      "insert into channel_actions(id,tenant_id,run_id,channel_slug,exec_payload,exec_status,proposed_at) values($1,$2,$3,$4,$5::jsonb,'queued',now())",
      [id, t, u, input.channel_slug, JSON.stringify(input.body)],
    );
    return { ok: true, action_id: id };
  },
}));
function query(tenant: string, table: string) {
  if (
    ![
      "growth_business_policies",
      "growth_experiment_controls",
      "ad_campaigns",
      "ad_spend_daily",
      "channel_actions",
    ].includes(table)
  )
    throw new Error(`Unexpected table ${table}`);
  let fields = "*",
    offset = 0,
    limit = 1001;
  const orders: string[] = [];
  const values: any[] = [tenant],
    clauses = ["tenant_id=$1"];
  const bind = (v: any) => {
    values.push(v);
    return `$${values.length}`;
  };
  const col = (s: string) => {
    if (!/^[a-z_]+$/.test(s)) throw new Error("Invalid fixture column");
    return s;
  };
  const run = async (single = false) => {
    try {
      const result = await db.query(
        `select ${fields} from ${table} where ${clauses.join(" and ")}${orders.length ? ` order by ${orders.join(", ")}` : ""} limit ${limit} offset ${offset}`,
        values,
      );
      const rows = JSON.parse(JSON.stringify(result.rows));
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  };
  const q: any = {
    select: (s: string) => {
      if (!/^[a-z_,* ]+$/.test(s)) throw new Error("Invalid fixture fields");
      fields = s;
      return q;
    },
    eq: (c: string, v: any) => {
      clauses.push(`${col(c)}=${bind(v)}`);
      return q;
    },
    gte: (c: string, v: any) => {
      clauses.push(`${col(c)}>=${bind(v)}`);
      return q;
    },
    lte: (c: string, v: any) => {
      clauses.push(`${col(c)}<=${bind(v)}`);
      return q;
    },
    in: (c: string, v: any[]) => {
      clauses.push(`${col(c)} in (${v.map(bind).join(",")})`);
      return q;
    },
    or: (s: string) => {
      const prefix = "stopped_at.is.null,started_at.gte.";
      if (!s.startsWith(prefix)) throw new Error("Unexpected OR");
      clauses.push(
        `(stopped_at is null or started_at>=${bind(s.slice(prefix.length))})`,
      );
      return q;
    },
    order: (c: string, o?: any) => {
      orders.push(`${col(c)} ${o?.ascending === false ? "desc" : "asc"}`);
      return q;
    },
    range: (from: number, to: number) => {
      offset = from;
      limit = to - from + 1;
      return run();
    },
    limit: (n: number) => {
      limit = n;
      return run();
    },
    maybeSingle: () => run(true),
  };
  return q;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: (id: string) => ({ from: (table: string) => query(id, table) }),
  tenantRpc: async (id: string, name: string, p: any) => {
    const args: Record<string, any[]> = {
      save_growth_business_policy: [id, p.p_actor, p.p_policy, p.p_revision],
      register_growth_experiment: [id, p.p_actor, p.p_experiment],
      record_growth_experiment_check: [id, p.p_id, p.p_check],
    };
    if (!args[name]) throw new Error(`Unexpected RPC ${name}`);
    try {
      const a = args[name].map((v) =>
        typeof v === "object" && v !== null ? JSON.stringify(v) : v,
      );
      const r = await db.query(
        `select ${name}(${a.map((_, i) => `$${i + 1}`).join(",")}) result`,
        a,
      );
      return { data: r.rows[0].result, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  },
}));
async function reset() {
  await db.exec("truncate tenants cascade");
  await db.query("insert into tenants values($1)", [t]);
  await db.query("insert into tenant_users values($1,$2,'owner')", [t, u]);
  await db.query("insert into agent_runs(id,tenant_id) values($1,$2)", [u, t]);
  await db.query(
    "insert into ad_budgets(tenant_id,monthly_usd,started_on,month_start,actual_read_at) values($1,3000,current_date-40,date_trunc('month',now()),now())",
    [t],
  );
  await db.query(
    "select record_ad_ledger_read($1,'google','account-1',$2::jsonb,'[]'::jsonb)",
    [
      t,
      JSON.stringify(
        [1, 2, 3].map((n) => ({
          object_id: `campaign-${n}`,
          campaign_id: `campaign-${n}`,
          level: "campaign",
          name: `Local test campaign ${n}`,
          budget_kind: "daily",
          budget_usd: 10,
          status: "ACTIVE",
          currency: "USD",
        })),
      ),
    ],
  );
  pauseFails = false;
}
const saved = {
  ...BUSINESS_CONTROL_DEFAULTS,
  enabled: true,
  automatic_stops: true,
};
const input = (object = "campaign-1") => ({
  name: "Landing page experiment",
  hypothesis: "A clearer headline improves purchases",
  platform: "google",
  account_id: "account-1",
  object_id: object,
  budget_usd: 100,
  ends_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  stop_on_loss: false,
});
async function request(
  method: string,
  path: string,
  body?: unknown,
  role = "owner",
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(role ? { "x-local-qa-role": role } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
beforeAll(async () => {
  const modules = process.env.ADS_SQL_TEST_MODULES;
  const { PGlite } = createRequire(
    modules ? resolve(modules, "../package.json") : __filename,
  )("@electric-sql/pglite");
  db = new PGlite();
  await seedBudgetSchema(db);
  await db.exec(
    readFileSync(
      resolve(
        "../../supabase/migrations/20261009074317_growth_business_controls.sql",
      ),
      "utf8",
    ),
  );
  await db.exec(
    "alter table channel_actions add column channel_slug text,add column exec_payload jsonb,add column exec_status text,add column proposed_at timestamptz,add column executed_at timestamptz,add column exec_claimed_at timestamptz",
  );
  for (const col of ["exec_class text", "approved_by_source text"])
    await db.exec(`alter table channel_actions add column if not exists ${col}`);
  await db.exec(
    readFileSync(resolve("../../supabase/migrations/20261114210000_test_stop_rows.sql"), "utf8"),
  );
  const app = express();
  app.use(express.json());
  app.get("/api/workspace/growth-controls", getGrowthControls);
  app.put("/api/workspace/growth-controls", putGrowthControls);
  app.post("/api/workspace/growth-controls/experiments", postGrowthExperiment);
  if (process.env.LOCAL_BUSINESS_QA_DIR)
    app.use(express.static(process.env.LOCAL_BUSINESS_QA_DIR));
  if (process.env.LOCAL_BUSINESS_QA_PORT)
    app.post("/__qa/finish", (_req, res) => {
      res.json({ ok: true });
      finishBrowserQa?.();
    });
  server = app.listen(
    Number(process.env.LOCAL_BUSINESS_QA_PORT ?? 0),
    "127.0.0.1",
  );
  await new Promise<void>((r, j) => {
    server.once("listening", r);
    server.once("error", j);
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
}, 30000);
beforeEach(reset);
afterAll(async () => {
  if (process.env.LOCAL_BUSINESS_QA_PORT) {
    await reset();
    console.log(`LOCAL_QA_READY ${base}`);
    await new Promise<void>((r) => {
      const timer = setTimeout(
        r,
        Number(process.env.LOCAL_BUSINESS_QA_MS ?? 600000),
      );
      finishBrowserQa = () => {
        clearTimeout(timer);
        r();
      };
    });
  }
  await new Promise<void>((r) => server?.close(() => r()));
  await db?.close();
}, 650000);
it("round-trips recommendations, edits, revisions and permissions through HTTP and SQL", async () => {
  const url = "/api/workspace/growth-controls";
  expect((await request("GET", url, undefined, "")).status).toBe(401);
  const initial = await request("GET", url);
  expect(initial.status).toBe(200);
  expect(initial.body.policy).toBeNull();
  expect(initial.body.recommendation.policy.max_cpa_usd).toBe(25);
  expect(
    (await request("PUT", url, { policy: saved, revision: 0 }, "viewer"))
      .status,
  ).toBe(403);
  expect(
    (
      await request("PUT", url, {
        policy: { ...saved, max_cpa_usd: 40 },
        revision: 0,
      })
    ).status,
  ).toBe(200);
  const current = await request("GET", url);
  expect(current.body.policy).toMatchObject({ max_cpa_usd: 40, revision: 1 });
  expect(
    (await request("PUT", url, { policy: saved, revision: 0 })).status,
  ).toBe(409);
  expect(
    (
      await request("PUT", url, {
        policy: { ...saved, max_cpa_usd: -1 },
        revision: 1,
      })
    ).status,
  ).toBe(400);
  expect((await request("GET", url, undefined, "viewer")).body.can_manage).toBe(
    false,
  );
});
it("registers an envelope, latches a failed stop, confirms readback, and retains late spend", async () => {
  const path = "/api/workspace/growth-controls/experiments";
  expect((await request("POST", path, input())).status).toBe(400);
  await request("PUT", "/api/workspace/growth-controls", {
    policy: saved,
    revision: 0,
  });
  const created = await request("POST", path, input());
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id;
  expect((await request("POST", path, input())).status).toBe(400);
  await db.query(
    "insert into ad_spend_daily(tenant_id,platform,account_id,object_id,spend_date,source,amount_usd) values($1,'google','account-1','campaign-1',current_date,'api',85)",
    [t],
  );
  pauseFails = true;
  await monitorExperiments(t);
  let e = (await request("GET", "/api/workspace/growth-controls")).body
    .experiments[0];
  expect(e).toMatchObject({ id, state: "stop_failed", spent_usd: 85 });
  expect(e.stop_requested_at).toBeTruthy();
  expect(e.stopped_at).toBeNull();
  pauseFails = false;
  await monitorExperiments(t);
  e = (await request("GET", "/api/workspace/growth-controls")).body
    .experiments[0];
  expect(e.state).toBe("stopping");
  expect(e.pause_action_id).toBeTruthy();
  await monitorExperiments(t);
  expect(
    (await db.query("select count(*)::int n from channel_actions")).rows[0].n,
  ).toBe(1);
  await db.exec(
    "update channel_actions set exec_status='executed',executed_at=now()-interval '1 second'; update ad_campaigns set status='PAUSED',as_of=now() where object_id='campaign-1'",
  );
  await monitorExperiments(t);
  e = (await request("GET", "/api/workspace/growth-controls")).body
    .experiments[0];
  expect(e.state).toBe("stopped");
  expect(e.stopped_at).toBeTruthy();
  await db.exec("update ad_spend_daily set amount_usd=95");
  await monitorExperiments(t);
  e = (await request("GET", "/api/workspace/growth-controls")).body
    .experiments[0];
  expect(e.spent_usd).toBe(95);
  await db.exec("update ad_spend_daily set amount_usd=80");
  await monitorExperiments(t);
  e = (await request("GET", "/api/workspace/growth-controls")).body
    .experiments[0];
  expect(e.spent_usd).toBe(95);
  expect(e.state).toBe("stopped");
});
it("enforces total exploration allocation across separate HTTP registrations", async () => {
  await request("PUT", "/api/workspace/growth-controls", {
    policy: saved,
    revision: 0,
  });
  const results = await Promise.all([
    request("POST", "/api/workspace/growth-controls/experiments", {
      ...input("campaign-1"),
      budget_usd: 200,
    }),
    request("POST", "/api/workspace/growth-controls/experiments", {
      ...input("campaign-2"),
      budget_usd: 200,
    }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
});
