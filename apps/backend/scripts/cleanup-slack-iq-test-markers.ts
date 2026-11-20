
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const PROD_URL_HOST = "wmycgyjsenvgtczlupoe.supabase.co";
const RAVI_TEST_TENANT_ID = "73db45ff-457e-4541-bc8f-bdb625390204";

async function main() {
  const url = process.env.SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const dryRun = process.argv.includes("--dry-run");

  if (!url || !svc) {
    console.error("missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (apps/backend/.env)");
    process.exit(1);
  }
  if (!url.includes(PROD_URL_HOST)) {
    console.error(`refusing to run: SUPABASE_URL is ${url}, not the prod project (${PROD_URL_HOST}).`);
    console.error("this script is hard-gated to prod by design (Stage 3 belt-and-suspenders).");
    process.exit(1);
  }

  console.log(`MODE: ${dryRun ? "DRY-RUN (no deletes)" : "LIVE (will DELETE)"}`);
  console.log(`URL: ${url}`);

  const sc = createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } });

  const today = new Date().toISOString().slice(0, 10);
  const { data: ledgerRows, error: ledgerSelErr } = await sc
    .from("slack_summary_budget_ledger")
    .select("tenant_id, day, cents, count")
    .eq("tenant_id", RAVI_TEST_TENANT_ID)
    .eq("day", today);
  if (ledgerSelErr) {
    console.error("ledger select failed:", ledgerSelErr);
    process.exit(1);
  }
  console.log(`\n[1/2] slack_summary_budget_ledger rows for tenant=${RAVI_TEST_TENANT_ID} day=${today}:`);
  for (const r of ledgerRows ?? []) {
    console.log(`  tenant_id=${r.tenant_id} day=${r.day} cents=${r.cents} count=${r.count}`);
  }
  const ledgerCount = ledgerRows?.length ?? 0;

  if (!dryRun && ledgerCount > 0) {
    const { error: ledgerDelErr } = await sc
      .from("slack_summary_budget_ledger")
      .delete()
      .eq("tenant_id", RAVI_TEST_TENANT_ID)
      .eq("day", today);
    if (ledgerDelErr) {
      console.error("ledger delete failed:", ledgerDelErr);
      process.exit(1);
    }
    console.log(`  DELETED ${ledgerCount} row(s).`);
  }

  const { data: chRows, error: chSelErr } = await sc
    .from("slack_channels")
    .select("tenant_id, channel_id, name")
    .like("channel_id", "TEST_RLS_%");
  if (chSelErr) {
    console.error("slack_channels select failed:", chSelErr);
    process.exit(1);
  }
  console.log(`\n[2/2] slack_channels rows matching channel_id LIKE 'TEST_RLS_%':`);
  for (const r of chRows ?? []) {
    console.log(`  tenant_id=${r.tenant_id} channel_id=${r.channel_id} name=${r.name}`);
  }
  const chCount = chRows?.length ?? 0;

  if (!dryRun && chCount > 0) {
    const { error: chDelErr } = await sc
      .from("slack_channels")
      .delete()
      .like("channel_id", "TEST_RLS_%");
    if (chDelErr) {
      console.error("slack_channels delete failed:", chDelErr);
      process.exit(1);
    }
    console.log(`  DELETED ${chCount} row(s).`);
  }

  const total = ledgerCount + chCount;
  console.log(`\nSUMMARY: ${dryRun ? "would delete" : "deleted"} ${total} row(s) (${ledgerCount} ledger + ${chCount} channels).`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
