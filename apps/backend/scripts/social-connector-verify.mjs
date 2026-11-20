#!/usr/bin/env node

const SLUG = process.argv[2];
const SPEC = {
  linkedin_social: { secrets: ["access_token", "author_urn"], scope: "w_member_social", ttlDays: [55, 61], refreshes: false },
  x_social: { secrets: ["access_token", "refresh_token", "user_id"], scope: "tweet.write", ttlDays: null, refreshes: true },
  reddit_social: { secrets: ["access_token", "refresh_token", "username"], scope: "submit", ttlDays: null, refreshes: true },
}[SLUG];
if (!SPEC) {
  console.error(`usage: social-connector-verify.mjs <linkedin_social|x_social|reddit_social>`);
  process.exit(2);
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY } = process.env;
const SB = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const rest = async (p) => (await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: SB })).json();

let TENANT = process.env.PROBE_TENANT_ID;
if (!TENANT) {
  const newest = await rest(`connector_metadata?slug=eq.${SLUG}&select=tenant_id&order=connected_at.desc&limit=1`);
  TENANT = Array.isArray(newest) && newest[0]?.tenant_id ? newest[0].tenant_id : null;
  if (!TENANT) { console.log(`\n❌ no tenant has connected ${SLUG} yet — the callback has not landed anywhere\n`); process.exit(1); }
  console.log(`\n  (no PROBE_TENANT_ID — using the most recently connected tenant ${TENANT.slice(0, 8)}…)`);
}

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ✅ ${m}`)) : (fail++, console.log(`  ❌ ${m}`)); };

console.log(`\n── ${SLUG} for tenant ${TENANT.slice(0, 8)}… ──`);
const meta = await rest(`connector_metadata?tenant_id=eq.${TENANT}&slug=eq.${SLUG}&select=team_id,team_name,scopes,token_expires_at,connected_at`);
const row = Array.isArray(meta) ? meta[0] : null;
ok(!!row, row ? `connector_metadata row: ${row.team_name} (id ${String(row.team_id).slice(0, 8)}…), connected ${row.connected_at}` : "connector_metadata row MISSING — callback did not land");
if (row) {
  ok((row.scopes ?? []).includes(SPEC.scope), `scopes include ${SPEC.scope} → ${JSON.stringify(row.scopes)}`);
  const exp = row.token_expires_at ? new Date(row.token_expires_at) : null;
  if (SPEC.ttlDays) {
    const d = exp ? Math.round((exp.getTime() - Date.now()) / 86_400_000) : null;
    ok(d !== null && d >= SPEC.ttlDays[0] && d <= SPEC.ttlDays[1], `token_expires_at ≈ ${SPEC.ttlDays[1]} days out (${d})`);
  } else {
    const mins = exp ? Math.round((exp.getTime() - Date.now()) / 60_000) : null;
    ok(exp !== null, `token_expires_at recorded (${mins} min out) — short-lived token, refresh handled by core/token.ts`);
  }
}
const secrets = await rest(`secrets?tenant_id=eq.${TENANT}&key=like.${SLUG}.*&select=key`);
const keys = new Set((Array.isArray(secrets) ? secrets : []).map((s) => s.key));
for (const s of SPEC.secrets) ok(keys.has(`${SLUG}.${s}`), `Vault secret ${SLUG}.${s} present`);
const mcp = await rest(`tenant_mcp_servers?tenant_id=eq.${TENANT}&server_id=eq.${SLUG}&select=transport,enabled`);
ok(Array.isArray(mcp) && mcp.length === 1 && mcp[0].transport === "internal", `tenant_mcp_servers row present (discovery warns + skips — harmless)`);

console.log(`\n${fail === 0 ? "✅" : "❌"}  ${pass} passed, ${fail} failed\n`);
if (fail === 0 && SPEC.refreshes) {
  const flag = SLUG === "reddit_social" ? "LIVE_REDDIT_PUBLISH" : "LIVE_X_PUBLISH";
  const dir = SLUG.replace("_social", "-social");
  console.log(`  Next — a REAL post (gated live test):\n  PROBE_TENANT_ID=${TENANT} ${flag}=1 node --env-file=.env ../../node_modules/vitest/vitest.mjs \\\n    run src/services/connectors/${dir}/__tests__/publish.live.test.ts\n`);
}
process.exit(fail === 0 ? 0 : 1);
