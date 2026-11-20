
import { createClient } from "@supabase/supabase-js";
import { decideRoutinePin, type RoutinePinRow } from "@/services/routines/routine-pin-backfill";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 && args[i + 1] ? Math.max(1, parseInt(args[i + 1], 10) || 0) : Infinity;
})();
const TENANT = (() => {
  const i = args.indexOf("--tenant");
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

const PAGE = 200;

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Run with `node --env-file=.env ...`",
    );
    process.exit(2);
  }
  const sb = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(
    `[pin-backfill] mode=${DRY_RUN ? "DRY-RUN" : "WRITE"} tenant=${TENANT ?? "all"} limit=${LIMIT === Infinity ? "none" : LIMIT}`,
  );

  let processed = 0;
  let pinned = 0;
  let alreadyPinned = 0;
  const leftNull: Array<{ id: string; tenant_id: string; agent_slug: string; emitted_tool_name: string | null }> = [];

  let cursor: string | null = null;
  for (;;) {
    if (processed >= LIMIT) break;
    let q = sb
      .from("tenant_routines")
      .select("id, tenant_id, agent_slug, status, emitted_tool_name, routine_spec, approved_spec_hash")
      .eq("status", "approved")
      .is("approved_spec_hash", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (TENANT) q = q.eq("tenant_id", TENANT);
    if (cursor) q = q.gt("id", cursor);

    const { data: rows, error } = await q;
    if (error) {
      console.error(`[pin-backfill] query failed: ${error.message}`);
      process.exit(1);
    }
    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      if (processed >= LIMIT) break;
      cursor = r.id as string;
      processed += 1;

      const decision = decideRoutinePin(r as RoutinePinRow);
      if (decision.action === "skip") {
        if (decision.reason === "already_pinned") alreadyPinned += 1;
        continue;
      }
      if (decision.action === "leave_null") {
        leftNull.push({
          id: r.id as string,
          tenant_id: r.tenant_id as string,
          agent_slug: r.agent_slug as string,
          emitted_tool_name: (r.emitted_tool_name as string | null) ?? null,
        });
        continue;
      }

      if (DRY_RUN) {
        pinned += 1;
        continue;
      }
      const { data: updated, error: upErr } = await sb
        .from("tenant_routines")
        .update({ approved_spec_hash: decision.hash })
        .eq("id", r.id)
        .eq("tenant_id", r.tenant_id)
        .eq("status", "approved")
        .is("approved_spec_hash", null)
        .select("id")
        .maybeSingle();
      if (upErr) {
        console.error(`[pin-backfill] update failed for ${r.id}: ${upErr.message}`);
        process.exit(1);
      }
      if (updated) pinned += 1;
      else alreadyPinned += 1;
    }

    if (rows.length < PAGE) break;
  }

  console.log(
    `[pin-backfill] done. processed=${processed} pinned=${pinned}${DRY_RUN ? " (planned)" : ""} already_pinned_or_raced=${alreadyPinned} left_null=${leftNull.length}`,
  );
  if (leftNull.length > 0) {
    console.log(
      `[pin-backfill] LEFT NULL (stored spec does not validate -> not runnable, not trusted as authoritative; reported, not pinned):`,
    );
    for (const row of leftNull) {
      console.log(
        `  - id=${row.id} tenant=${row.tenant_id} agent=${row.agent_slug} tool=${row.emitted_tool_name ?? "<null>"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error("[pin-backfill] fatal:", e);
  process.exit(1);
});
