#!/usr/bin/env node
import sharp from "sharp";
const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: ANON,
  QA_TEST_PASSWORD: PW,
  SUPABASE_SERVICE_ROLE_KEY: KEY,
} = process.env;
const BASE = process.env.BACKEND_URL || "http://localhost:3001";
const TENANT = process.env.QA_TENANT_ID || "6fcb0904-4e2b-41dc-aa92-83810a902d2d";
const EMAIL = process.env.QA_TEST_EMAIL;

const tokRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PW }),
});
const { access_token: TOK } = await tokRes.json();

{
  const c = JSON.parse(Buffer.from(TOK.split(".")[1], "base64url").toString("utf8"));
  const active = c.active_tenant_id ?? c.app_metadata?.active_tenant_id ?? c.tenant_id ?? null;
  if (active !== TENANT) {
    console.log(`The QA token's active tenant is ${active ?? "unknown"}, not ${TENANT}. Run the QA preflight (docs/agent-guide/local-dev-and-qa.md). Nothing was sent.`);
    process.exit(1);
  }
}
const authH = { Authorization: `Bearer ${TOK}` };

const jpeg = await sharp({
  create: { width: 200, height: 200, channels: 3, background: "#3366cc" },
})
  .jpeg()
  .toBuffer();

const form = new FormData();
form.append("file", new Blob([jpeg], { type: "image/jpeg" }), "probe.jpg");

const up = await fetch(`${BASE}/api/chat/upload-image`, {
  method: "POST",
  headers: authH,
  body: form,
});
const upBody = await up.json();
console.log(`upload-image → HTTP ${up.status}`, upBody);
if (!up.ok) process.exit(1);

const imagePath = upBody.image_path;
if (!imagePath.startsWith(`${TENANT}/`)) {
  console.log("✗ image_path missing tenant prefix");
  process.exit(1);
}

const prop = await fetch(`${BASE}/api/social/propose`, {
  method: "POST",
  headers: { ...authH, "Content-Type": "application/json" },
  body: JSON.stringify({
    channel: "linkedin_image",
    payload: { text: `[live-test] image propose ${Date.now()}`, image_path: imagePath },
  }),
});
const propBody = await prop.json();
console.log(`propose linkedin_image → HTTP ${prop.status}`, propBody);
if (!prop.ok) process.exit(1);

if (KEY) {
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  const row = await fetch(
    `${SUPABASE_URL}/rest/v1/decisions?id=eq.${propBody.decision_id}&select=body`,
    { headers: H },
  );
  const [d] = await row.json();
  const path = d?.body?.payload?.image_path;
  console.log(`decision image_path = ${path}`);
  if (path !== imagePath) {
    console.log("✗ image_path mismatch in decision");
    process.exit(1);
  }
}

console.log("✓ linkedin_image propose live OK");
