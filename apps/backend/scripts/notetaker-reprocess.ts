
import { requestMeetingReprocess } from "@/services/meetings/reprocess";

async function main(): Promise<void> {
  const id = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    console.error("usage: notetaker-reprocess.js <meeting_bot_id> [--dry] [--rerun]");
    process.exitCode = 2;
    return;
  }
  const dry = process.argv.includes("--dry");
  const rerun = process.argv.includes("--rerun");
  const out = await requestMeetingReprocess(id, { dry, rerun });
  if (!out.ok) {
    console.error(`not reprocessed: ${out.reason}`);
    process.exitCode = 1;
    return;
  }
  if (out.mode === "past_30_days") {
    console.log(`${out.done ? "deleted" : "dry run: would delete"} the kept recording of ${id} (tenant ${out.tenant_id}); its 30 days are over, so no transcript is saved`);
    return;
  }
  if (out.mode === "save_transcript") {
    console.log(
      `${out.done ? "saved the transcript and deleted the recording for" : "dry run: would save the transcript from the kept recording, then delete it, for"} ${id} (tenant ${out.tenant_id}); nothing is sent`,
    );
    return;
  }
  console.log(
    `${out.queued ? "queued" : "dry run: would queue"} a reprocess of ${id} (tenant ${out.tenant_id}), reading the ${out.reads === "zavi" ? "transcript saved in Zavi" : "recording kept at Recall"}; the notes go where the team chose`,
  );
}

main().catch((e: unknown) => {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
});
