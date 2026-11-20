#!/usr/bin/env node

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY } = process.env;
const SB = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const rest = async (p) => (await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: SB })).json();

let TENANT = process.env.PROBE_TENANT_ID;
if (!TENANT) {
  const newest = await rest("connector_metadata?slug=eq.linkedin_social&select=tenant_id,connected_at&order=connected_at.desc&limit=1");
  TENANT = Array.isArray(newest) && newest[0]?.tenant_id ? newest[0].tenant_id : "73db45ff-457e-4541-bc8f-bdb625390204";
  console.log(`\n  (no PROBE_TENANT_ID — using the most recently connected tenant ${TENANT.slice(0, 8)}…)`);
}

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ✅ ${m}`)) : (fail++, console.log(`  ❌ ${m}`)); };

console.log(`\n── linkedin_social for tenant ${TENANT.slice(0, 8)}… ──`);

const meta = await rest(`connector_metadata?tenant_id=eq.${TENANT}&slug=eq.linkedin_social&select=slug,team_id,team_name,scopes,token_expires_at,connected_at`);
const row = Array.isArray(meta) ? meta[0] : null;
ok(!!row, row ? `connector_metadata row: ${row.team_name} (person ${String(row.team_id).slice(0, 6)}…), connected ${row.connected_at}` : "connector_metadata row MISSING — the callback did not land");
if (row) {
  ok((row.scopes ?? []).includes("w_member_social"), `scopes include w_member_social → ${JSON.stringify(row.scopes)}`);
  const exp = row.token_expires_at ? new Date(row.token_expires_at) : null;
  const days = exp ? Math.round((exp.getTime() - Date.now()) / 86_400_000) : null;
  ok(days !== null && days >= 55 && days <= 61, `token_expires_at ≈ 60 days out (${days} days) — the no-refresh cliff the rail guards`);
}

const secrets = await rest(`secrets?tenant_id=eq.${TENANT}&key=in.(linkedin_social.access_token,linkedin_social.author_urn)&select=key`);
const keys = new Set((Array.isArray(secrets) ? secrets : []).map((s) => s.key));
ok(keys.has("linkedin_social.access_token"), "Vault secret linkedin_social.access_token present");
ok(keys.has("linkedin_social.author_urn"), "Vault secret linkedin_social.author_urn present");

const mcp = await rest(`tenant_mcp_servers?tenant_id=eq.${TENANT}&server_id=eq.linkedin_social&select=server_id,transport,enabled`);
ok(Array.isArray(mcp) && mcp.length === 1 && mcp[0].transport === "internal", `tenant_mcp_servers row: ${JSON.stringify(mcp?.[0] ?? null)} (discovery warns + skips — harmless)`);

console.log(`\n${fail === 0 ? "✅" : "❌"}  ${pass} passed, ${fail} failed\n`);
if (fail === 0) {
  console.log("  Next — a REAL post through the native connector (gated live test, publishes publicly):");
  console.log("  LIVE_LINKEDIN_PUBLISH=1 node --env-file=.env ../../node_modules/vitest/vitest.mjs \\");
  console.log("    run src/services/connectors/linkedin-social/__tests__/publish.live.test.ts\n");
}
process.exit(fail === 0 ? 0 : 1);
