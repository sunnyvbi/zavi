
import { deleteKeptRecordings } from "@/services/meetings/recording-cleanup";

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  let host = "(unset)";
  try {
    host = new URL(process.env.SUPABASE_URL ?? "").host;
  } catch {
  }
  console.log(`database: ${host}`);
  const out = await deleteKeptRecordings({ dry, log: (line) => console.log(line) });
  process.exitCode = out.failed > 0 ? 1 : 0;
}

main().catch((e: unknown) => {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
});
