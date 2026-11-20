#!/usr/bin/env node
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY } = process.env;
const BASE = process.env.BACKEND_URL || "http://localhost:3001";

console.log("═══ BEFORE: Option B surface check ═══\n");

let routeExists = false;
try {
  const r = await fetch(`${BASE}/api/social/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "linkedin", payload: { text: "probe" } }),
  });
  console.log(`POST /api/social/propose  → HTTP ${r.status} (${r.status === 404 ? "NOT BUILT YET" : "exists"})`);
  routeExists = r.status !== 404;
} catch (e) {
  console.log(`POST /api/social/propose  → unreachable (${e.message})`);
}

if (SUPABASE_URL && KEY) {
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
  const flag = await fetch(`${SUPABASE_URL}/rest/v1/rpc/_social_publish_enabled`, {
    method: "POST", headers: H, body: "{}",
  });
  const enabled = flag.ok ? await flag.json() : "?";
  console.log(`_social_publish_enabled()     = ${enabled}`);

  const posts = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?select=id&limit=1`, { headers: H });
  const postRows = posts.ok ? await posts.json() : [];
  console.log(`social_posts rows             = ${Array.isArray(postRows) ? postRows.length : "?"}`);

  const decisions = await fetch(
    `${SUPABASE_URL}/rest/v1/decisions?decision_class=eq.social.publish.v2&select=id,status&limit=3&order=emitted_at.desc`,
    { headers: H },
  );
  const decRows = decisions.ok ? await decisions.json() : [];
  console.log(`recent social.publish.v2      = ${JSON.stringify(decRows)}`);
} else {
  console.log("(skip DB — no SUPABASE creds)");
}

console.log(`\nRoute built: ${routeExists ? "YES" : "NO — expected before build"}\n`);
