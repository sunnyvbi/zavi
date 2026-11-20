
import { createClient } from "@supabase/supabase-js";

const KEY = "platform_badge_global_enabled";
const DESCRIPTION =
  "GLOBAL master switch for injecting the 'Made with Zavi' badge onto deployed tenant apps. Default OFF — no app shows the badge until this is enabled fleet-wide. When ON, the per-tenant website_platform_badge_hidden flag decides per app. Fail-closed: OFF (and read-error) => badge hidden.";

const APPLY = process.argv.includes("--apply");
const valIdx = process.argv.indexOf("--value");
const VALUE = valIdx !== -1 ? process.argv[valIdx + 1] !== "false" : true;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (run with --env-file=.env)");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const { data: before, error: readErr } = await sb
  .from("app_setting")
  .select("key, value, value_type, updated_by, updated_at")
  .eq("key", KEY)
  .maybeSingle();
if (readErr) {
  console.error(`ERROR reading current value: ${readErr.message}`);
  process.exit(1);
}
console.log("CURRENT:", before ?? "(no row — using registry default false → gate OFF)");

if (!APPLY) {
  console.log(`\nDRY-RUN: would upsert ${KEY} = ${VALUE}. Re-run with --apply to commit.`);
  process.exit(0);
}

const now = new Date().toISOString();
const { error: writeErr } = await sb.from("app_setting").upsert(
  {
    key: KEY,
    value: VALUE,
    value_type: "boolean",
    description: DESCRIPTION,
    updated_by: "ravi (badge fleet reveal 2026-07-24)",
    updated_at: now,
  },
  { onConflict: "key" },
);
if (writeErr) {
  console.error(`ERROR writing value: ${writeErr.message}`);
  process.exit(1);
}

const { data: after } = await sb
  .from("app_setting")
  .select("key, value, value_type, updated_by, updated_at")
  .eq("key", KEY)
  .maybeSingle();
console.log("AFTER:  ", after);
console.log(`\nDONE. Gate ${KEY} = ${VALUE}. Prod picks it up within ~60s (settings cache TTL).`);
