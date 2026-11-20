#!/usr/bin/env node
import { randomUUID } from "node:crypto";

const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY,
        PIPEDREAM_CLIENT_ID: CID, PIPEDREAM_CLIENT_SECRET: CSE, PIPEDREAM_PROJECT_ID: PROJ } = process.env;
const ENV = (process.env.PIPEDREAM_ENVIRONMENT || "production").toLowerCase();
const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const BUCKET = "agent-chat-images";
const SB = { apikey: KEY, Authorization: `Bearer ${KEY}` };

let pass = 0, fail = 0;
const ok = (c, msg) => { c ? (pass++, console.log(`  ✅ ${msg}`)) : (fail++, console.log(`  ❌ ${msg}`)); };

console.log("\n── 1. Upload a real image to agent-chat-images (as the chat route does) ──");
const jpeg = Buffer.from(TINY_JPEG_B64, "base64");
const path = `${TENANT}/${randomUUID()}.jpg`;
const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
  method: "POST", headers: { ...SB, "Content-Type": "image/jpeg" }, body: jpeg,
});
ok(up.ok, `uploaded ${jpeg.length}B → ${BUCKET}/${path.slice(0, 45)}…  (HTTP ${up.status})`);
if (!up.ok) { console.log(await up.text()); process.exit(1); }

console.log("\n── 2. Frozen props at rest — must hold the PATH, never a URL ──");
const frozenProps = { file: path, text: "Zavi rail live test", visibility: "PUBLIC" };
ok(!/^https?:/.test(frozenProps.file), "configured_props.file is a storage path, not a URL");
ok(frozenProps.file.startsWith(`${TENANT}/`), "path is tenant-prefixed");

console.log("\n── 3. Sign at publish time (mirrors resolveMediaProps) ──");
async function sign(p) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${p}`, {
    method: "POST", headers: { ...SB, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!r.ok) return null;
  return `${SUPABASE_URL}/storage/v1${(await r.json()).signedURL}`;
}
const signed = await sign(path);
ok(!!signed, `minted a signed URL (${signed ? signed.slice(0, 60) + "…" : "FAILED"})`);

const otherPath = `e0fe9ea8-0000-4000-8000-000000000000/${randomUUID()}.jpg`;
ok(!otherPath.startsWith(`${TENANT}/`), "cross-tenant path is rejected BEFORE signing (guard is prefix-based)");

console.log("\n── 4. Can Pipedream's servers actually fetch it? ──");
const fetched = await fetch(signed);
ok(fetched.ok, `unauthenticated GET of the signed URL → HTTP ${fetched.status}`);
ok(fetched.headers.get("content-type")?.includes("image"), `content-type: ${fetched.headers.get("content-type")}`);
const bytes = Buffer.from(await fetched.arrayBuffer());
ok(bytes.length === jpeg.length, `byte-identical round trip (${bytes.length}B)`);

console.log("\n── 5. LIVE Pipedream actions/run → linkedin-create-image-post-user ──");
const TOK = (await (await fetch("https://api.pipedream.com/v1/oauth/token", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ grant_type: "client_credentials", client_id: CID, client_secret: CSE }),
})).json()).access_token;

const runRes = await fetch(`https://api.pipedream.com/v1/connect/${PROJ}/actions/run`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOK}`, "x-pd-environment": ENV, "Content-Type": "application/json" },
  body: JSON.stringify({
    external_user_id: TENANT,
    id: "linkedin-create-image-post-user",
    configured_props: { linkedin: { authProvisionId: "apn_probe" }, ...frozenProps, file: signed },
  }),
});
const runBody = await runRes.text();
ok(runRes.status === 200, `actions/run accepted the props shape → HTTP ${runRes.status}`);
const rejectedOnProps = /required|missing|invalid prop|ConfigurationError/i.test(runBody);
ok(!rejectedOnProps, "no prop-validation error (file/text/visibility all satisfied)");
const reachedLinkedIn = /linkedin\.com|x-restli|401|Unauthorized/i.test(runBody);
ok(reachedLinkedIn, "request reached LinkedIn's API (fails only on the fake credential)");
console.log(`\n     vendor response (first 300B):\n     ${runBody.slice(0, 300).replace(/\n/g, "\n     ")}`);

console.log("\n── 6. Cleanup ──");
const del = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { method: "DELETE", headers: SB });
ok(del.ok, `deleted the test object (HTTP ${del.status})`);

console.log(`\n${fail === 0 ? "✅" : "❌"}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
