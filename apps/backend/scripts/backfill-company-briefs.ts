
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { getCompanyFacts } from "@/services/company/facts";
import { renderCompanyBrief, regenerateCompanyBrief } from "@/services/company/brief";
import {
  planBriefBackfill,
  isWriteAction,
  type BriefBackfillAction,
} from "@/services/company/backfill-plan";

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const tenantArg = process.argv.indexOf("--tenant");
const ONLY_TENANT = tenantArg > -1 ? process.argv[tenantArg + 1] : null;

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const sb = createClient(url, key, { auth: { persistSession: false } });

type Row = { tenant_id: string; body_markdown: string | null };

async function main(): Promise<void> {
  const { data: storyRows, error: storyErr } = await sb
    .from("tenant_fact")
    .select("tenant_id")
    .eq("key", "company_story");
  if (storyErr) throw new Error(`tenant_fact read failed: ${storyErr.message}`);
  const withStory = new Set((storyRows ?? []).map((r) => (r as { tenant_id: string }).tenant_id));

  const { data: noteRows, error: noteErr } = await sb
    .from("memory_note")
    .select("tenant_id, body_markdown")
    .eq("slug", "company")
    .is("superseded_by", null);
  if (noteErr) throw new Error(`memory_note read failed: ${noteErr.message}`);
  const liveBodyByTenant = new Map<string, string | null>();
  for (const r of (noteRows ?? []) as Row[]) liveBodyByTenant.set(r.tenant_id, r.body_markdown);

  const candidates = ONLY_TENANT ? [ONLY_TENANT] : Array.from(withStory);
  const tally: Record<BriefBackfillAction | "failed", number> = {
    render: 0,
    skip_no_story: 0,
    skip_would_empty: 0,
    skip_already_current: 0,
    failed: 0,
  };

  const untouchedNotes = Array.from(liveBodyByTenant.keys()).filter((t) => !withStory.has(t));
  console.log(
    `[backfill-company-briefs] ${APPLY ? "APPLY" : "DRY-RUN"} — ${candidates.length} candidate tenant(s) ` +
      `with a company_story, ${liveBodyByTenant.size} live company note(s), ` +
      `${untouchedNotes.length} note(s) left alone (no story in the record)`,
  );

  if (APPLY) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `company-brief-backup-${stamp}.json`;
    writeFileSync(
      path,
      JSON.stringify(
        (noteRows ?? []).map((r) => r as Row),
        null,
        2,
      ),
    );
    console.log(`  snapshot: ${liveBodyByTenant.size} current bodies written to ${path}`);
  }

  let processed = 0;
  for (const tenant_id of candidates) {
    if (processed >= LIMIT) break;
    processed += 1;

    let action: BriefBackfillAction;
    try {
      const record = await getCompanyFacts(tenant_id);
      action = planBriefBackfill({
        hasStory: withStory.has(tenant_id),
        renderedBody: renderCompanyBrief(record),
        liveBody: liveBodyByTenant.get(tenant_id) ?? null,
      });
    } catch (e) {
      tally.failed += 1;
      console.log(`  ${tenant_id}  FAILED to read: ${(e as Error).message}`);
      continue;
    }

    tally[action] += 1;
    const hadNote = liveBodyByTenant.has(tenant_id);
    console.log(`  ${tenant_id}  ${action}${action === "render" && !hadNote ? " (no brief today)" : ""}`);

    if (!APPLY || !isWriteAction(action)) continue;

    const ok = await regenerateCompanyBrief(tenant_id);
    if (!ok) {
      tally.render -= 1;
      tally.failed += 1;
      console.log(`  ${tenant_id}  RENDER FAILED (left as it was)`);
    }
  }

  console.log(
    `\n[backfill-company-briefs] ${APPLY ? "applied" : "planned"}: ` +
      `${tally.render} rendered, ${tally.skip_already_current} already current, ` +
      `${tally.skip_would_empty} skipped (would render empty), ` +
      `${tally.skip_no_story + untouchedNotes.length} left alone (no story in record), ` +
      `${tally.failed} failed`,
  );
  if (!APPLY) console.log("Dry run — nothing was written. Re-run with --apply.");
  if (tally.failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[backfill-company-briefs] ${(e as Error).message}`);
  process.exit(1);
});
