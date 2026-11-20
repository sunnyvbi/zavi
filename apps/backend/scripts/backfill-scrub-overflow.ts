
import { createClient } from "@supabase/supabase-js";
import {
  scrubAgentEgress,
  isPiiScrubAgent,
} from "../src/services/agents/scrub-agent-egress";

const APPLY = process.argv.includes("--apply");
const PAGE = 200;

type Row = {
  id: string;
  agent_run_id: string | null;
  meta: Record<string, unknown> | null;
};

function readOverflow(meta: Record<string, unknown>): { text: string; nested: boolean } | null {
  const top = meta.full_reply_markdown;
  if (typeof top === "string" && top.length > 0) return { text: top, nested: false };
  const env = meta.envelope;
  if (!env || typeof env !== "object") return null;
  const envMeta = (env as Record<string, unknown>).metadata;
  if (!envMeta || typeof envMeta !== "object") return null;
  const nested = (envMeta as Record<string, unknown>).full_reply_markdown;
  return typeof nested === "string" && nested.length > 0 ? { text: nested, nested: true } : null;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  console.log(APPLY ? "MODE: APPLY (writing)" : "MODE: DRY RUN (no writes) — pass --apply to write");

  let from = 0;
  let scanned = 0;
  let withOverflow = 0;
  let wouldChange = 0;
  let written = 0;
  const byAgent = new Map<string, number>();

  for (;;) {
    const { data, error } = await sb
      .from("agent_thread_messages")
      .select("id, agent_run_id, meta")
      .eq("sender_role", "assistant")
      .not("meta", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data as Row[]) {
      scanned += 1;
      const meta = row.meta;
      if (!meta || typeof meta !== "object") continue;
      const found = readOverflow(meta);
      if (!found) continue;
      withOverflow += 1;

      let slug = "unknown";
      if (row.agent_run_id) {
        const { data: run } = await sb
          .from("agent_runs")
          .select("agent_slug")
          .eq("id", row.agent_run_id)
          .maybeSingle();
        if (run?.agent_slug) slug = run.agent_slug as string;
      }
      byAgent.set(slug, (byAgent.get(slug) ?? 0) + 1);

      const scrubbed = scrubAgentEgress(found.text, {
        surface: "chat",
        agentSlug: slug,
        scrubPii: slug === "unknown" ? true : isPiiScrubAgent(slug),
      }).text;

      if (scrubbed !== found.text) wouldChange += 1;

      if (!APPLY) continue;

      const nextMeta: Record<string, unknown> = {
        ...meta,
        full_reply_markdown: scrubbed,
        overflow_scrubbed: true,
      };
      if (found.nested) {
        const env = { ...(meta.envelope as Record<string, unknown>) };
        const envMeta = { ...(env.metadata as Record<string, unknown>) };
        envMeta.full_reply_markdown = scrubbed;
        env.metadata = envMeta;
        nextMeta.envelope = env;
      }
      const { error: uerr } = await sb
        .from("agent_thread_messages")
        .update({ meta: nextMeta })
        .eq("id", row.id);
      if (uerr) throw uerr;
      written += 1;
    }

    from += PAGE;
    if (data.length < PAGE) break;
  }

  console.log("\n--- backfill-scrub-overflow ---");
  console.log(`assistant rows scanned : ${scanned}`);
  console.log(`rows carrying overflow : ${withOverflow}  (all get the scrub marker)`);
  console.log(`  ...of which PII/leak-scrubbed : ${wouldChange}`);
  console.log(`rows written           : ${APPLY ? written : 0}${APPLY ? "" : "  (dry run)"}`);
  console.log("\nrows-with-overflow by agent:");
  for (const [slug, n] of [...byAgent.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${slug.padEnd(24)} ${n}`);
  }
  if (!APPLY && wouldChange > 0) {
    console.log("\nRe-run with --apply to write. This is NOT reversible — review the counts above first.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
