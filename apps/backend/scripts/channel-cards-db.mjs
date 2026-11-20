
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CHANNEL = /^[a-z0-9_]{1,40}$/;

export function checkTenantRef(ref) {
  if (!UUID.test(ref) && !SLUG.test(ref)) throw new Error(`not a tenant slug or id: ${JSON.stringify(ref)}`);
  return ref;
}
export function checkChannel(ch) {
  if (!CHANNEL.test(ch)) throw new Error(`not a channel slug: ${JSON.stringify(ch)}`);
  return ch;
}
const uuid = (id) => {
  if (!UUID.test(id)) throw new Error(`not a uuid: ${JSON.stringify(id)}`);
  return `'${id}'`;
};

const MARK = "@@CARDS_JSON@@";

export function prodRows(select) {
  const bin = process.env.ZAVI_PROD_SQL ?? join(homedir(), "bin", "zavi-prod-sql");
  const script = `\\pset tuples_only on\n\\pset format unaligned\nselect '${MARK}' || coalesce(json_agg(cards_row_)::text, '[]') from (${select}) cards_row_;\n`;
  return new Promise((resolve, reject) => {
    const p = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      const i = out.indexOf(MARK);
      if (code !== 0 || i < 0) return reject(new Error(`zavi-prod-sql exit ${code}: ${err.trim().slice(-400)}`));
      resolve(JSON.parse(out.slice(i + MARK.length).trim()));
    });
    p.stdin.end(script);
  });
}

function restClient() {
  const SURL = process.env.SUPABASE_URL;
  const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SURL || !SRK) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (run with --env-file=.env), or pass --prod");
  return async (path) => {
    const res = await fetch(`${SURL}/rest/v1/${path}`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
    if (!res.ok) throw new Error(`${res.status} ${path.split("?")[0]}: ${await res.text()}`);
    return res.json();
  };
}

const ACTION_COLS = ["id", "channel_slug", "run_id", "title", "status", "action_type", "snoozed_until", "proposed_at", "exec_class", "exec_status"];

export function cardsDb({ prod }) {
  if (prod) {
    return {
      source: "prod (zavi-prod-sql, read-only)",
      tenants: () =>
        prodRows(
          "select id, slug, kind, display_name, product_url from tenants where exists (select 1 from channel_actions a where a.tenant_id = tenants.id)",
        ),
      actions: (tenantId) =>
        prodRows(`select ${ACTION_COLS.join(", ")}, body->'step' as step from channel_actions where tenant_id = ${uuid(tenantId)} limit 2000`),
      toolCalls: async (runId) => (await prodRows(`select tool_calls from agent_runs where id = ${uuid(runId)}`))[0]?.tool_calls ?? null,
      facts: (tenantId) => prodRows(`select key, value_text from tenant_fact where tenant_id = ${uuid(tenantId)} limit 200`),
    };
  }
  const rest = restClient();
  return {
    source: `REST ${process.env.SUPABASE_URL}`,
    tenants: async () => {
      const tenants = await rest("tenants?select=id,slug,kind,display_name,product_url&limit=1000");
      const withCards = new Set((await rest("channel_actions?select=tenant_id&limit=10000")).map((r) => r.tenant_id));
      return tenants.filter((t) => withCards.has(t.id));
    },
    actions: (tenantId) => rest(`channel_actions?tenant_id=eq.${tenantId}&select=${ACTION_COLS.join(",")},step:body->step&limit=2000`),
    toolCalls: async (runId) => (await rest(`agent_runs?id=eq.${runId}&select=tool_calls`))[0]?.tool_calls ?? null,
    facts: (tenantId) => rest(`tenant_fact?tenant_id=eq.${tenantId}&select=key,value_text&limit=200`),
  };
}

export function pickTenants(tenants, ref) {
  if (!ref) return tenants;
  const want = new Set(ref.split(",").map((x) => checkTenantRef(x.trim())));
  return tenants.filter((t) => want.has(t.slug) || want.has(t.id));
}
