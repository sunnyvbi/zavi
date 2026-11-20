
import "tsconfig-paths/register";
import { readFileSync, writeFileSync } from "node:fs";
import { cleanupUntouched, formatListedInvite, listBatch, missingEmailCsv, parseCreatorSheet } from "@/services/creators/creator-invites";
import { planUpload, validateBatch, validateLimit } from "@/services/creators/creator-invite-upload";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const value = (flag: string): string | undefined => {
  const i = argv.lastIndexOf(flag);
  return i > -1 ? argv[i + 1] : undefined;
};

const APPLY = has("--apply");
const FILE = value("--file");
const BATCH = value("--batch");
const EXCLUDE_FILE = value("--exclude-domains");
const MISSING_OUT = value("--missing-out");
const SHEET_ONLY = has("--sheet-only");
const LIMIT_RAW = value("--limit");

function list(label: string, rows: number[]): void {
  if (rows.length) console.log(`  ${label}: ${rows.length} (sheet rows ${rows.join(", ")})`);
}

async function main() {
  validateBatch(BATCH);
  const limit = validateLimit(LIMIT_RAW);
  if (!BATCH) return;

  console.log(`Supabase: ${new URL(process.env.SUPABASE_URL ?? "http://unset").host}`);
  console.log(`Batch: ${BATCH}${APPLY ? "" : "  (dry run)"}`);

  if (has("--list")) {
    const rows = await listBatch(BATCH);
    console.log(`\n${rows.length} record(s) in batch ${BATCH}:`);
    for (const r of rows) console.log(`  ${formatListedInvite(r, has("--show-emails"))}`);
    const labels: Record<string, number> = {};
    for (const r of rows) labels[r.label] = (labels[r.label] ?? 0) + 1;
    console.log("\nBy label:", labels);
    return;
  }

  if (has("--cleanup")) {
    const n = await cleanupUntouched(BATCH, APPLY);
    console.log(APPLY ? `Deleted ${n} untouched row(s).` : `Would delete ${n} untouched row(s). Re-run with --apply.`);
    return;
  }

  if (!FILE) throw new Error("--file <path to the sheet CSV> is required.");
  const excludeDomains = EXCLUDE_FILE
    ? readFileSync(EXCLUDE_FILE, "utf8").split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#"))
    : [];

  const csvText = readFileSync(FILE, "utf8");
  const plan = await planUpload({ csvText, batch: BATCH, limit, apply: APPLY, excludeDomains, sheetOnly: SHEET_ONLY });
  const { report } = plan;

  console.log(`\nSheet: ${report.rowsRead} row(s) read, ${report.blankRows} blank`);
  for (const e of report.errors) console.log(`  row ${e.sheetRow}: skipped, ${e.reason}`);
  list("dropped, marked \"Duplicate of row N\" in the sheet", report.sheetDuplicates);
  list("dropped, same email + same name as an earlier row", report.sameEmailDuplicates);
  list("dropped, same name + Source URL as an earlier row", report.sourceKeyDuplicates);
  list("held for review, shared email with a different creator (email not loaded)", report.duplicateReview);
  if (report.sharedDomains.length) console.log(`  company domains held as agency (2+ creators share them): ${report.sharedDomains.join(", ")}`);

  if (MISSING_OUT) {
    const { rows } = parseCreatorSheet(csvText, { excludeDomains });
    writeFileSync(MISSING_OUT, missingEmailCsv(rows), "utf8");
    console.log(`\nWrote the rows with no usable email to ${MISSING_OUT} (sheet row, name, hold). Keep it in private-data/.`);
  }

  console.log(`\nRows in the sheet: ${plan.rowCount} (${plan.withEmail} with an email)`);
  console.log(`  held:`, plan.holds);
  console.log(`  already in an email conversation with us: ${plan.inConversation}`);
  if (plan.hasAccountRows.length) console.log(`  already have a Zavi account (never invited): ${plan.hasAccountRows.length} (sheet rows ${plan.hasAccountRows.join(", ")})`);
  console.log(`  invitable now: ${plan.invitableNow}`);
  console.log(`  invitable with --include-in-conversation: ${plan.invitableWithConversation}`);

  if (limit !== null) {
    console.log(`\n--limit ${limit}: loading the first ${plan.loaded.length} invitable creator(s), in sheet order:`);
    for (const r of plan.loaded) console.log(`  row ${r.sheetRow} · ${r.displayName}`);
    console.log("Check them with --list, then run again without --limit to load the rest.");
  }
  if (!plan.result) {
    console.log("\n--sheet-only: no database read or write (the account check was skipped).");
    return;
  }

  const result = plan.result;
  console.log(`\n${APPLY ? "Wrote" : "Would write"}: ${result.inserted} new, ${result.updated} refreshed`);
  list("email conflicts, held (stored email kept)", result.emailConflicts);
  list("skipped, creator account was deleted", result.skippedDeleted);
  if (!APPLY) console.log("\nDry run. Nothing written. Re-run with --apply to load.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
