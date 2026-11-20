
import { sanitizeSlackEventPayload } from "../src/services/redactor/slack-payload-sanitizer";
import { serviceClient } from "../src/services/supabase";

const PAGE_SIZE = parseInt(process.env.SLACK_BACKFILL_PAGE_SIZE ?? "500", 10);
const BATCH_SLEEP_MS = parseInt(process.env.SLACK_BACKFILL_SLEEP_MS ?? "100", 10);

type IngestedRow = {
  id: string;
  payload: Record<string, unknown> | null;
};

function parseArgs(): { before: string; dryRun: boolean } {
  let before = new Date().toISOString();
  let dryRun = false;
  for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--before") {
      const v = process.argv[i + 1];
      if (!v) throw new Error("--before requires a timestamp arg");
      const t = Date.parse(v);
      if (!Number.isFinite(t)) throw new Error(`--before value not parseable: ${v}`);
      before = new Date(t).toISOString();
      i += 1;
    }
  }
  return { before, dryRun };
}

async function main(): Promise<void> {
  const { before, dryRun } = parseArgs();
  // eslint-disable-next-line no-console
  console.log(
    `[backfill] start — before=${before} dry_run=${dryRun} page=${PAGE_SIZE} sleep=${BATCH_SLEEP_MS}ms`,
  );

  const sb = serviceClient();

  let totalScanned = 0;
  let totalUpdated = 0;
  let totalUnchanged = 0;
  let lastId: string | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = sb
      .from("ingested_events")
      .select("id, payload")
      .eq("provider", "slack")
      .lt("received_at", before)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (lastId) q = q.gt("id", lastId);

    const { data: rows, error } = await q;
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`[backfill] page read failed: ${error.message}`);
      process.exit(1);
    }
    const page = (rows as IngestedRow[] | null) ?? [];
    if (page.length === 0) break;

    for (const row of page) {
      totalScanned += 1;
      if (!row.payload) {
        totalUnchanged += 1;
        lastId = row.id;
        continue;
      }
      const beforePayload = row.payload;
      const after = sanitizeSlackEventPayload(beforePayload) as Record<string, unknown>;

      const beforeJson = JSON.stringify(beforePayload);
      const afterJson = JSON.stringify(after);
      if (beforeJson === afterJson) {
        totalUnchanged += 1;
        lastId = row.id;
        continue;
      }

      if (!dryRun) {
        const { error: updErr } = await sb.rpc("slack_ingested_payload_update", {
          p_id: row.id,
          p_payload: after,
        });
        if (updErr) {
          // eslint-disable-next-line no-console
          console.error(`[backfill] update failed for ${row.id}: ${updErr.message}`);
          process.exit(1);
        }
      }
      totalUpdated += 1;
      lastId = row.id;
    }

    if (page.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, BATCH_SLEEP_MS));
  }

  // eslint-disable-next-line no-console
  console.log(
    `[backfill] done — scanned=${totalScanned} updated=${totalUpdated} unchanged=${totalUnchanged} dry_run=${dryRun}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[backfill] verify with: select count(*) from ingested_events where provider='slack' and payload::text ~* '(@[a-z]+\\.[a-z]+|\\d{3}-?\\d{2}-?\\d{4})';`,
  );
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[backfill] fatal: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
