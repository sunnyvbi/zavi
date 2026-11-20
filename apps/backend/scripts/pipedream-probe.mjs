#!/usr/bin/env node

const { PIPEDREAM_CLIENT_ID: CID, PIPEDREAM_CLIENT_SECRET: CSE, PIPEDREAM_PROJECT_ID: PROJ } = process.env;
const ENV = (process.env.PIPEDREAM_ENVIRONMENT?.trim() || "production").toLowerCase();
const BASE = "https://api.pipedream.com/v1";

if (!CID || !CSE || !PROJ) {
  console.error("Missing PIPEDREAM_CLIENT_ID / _SECRET / _PROJECT_ID. Run from apps/backend with --env-file=.env");
  process.exit(1);
}

const CHANNELS = [
  ["linkedin  (enabled)", "linkedin-create-text-post-user"],
  ["linkedin_image (enabled)", "linkedin-create-image-post-user"],
  ["reddit    (enabled)", "reddit-submit-a-post"],
  ["x         (disabled: cost)", "twitter-create-tweet"],
  ["linkedin_org (removed: 404 + no destination writer)", "linkedin-create-text-share-organization"],
  ["linkedin_org (the real id, needs partner approval)", "linkedin-create-text-post-organization"],
  ["instagram (parked: media + Meta review)", "instagram_business-create-post"],
  ["youtube   (parked: media + Google review)", "youtube_data_api-upload-video"],
];

const tokRes = await fetch(`${BASE}/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ grant_type: "client_credentials", client_id: CID, client_secret: CSE }),
});
if (!tokRes.ok) {
  console.error(`auth failed: HTTP ${tokRes.status}`);
  process.exit(1);
}
const TOK = (await tokRes.json()).access_token;

async function call(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOK}`,
      "x-pd-environment": ENV,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {  }
  return { ok: r.ok, status: r.status, json, text };
}

console.log(`\nPipedream project ${PROJ.slice(0, 12)}…  environment=${ENV}\n`);

const args = process.argv.slice(2);
const TENANT = process.env.PROBE_TENANT_ID || "73db45ff-457e-4541-bc8f-bdb625390204";

if (args.includes("--accounts")) {
  const r = await call("GET", `/connect/${PROJ}/accounts?external_user_id=${TENANT}`);
  console.log(`Connected accounts for ${TENANT.slice(0, 8)}…  (HTTP ${r.status})`);
  const rows = r.json?.data ?? [];
  if (!rows.length) console.log("  (none — connect one in Settings, or in dev mode be signed in to pipedream.com)");
  for (const a of rows) {
    console.log(`  • ${String(a.app?.name_slug ?? "?").padEnd(22)} id=${a.id}  healthy=${a.healthy}`);
  }
  process.exit(0);
}

const runIdx = args.indexOf("--run");
if (runIdx !== -1) {
  const accountId = args[runIdx + 1];
  if (!accountId) {
    console.error("--run needs an account id (get one from --accounts)");
    process.exit(1);
  }
  const text = `Zavi social-publish rail smoke test ${new Date().toISOString()}`;
  console.log(`⚠️  PUBLISHING PUBLICLY to LinkedIn as account ${accountId}\n   "${text}"\n`);
  const r = await call("POST", `/connect/${PROJ}/actions/run`, {
    external_user_id: TENANT,
    id: "linkedin-create-text-post-user",
    configured_props: { linkedin: { authProvisionId: accountId }, text, visibility: "PUBLIC" },
  });
  console.log(`HTTP ${r.status}`);
  console.log(r.text.slice(0, 1500));
  process.exit(r.ok ? 0 : 1);
}

console.log("── Can this plan/environment call tools at all? ──");
const gate = await call("GET", `/connect/${PROJ}/components/reddit-submit-a-post`);
if (gate.ok) {
  console.log("✅ component API available\n");
} else {
  console.log(`❌ HTTP ${gate.status}: ${(gate.json?.error ?? gate.text).slice(0, 160)}`);
  console.log("   → set PIPEDREAM_ENVIRONMENT=development in your LOCAL .env (free),");
  console.log("     or upgrade to the $99/mo Connect plan for production.\n");
  process.exit(1);
}

console.log("── Action ids + REQUIRED props (live) ──");
for (const [label, key] of CHANNELS) {
  const r = await call("GET", `/connect/${PROJ}/components/${encodeURIComponent(key)}`);
  if (!r.ok) {
    console.log(`\n❌ ${label}\n   ${key}  → HTTP ${r.status} ${(r.json?.error ?? "").slice(0, 80)}`);
    continue;
  }
  const d = r.json.data;
  console.log(`\n✅ ${label}\n   ${key}  v${d.version}`);
  for (const p of d.configurable_props ?? []) {
    if (p.type === "app") {
      console.log(`     auth slot → "${p.name}"   (app: ${p.app})`);
      continue;
    }
    const req = p.optional ? "optional" : "REQUIRED";
    const kind = p.remoteOptions ? "  ⚠ remote options (raw string is accepted by actions/run)"
               : p.options ? "  [static options]" : "";
    console.log(`     ${req.padEnd(9)} ${String(p.name).padEnd(16)} ${String(p.type).padEnd(9)}${kind}`);
  }
}
console.log("\nCross-check every REQUIRED prop above against buildProps in social-channels.ts.\n");
