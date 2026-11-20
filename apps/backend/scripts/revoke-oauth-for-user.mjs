
import { createScriptClient } from "./_supabase-script-client.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const APPLY = args.includes("--apply");
let userId = flag("--user");
const email = flag("--email")?.trim().toLowerCase();

if (!userId === !email) {
  console.error("Usage: revoke-oauth-for-user.mjs (--user <uuid> | --email <address>) [--apply]");
  process.exit(1);
}

const ref = (process.env.SUPABASE_URL ?? "").match(/^https:\/\/([a-z0-9]+)\./i)?.[1] ?? "(unknown)";
const sb = createScriptClient();
console.log(`Supabase project ref: ${ref}  (${process.env.SUPABASE_URL})`);

if (email) {
  for (let page = 1; !userId; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.error(`ERROR listing users: ${error.message}`);
      process.exit(1);
    }
    const users = data?.users ?? [];
    if (users.length === 0) break;
    userId = users.find((u) => (u.email ?? "").toLowerCase() === email)?.id;
  }
  if (!userId) {
    console.error(`ERROR: no user with email ${email} in project ${ref}`);
    process.exit(1);
  }
  console.log(`Resolved ${email} -> user ${userId}`);
}

if (!/^[0-9a-f-]{36}$/i.test(userId)) {
  console.error(`ERROR: --user must be a uuid, got "${userId}"`);
  process.exit(1);
}

const TABLES = ["oauth_refresh_tokens", "oauth_access_tokens"];

for (const table of TABLES) {
  const { data, error } = await sb
    .from(table)
    .select("client_id")
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) {
    console.error(`ERROR reading ${table}: ${error.message}`);
    process.exit(1);
  }
  const byClient = {};
  for (const r of data ?? []) byClient[r.client_id] = (byClient[r.client_id] ?? 0) + 1;
  console.log(`${table}: ${data?.length ?? 0} non-revoked row(s)`, byClient);
}

if (!APPLY) {
  console.log(`\nDRY-RUN on project ${ref}: nothing written. Re-run with --apply to revoke.`);
  process.exit(0);
}

console.log(`\nAPPLYING on project ${ref} for user ${userId}...`);
const MAX_PASSES = 5;
for (let pass = 1; ; pass++) {
  const now = new Date().toISOString();
  let revoked = 0;
  for (const table of TABLES) {
    const { data, error } = await sb
      .from(table)
      .update({ revoked_at: now })
      .eq("user_id", userId)
      .is("revoked_at", null)
      .select("id");
    if (error) {
      console.error(`ERROR revoking ${table}: ${error.message}`);
      process.exit(1);
    }
    revoked += data?.length ?? 0;
    console.log(`pass ${pass} ${table}: revoked ${data?.length ?? 0} row(s)`);
  }
  if (revoked === 0) break;
  if (pass >= MAX_PASSES) {
    console.error(`ERROR: still finding live tokens after ${MAX_PASSES} passes. Re-run, and check whether a client is refreshing in a loop.`);
    process.exit(1);
  }
}
console.log("Done. Reply to the requester that their AI-assistant connections are revoked.");
