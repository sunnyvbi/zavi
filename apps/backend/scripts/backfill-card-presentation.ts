
import "tsconfig-paths/register";
import { createClient } from "@supabase/supabase-js";
import { backfillPresentation, needsSiteBuilder, type BackfillRow } from "@/services/channels/card-backfill";
import { siteBuilderFor } from "@/services/channels/site-builder";
import type { SiteBuilder } from "@/services/channels/site-builder-markers";

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const BATCH = 50;

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (run with --env-file=.env)");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const cols = "id, tenant_id, channel_slug, action_type, exec_class, body";
  let migrated = true;
  let { data, error } = await sb
    .from("channel_actions")
    .select(cols)
    .in("status", ["pending", "snoozed"])
    .is("card_kind", null)
    .limit(5000);
  if (error && /card_kind/.test(error.message)) {
    migrated = false;
    console.log("card_kind column not present: migration 20260925060000 not applied yet. Reporting only.");
    ({ data, error } = await sb.from("channel_actions").select(cols).in("status", ["pending", "snoozed"]).limit(5000));
  }
  if (error) throw new Error(`read failed: ${error.message}`);
  const rows = ((data ?? []) as BackfillRow[]).slice(0, LIMIT);

  const builders = new Map<string, SiteBuilder>();
  const plan: Array<{ row: BackfillRow; p: ReturnType<typeof backfillPresentation> }> = [];
  for (const row of rows) {
    let builder: SiteBuilder = "unknown";
    if (needsSiteBuilder(row)) {
      if (!builders.has(row.tenant_id)) {
        builders.set(row.tenant_id, APPLY ? await siteBuilderFor(row.tenant_id) : "unknown");
      }
      builder = builders.get(row.tenant_id)!;
    }
    plan.push({ row, p: backfillPresentation(row, builder) });
  }

  const byKind = new Map<string, number>();
  const byLabel = new Map<string, number>();
  for (const { p } of plan) {
    byKind.set(p.card_kind, (byKind.get(p.card_kind) ?? 0) + 1);
    byLabel.set(p.primary_label, (byLabel.get(p.primary_label) ?? 0) + 1);
  }
  console.log(`open cards without stored words: ${plan.length}`);
  console.log("by kind:", Object.fromEntries([...byKind].sort((a, b) => b[1] - a[1])));
  console.log("by main button:", Object.fromEntries([...byLabel].sort((a, b) => b[1] - a[1])));

  if (!APPLY) {
    console.log("dry run: nothing written. Re-run with --apply after the migration is deployed.");
    return;
  }
  if (!migrated) throw new Error("refusing --apply: the migration is not applied");

  let written = 0;
  let skipped = 0;
  for (let i = 0; i < plan.length; i += BATCH) {
    for (const { row, p } of plan.slice(i, i + BATCH)) {
      const { data: upd, error: e } = await sb
        .from("channel_actions")
        .update({ card_kind: p.card_kind, primary_label: p.primary_label, done_label: p.done_label, how_to: p.how_to })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id)
        .is("card_kind", null)
        .in("status", ["pending", "snoozed"])
        .select("id");
      if (e) throw new Error(`update ${row.id} failed: ${e.message}`);
      if (upd && upd.length) written++;
      else skipped++;
    }
    console.log(`… ${Math.min(i + BATCH, plan.length)}/${plan.length}`);
  }
  console.log(`written ${written}, skipped ${skipped} (filled or closed meanwhile)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
