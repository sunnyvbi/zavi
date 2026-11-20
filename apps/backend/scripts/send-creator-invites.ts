
import "tsconfig-paths/register";
import { countBatch, parseRowList, reconcileLinks } from "@/services/creators/creator-invites";
import { runInviteSend, sheetRowOf, type SendRowEvent } from "@/services/creators/creator-invite-send";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const value = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] ?? "" : undefined;
};

const APPLY = has("--apply");
const BATCH = value("--batch");
const MAX = Number(value("--max") ?? 100);
const DELAY_MS = Number(value("--delay-ms") ?? 600);
const RETRY = has("--retry-failed");
const INCLUDE_CONVERSATION = has("--include-in-conversation");

const ROW_TEXT: Record<SendRowEvent["outcome"], string> = {
  sent: "sent",
  rejected: "REJECTED by SendGrid, retry with --retry-failed",
  unknown: "UNKNOWN, SendGrid may have sent it. Never retried automatically; check SendGrid activity.",
  changed: "skipped, changed since it was listed",
  render_skipped: "skipped, the email does not render",
  record_failed: "stamped, but the failure could not be recorded. Check this row by hand.",
};

async function main() {
  if (has("--nudge")) throw new Error("--nudge was removed: each creator gets exactly one email, the invite.");
  if (!BATCH) throw new Error("--batch <label> is required.");
  if (!Number.isInteger(MAX) || MAX < 1) throw new Error("--max must be a positive whole number.");
  const rows = parseRowList(value("--rows"), "--rows");
  const skipRows = parseRowList(value("--skip-rows"), "--skip-rows");
  if (APPLY && !has("--reconcile") && !rows.length && value("--max") === undefined) {
    throw new Error("--apply sends real email: pass --rows (e.g. 12-50) or an explicit --max.");
  }

  console.log(`Supabase: ${new URL(process.env.SUPABASE_URL ?? "http://unset").host}`);
  console.log(`Batch: ${BATCH} · mode: ${RETRY ? "retry" : "invite"}${APPLY ? "" : "  (dry run)"}`);

  if ((await countBatch(BATCH)) === 0) throw new Error(`Batch "${BATCH}" has no rows. Check the label used with import-creators.ts.`);

  if (has("--reconcile")) {
    if (!APPLY) {
      console.log("Dry run: skipping the signup-link repair (it writes).");
      return;
    }
    console.log(`Linked ${await reconcileLinks()} invite(s) to creators who already signed up.`);
    return;
  }
  if (!APPLY) console.log("Dry run: skipping the signup-link repair (it writes).");

  let problems: string[] = [];
  try {
    const res = await runInviteSend({
      batch: BATCH,
      max: MAX,
      rows,
      skipRows,
      retry: RETRY,
      includeInConversation: INCLUDE_CONVERSATION,
      apply: APPLY,
      acknowledgedNoGeo: has("--acknowledge-no-geo"),
      env: process.env,
      delayMs: DELAY_MS,
      onRow: (e) => console.log(`  row ${e.sheetRow ?? "?"} · ${e.name}: ${ROW_TEXT[e.outcome]}${e.detail ? ` (${e.detail})` : ""}`),
    });
    problems = res.problems;
    console.log(`Sender: ${res.sender.name} <${res.sender.email}>`);
    console.log(`Links: ${res.links.web ?? "(PRAXIS_PUBLIC_BASE not set)"}/creators/apply?src=invite&invite=<per-creator token> · unsubscribe via ${res.links.api ?? "(BACKEND_PUBLIC_URL not set)"}`);
    for (const s of res.skipped) console.log(`  skip row ${s.sheetRow ?? "?"} ${s.name}: ${s.reason}`);
    if (!APPLY) {
      console.log(`\nWould send ${res.toSend.length} of ${res.eligibleCount} eligible${rows.length ? "" : ` (max ${MAX})`}:`);
      for (const r of res.toSend) console.log(`  row ${sheetRowOf(r) ?? "?"} · ${r.display_name}`);
      for (const p of problems) console.log(`  ✗ ${p}`);
      console.log("\nDry run. Nothing stamped or sent. Re-run with the same flags plus --acknowledge-no-geo --apply.");
      return;
    }
    const t = res.tally;
    if (res.stoppedReason) console.log(`\nStopping: ${res.stoppedReason}.`);
    console.log(`\nDone: ${t.sent} sent, ${t.rejected} rejected (retry with --retry-failed), ${t.unknown} unknown (check SendGrid; never auto-retried), ${t.changed} changed since listed.`);
    console.log("Check labels: select label, count(*) from creator_invite_status where batch = '<batch>' group by 1;");
  } catch (e) {
    for (const p of problems) console.log(`  ✗ ${p}`);
    throw e;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
