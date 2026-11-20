
import "tsconfig-paths/register";
import { globalClient } from "@/services/tenant-client";
import { estimateCost } from "@/services/media-router/router";
import {
  buildIllustrationPrompt,
  generateCreatorIllustration,
  RETRY_AFTER_MS,
} from "@/services/creators/creator-illustration";

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

type Row = { id: string; skills: string[] | null; illustration_generated_at: string | null };

async function main() {
  const { data, error } = await globalClient()
    .from("human_members")
    .select("id, skills, illustration_generated_at")
    .eq("vetting_state", "approved")
    .is("photo_path", null)
    .is("illustration_path", null)
    .order("created_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(`read failed: ${error.message}`);

  const now = Date.now();
  const all = (data ?? []) as Row[];
  const inFlight = all.filter(
    (r) => r.illustration_generated_at && now - Date.parse(r.illustration_generated_at) < RETRY_AFTER_MS,
  );
  const rows = all.filter((r) => !inFlight.includes(r)).slice(0, LIMIT);
  const retries = rows.filter((r) => r.illustration_generated_at).length;
  const each = estimateCost("image.photo", { prompt: "x", aspect_ratio: "1:1" });

  console.log(`live creators with no photo and no illustration: ${all.length}`);
  console.log(`  skipped, claimed in the last hour (a worker may be on it): ${inFlight.length}`);
  console.log(`  to generate: ${rows.length} (of which ${retries} retry a failed attempt)`);
  console.log(`  estimated cost: ${rows.length} x $${each.toFixed(4)} = $${(rows.length * each).toFixed(2)} (Zavi pays)`);
  if (rows[0]) console.log(`  sample prompt: ${buildIllustrationPrompt(rows[0].id, rows[0].skills)}`);

  if (!APPLY) {
    console.log("\nDry run. Nothing generated or written. Re-run with --apply to generate.");
    return;
  }
  if (!(process.env.FAL_KEY || "").trim()) throw new Error("FAL_KEY is not set: refusing to --apply.");

  const tally: Record<string, number> = {};
  let spent = 0;
  for (const r of rows) {
    const out = await generateCreatorIllustration(r.id, undefined, { retryFailed: true });
    tally[out.outcome] = (tally[out.outcome] ?? 0) + 1;
    spent += out.cost_usd ?? 0;
    console.log(`${r.id}: ${out.outcome}`);
  }
  console.log("\noutcomes:", tally);
  console.log(`vendor cost: $${spent.toFixed(2)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
