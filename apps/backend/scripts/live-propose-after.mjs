#!/usr/bin/env node
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: KEY,
  SUPABASE_ANON_KEY: ANON,
  QA_TEST_PASSWORD: PW,
} = process.env;
const BASE = process.env.BACKEND_URL || "http://localhost:3001";
const TENANT = process.env.QA_TENANT_ID || "6fcb0904-4e2b-41dc-aa92-83810a902d2d";
const EMAIL = process.env.QA_TEST_EMAIL;

console.log("═══ AFTER: Option B live test ═══\n");

let routeStatus = 0;
try {
  const r = await fetch(`${BASE}/api/social/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "linkedin", payload: { text: "live probe" } }),
  });
  routeStatus = r.status;
  console.log(`POST /api/social/propose (no auth) → HTTP ${r.status} ${r.status === 401 ? "✓" : "(expected 401)"}`);
} catch (e) {
  console.log(`POST /api/social/propose → unreachable (${e.message})`);
  process.exit(1);
}

if (!SUPABASE_URL || !ANON || !PW) {
  console.log("\n(skip authed propose — missing SUPABASE_ANON_KEY or QA_TEST_PASSWORD)");
  process.exit(routeStatus === 401 ? 0 : 1);
}

const tokRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PW }),
});
if (!tokRes.ok) {
  console.log("auth token mint failed", await tokRes.text());
  process.exit(1);
}
const { access_token: TOK } = await tokRes.json();

{
  const c = JSON.parse(Buffer.from(TOK.split(".")[1], "base64url").toString("utf8"));
  const active = c.active_tenant_id ?? c.app_metadata?.active_tenant_id ?? c.tenant_id ?? null;
  if (active !== TENANT) {
    console.log(`The QA token's active tenant is ${active ?? "unknown"}, not ${TENANT}. Run the QA preflight (docs/agent-guide/local-dev-and-qa.md). Nothing was sent.`);
    process.exit(1);
  }
}

const proposeRes = await fetch(`${BASE}/api/social/propose`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOK}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    channel: "linkedin",
    payload: { text: `[live-test] Option B propose ${new Date().toISOString()}` },
    scheduled_at: null,
  }),
});
const proposeBody = await proposeRes.json();
console.log(`POST /api/social/propose (authed)  → HTTP ${proposeRes.status}`);
console.log(`  body: ${JSON.stringify(proposeBody)}`);

if (!proposeRes.ok || !proposeBody.decision_id) {
  console.log("\n✗ propose failed");
  process.exit(1);
}

const decisionId = proposeBody.decision_id;

if (KEY) {
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  const row = await fetch(
    `${SUPABASE_URL}/rest/v1/decisions?id=eq.${decisionId}&select=id,status,decision_class,body`,
    { headers: H },
  );
  const rows = await row.json();
  const d = rows[0];
  console.log(`\nDB decision row:`);
  console.log(`  id=${d?.id} status=${d?.status} class=${d?.decision_class}`);
  console.log(`  channel=${d?.body?.channel} origin=${d?.body?.origin}`);
  console.log(`  text preview=${(d?.body?.payload?.text ?? "").slice(0, 60)}…`);
}

console.log("\n✓ Option B propose path works live\n");
