
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_ANON = process.env.SUPABASE_ANON_KEY;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

const HAS_ALL = !!(SUPA_URL && SUPA_ANON && SUPA_SERVICE && DB_URL);

const PROD_PROJECT_HOST = "wmycgyjsenvgtczlupoe.supabase.co";
const IS_PROD =
  (!!SUPA_URL && SUPA_URL.includes(PROD_PROJECT_HOST)) ||
  (!!DB_URL && DB_URL.includes(PROD_PROJECT_HOST));
if (IS_PROD) {
  // eslint-disable-next-line no-console
  console.warn(
    `[cross-tenant-matrix] refusing to run against prod (${PROD_PROJECT_HOST}). ` +
      `Skipping suite. Point SUPABASE_URL/SUPABASE_DB_URL at a local or test project.`,
  );
}

const SHOULD_RUN = HAS_ALL && !IS_PROD;

if (process.env.REQUIRE_RLS_MATRIX === "1" && !SHOULD_RUN) {
  throw new Error(
    `[cross-tenant-matrix] REQUIRE_RLS_MATRIX=1 but the suite would skip ` +
      `(HAS_ALL=${HAS_ALL}, IS_PROD=${IS_PROD}). In the gating job the matrix MUST run — ` +
      `confirm SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL ` +
      `point at the ephemeral local Supabase (never prod).`,
  );
}

const RLS_EXEMPT_TABLES = new Set<string>([
  "staff_audit_log",
  "slack_triage_window",
  "slack_triage_claims",
  "memory_recall_golden",
  "memory_recall_eval_run",
]);

interface TenantTable {
  table: string;
  rlsEnabled: boolean;
}

let pg: PgClient | null = null;
let tenantTables: TenantTable[] = [];

let tenantA = "";
let tenantB = "";
let memberAJwt = "";
let memberBJwt = "";
let plantedRunBId = "";

function svc(): SupabaseClient {
  return createClient(SUPA_URL!, SUPA_SERVICE!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function clientWithJwt(jwt: string): SupabaseClient {
  return createClient(SUPA_URL!, SUPA_ANON!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
}

async function signUpAndSignIn(
  sb: SupabaseClient,
  email: string,
  password: string,
  activeTenantId: string,
): Promise<{ id: string; jwt: string }> {
  const { data: created, error: cErr } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { active_tenant_id: activeTenantId },
  });
  if (cErr || !created.user) {
    throw new Error(`createUser ${email}: ${cErr?.message}`);
  }
  const anon = createClient(SUPA_URL!, SUPA_ANON!);
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (sErr || !sess.session) {
    throw new Error(`signIn ${email}: ${sErr?.message}`);
  }
  return { id: created.user.id, jwt: sess.session.access_token };
}

async function discoverTenantTables(client: PgClient): Promise<TenantTable[]> {
  const { rows } = await client.query<{ table: string; rls_enabled: boolean }>(`
    select c.relname as table, c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'                              -- ordinary tables only
      and exists (
        select 1 from information_schema.columns col
        where col.table_schema = 'public'
          and col.table_name = c.relname
          and col.column_name = 'tenant_id'
      )
    order by c.relname
  `);
  return rows.map((r) => ({ table: r.table, rlsEnabled: r.rls_enabled }));
}

describe.skipIf(!SHOULD_RUN)("cross-tenant isolation matrix (auto-generated)", () => {
  beforeAll(async () => {
    const isLocalDb = /(^|@|\/\/)(localhost|127\.0\.0\.1|\[::1\])/.test(DB_URL!);
    pg = new PgClient({
      connectionString: DB_URL!,
      ssl: isLocalDb ? false : { rejectUnauthorized: true },
    });
    await pg.connect();
    tenantTables = await discoverTenantTables(pg);

    const sb = svc();
    const ts = Date.now();

    const { data: tA, error: tAErr } = await sb
      .from("tenants")
      .insert({ slug: `xtmatrix-a-${ts}`, display_name: "XT Matrix A" })
      .select("id")
      .single();
    if (tAErr || !tA) throw new Error(`tenant A: ${tAErr?.message}`);
    tenantA = tA.id;

    const { data: tB, error: tBErr } = await sb
      .from("tenants")
      .insert({ slug: `xtmatrix-b-${ts}`, display_name: "XT Matrix B" })
      .select("id")
      .single();
    if (tBErr || !tB) throw new Error(`tenant B: ${tBErr?.message}`);
    tenantB = tB.id;

    const pw = "xt-matrix-PW-12345!Aa";
    const memberA = await signUpAndSignIn(sb, `xtmatrix-mem-a-${ts}@zavi.test`, pw, tenantA);
    const memberB = await signUpAndSignIn(sb, `xtmatrix-mem-b-${ts}@zavi.test`, pw, tenantB);
    memberAJwt = memberA.jwt;
    memberBJwt = memberB.jwt;

    const { error: tuErr } = await sb.from("tenant_users").insert([
      { tenant_id: tenantA, user_id: memberA.id, role: "owner" },
      { tenant_id: tenantB, user_id: memberB.id, role: "owner" },
    ]);
    if (tuErr) throw new Error(`tenant_users seed: ${tuErr.message}`);

    const { data: runB, error: runErr } = await sb
      .from("agent_runs")
      .insert({
        tenant_id: tenantB,
        agent_slug: "qa",
        enqueued_by: null,
        trigger: "cron",
        agent_definition_hash: `xt-matrix-${ts}`,
        status: "completed",
      })
      .select("id")
      .single();
    if (runErr || !runB) throw new Error(`agent_runs B canary: ${runErr?.message}`);
    plantedRunBId = runB.id;
  }, 120_000);

  afterAll(async () => {
    if (!SHOULD_RUN) return;
    const sb = svc();
    if (tenantA) await sb.from("tenants").delete().eq("id", tenantA);
    if (tenantB) await sb.from("tenants").delete().eq("id", tenantB);
    if (pg) await pg.end();
  });

  it("discovers a non-trivial set of tenant_id tables from the live schema", () => {
    expect(tenantTables.length).toBeGreaterThan(40);
    expect(tenantTables.map((t) => t.table)).toContain("agent_runs");
  });

  it("every tenant_id table has RLS enabled on the live DB (or is allowlisted)", () => {
    const missing = tenantTables
      .filter((t) => !t.rlsEnabled && !RLS_EXEMPT_TABLES.has(t.table))
      .map((t) => t.table)
      .sort();
    expect(
      missing,
      `Live RLS DISABLED on tenant_id table(s) — the authed/anon role can read ` +
        `EVERY tenant's rows. Enable RLS + a tenant-scoped policy, or allowlist ` +
        `with justification (keep in lockstep with tenant-rls-coverage.test.ts):\n` +
        missing.map((t) => `  - ${t}`).join("\n"),
    ).toEqual([]);
  });

  describe("authed-JWT cross-tenant SELECT denial (per table)", () => {
    it("no RLS-enabled tenant_id table leaks tenant B's rows to tenant A's JWT", async () => {
      const aClient = clientWithJwt(memberAJwt);

      const { data: selfRows, error: selfErr } = await aClient
        .from("agent_runs")
        .select("tenant_id")
        .eq("tenant_id", tenantA)
        .limit(1);
      expect(
        selfErr,
        `tenant A's JWT could not even query its own agent_runs — the auth path ` +
          `is broken, so the cross-tenant 0-rows checks below would false-pass: ${selfErr?.message}`,
      ).toBeNull();
      void selfRows;

      const leaks: string[] = [];

      for (const { table, rlsEnabled } of tenantTables) {
        if (!rlsEnabled) continue;
        if (RLS_EXEMPT_TABLES.has(table)) continue;

        const { data, error } = await aClient
          .from(table)
          .select("tenant_id")
          .eq("tenant_id", tenantB)
          .limit(1);

        if (error) continue;
        if (Array.isArray(data) && data.length > 0) {
          leaks.push(`${table} (returned ${data.length} of tenant B's rows to tenant A's JWT)`);
        }
      }

      expect(
        leaks,
        `CROSS-TENANT LEAK — these RLS-enabled tables returned another tenant's ` +
          `rows to an authed JWT scoped to a DIFFERENT tenant. The RLS policy is ` +
          `too permissive (or filters on the wrong column):\n` +
          leaks.map((l) => `  - ${l}`).join("\n"),
      ).toEqual([]);
    }, 120_000);
  });

  it("agent_runs: tenant A's JWT CANNOT see tenant B's planted run", async () => {
    const aClient = clientWithJwt(memberAJwt);
    const { data, error } = await aClient
      .from("agent_runs")
      .select("id, tenant_id")
      .eq("id", plantedRunBId);
    if (error) {
      return;
    }
    expect((data ?? []).length).toBe(0);
  });

  it("agent_runs: tenant B's OWN JWT CAN see its planted run (positive control)", async () => {
    const bClient = clientWithJwt(memberBJwt);
    const { data, error } = await bClient
      .from("agent_runs")
      .select("id, tenant_id")
      .eq("id", plantedRunBId);
    if (error) throw new Error(`tenant B self-read failed: ${error.message}`);
    expect((data ?? []).length).toBe(1);
    expect((data ?? [])[0]?.tenant_id).toBe(tenantB);
  });

  it("db connector: redeeming a pairing code deletes every operator_db.* secret of THAT tenant only", async () => {
    const db = pg!;
    const hex = (c: string) => c.repeat(64);
    const plant = async (tenant: string) => {
      const { rows } = await db.query("select vault.create_secret($1) as id", [`postgres://reader:pw@db.example/${tenant}`]);
      await db.query("insert into public.secrets (tenant_id, key, vault_secret_id) values ($1, 'operator_db.connection_string', $2) on conflict (tenant_id, key) do update set vault_secret_id = excluded.vault_secret_id", [tenant, rows[0].id]);
      return rows[0].id as string;
    };
    const vaultA = await plant(tenantA);
    await plant(tenantB);
    const codeHash = hex("7");
    const { rows: code } = await db.query(
      "insert into public.db_connector_pair_codes (tenant_id, code_hash, expires_at) values ($1, $2, now() + interval '30 minutes') returning id",
      [tenantA, codeHash],
    );
    try {
      const { rows: redeemed } = await db.query("select public.redeem_db_connector_pair_code($1, $2, $3, $4, 'matrix', '1.0') as id", [tenantA, code[0].id, codeHash, hex("8")]);
      expect(redeemed[0].id).toBeTruthy();
      const { rows: left } = await db.query("select count(*)::int as n from public.secrets where tenant_id = $1 and left(key, 12) = 'operator_db.'", [tenantA]);
      expect(left[0].n).toBe(0);
      const { rows: vaultLeft } = await db.query("select count(*)::int as n from vault.secrets where id = $1", [vaultA]);
      expect(vaultLeft[0].n).toBe(0);
      const { rows: other } = await db.query("select count(*)::int as n from public.secrets where tenant_id = $1 and left(key, 12) = 'operator_db.'", [tenantB]);
      expect(other[0].n).toBe(1);
      const { data } = await clientWithJwt(memberAJwt).from("db_connectors").select("id");
      expect(data ?? []).toHaveLength(0);
    } finally {
      await db.query("delete from public.db_connectors where tenant_id = $1", [tenantA]);
      await db.query("delete from public.db_connector_pair_codes where tenant_id = $1", [tenantA]);
      await db.query("delete from public.secrets where tenant_id = $1 and key = 'operator_db.connection_string'", [tenantB]);
    }
  });
});
