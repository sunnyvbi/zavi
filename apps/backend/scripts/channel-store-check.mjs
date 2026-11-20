
import { createScriptClient } from "./_supabase-script-client.mjs";

const sb = createScriptClient();

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const paint = (c, s) => `${C[c] || ""}${s}${C.reset}`;

async function count(table, filters = (q) => q) {
  const { count: n, error } = await filters(
    sb.from(table).select("*", { count: "exact" }).limit(1),
  );
  if (error) return { ok: false, label: `not present (${error.code || error.message || "?"})` };
  if (typeof n !== "number") return { ok: false, label: "could not check (no count returned)" };
  return { ok: true, label: String(n), n };
}

function printRow(name, r) {
  console.log(`  ${name.padEnd(28)} ${r.ok ? paint("green", r.label) : paint("yellow", r.label)}`);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log(paint("bold", "\n━━ CHANNEL STORE CHECK (decisions → channel_actions cutover) ━━\n"));

  console.log(paint("bold", "STORE TOTALS"));

  const actionsTotal = await count("channel_actions");
  printRow("channel_actions (total)", actionsTotal);

  const actionStatuses = ["pending", "acted", "rejected", "snoozed", "redone", "stale"];
  if (actionsTotal.ok) {
    for (const s of actionStatuses) {
      const r = await count("channel_actions", (q) => q.eq("status", s));
      printRow(`  status=${s}`, r);
    }
  }

  const events = await count("channel_action_events");
  printRow("channel_action_events", events);

  const metrics = await count("channel_metrics");
  printRow("channel_metrics", metrics);

  const settings = await count("channel_settings");
  printRow("channel_settings", settings);

  console.log("");
  const decisionsChannelTotal = await count("decisions", (q) => q.like("decision_class", "channel.%"));
  printRow("decisions channel.* (total)", decisionsChannelTotal);
  const decisionStatuses = ["proposed", "approved", "rejected", "acted", "archived"];
  if (decisionsChannelTotal.ok) {
    for (const s of decisionStatuses) {
      const r = await count("decisions", (q) => q.like("decision_class", "channel.%").eq("status", s));
      printRow(`  status=${s}`, r);
    }
  }

  console.log(paint("bold", "\nPOSITIVE CONTROL"));
  const agentRuns = await count("agent_runs");
  printRow("agent_runs (total)", agentRuns);
  if (!agentRuns.ok || agentRuns.n === 0) {
    console.log(
      paint(
        "red",
        "\n  CREDENTIALS OR SCOPE ARE WRONG — agent_runs came back empty or errored.\n" +
          "  EVERY ZERO ABOVE IS MEANINGLESS. An empty result is the shape that looks\n" +
          "  like proof and usually is not. Fix SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY\n" +
          "  and re-run before trusting anything else this script printed.",
      ),
    );
    process.exitCode = 1;
    return;
  }

  console.log(paint("bold", "\nSPLIT CHECK — proposals stranded in the old store\n"));

  let liveSince = null;
  if (actionsTotal.ok && actionsTotal.n > 0) {
    const { data: firstRow, error: firstErr } = await sb
      .from("channel_actions")
      .select("proposed_at")
      .order("proposed_at", { ascending: true })
      .limit(1);
    if (firstErr || !firstRow?.length) {
      console.log(paint("yellow", "  could not read when the new store went live"));
      console.log(paint("bold", "\nVERDICT: COULD NOT CHECK — split status unknown.\n"));
      process.exitCode = 1;
      return;
    }
    liveSince = firstRow[0].proposed_at;
    console.log(paint("dim", `  new store live since ${String(liveSince).slice(0, 19).replace("T", " ")}\n`));
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentRuns, error: runsErr } = await sb
    .from("agent_runs")
    .select("id,channel_slug,started_at")
    .not("channel_slug", "is", null)
    .gte("started_at", sevenDaysAgo);

  if (runsErr) {
    console.log(paint("yellow", `  could not read agent_runs for the split check: ${runsErr.message}`));
    console.log(paint("bold", "\nVERDICT: COULD NOT CHECK — split status unknown (agent_runs read failed).\n"));
    process.exitCode = 1;
    return;
  }

  const runsById = new Map((recentRuns || []).map((r) => [r.id, r]));
  const runIds = [...runsById.keys()];

  let proposedByRunId = new Map();
  if (runIds.length) {
    for (const idChunk of chunk(runIds, 200)) {
      const { data: decisionRows, error: decErr } = await sb
        .from("decisions")
        .select("agent_run_id")
        .eq("status", "proposed")
        .in("agent_run_id", idChunk);
      if (decErr) {
        console.log(paint("yellow", `  could not read decisions for a chunk of run ids: ${decErr.message}`));
        console.log(paint("bold", "\nVERDICT: COULD NOT CHECK — split status unknown (decisions read failed).\n"));
        process.exitCode = 1;
        return;
      }
      for (const row of decisionRows || []) {
        proposedByRunId.set(row.agent_run_id, (proposedByRunId.get(row.agent_run_id) || 0) + 1);
      }
    }
  }

  const stamped = [...proposedByRunId.entries()]
    .map(([runId, n]) => ({ run: runsById.get(runId), n }))
    .filter((s) => s.run);

  const splits = liveSince ? stamped.filter((s) => (s.run.started_at || "") >= liveSince) : [];
  const preSwitch = stamped.length - splits.length;
  const preSwitchProposals = stamped
    .filter((s) => !splits.includes(s))
    .reduce((sum, s) => sum + s.n, 0);

  if (preSwitch > 0) {
    console.log(
      paint(
        "dim",
        `  ${preSwitch} stamped run(s) in the last 7 days hold ${preSwitchProposals} open proposal(s) in the OLD store.\n` +
          "  That is pre-switch work, not a split — the wave migrations archive it on deploy.\n",
      ),
    );
  }

  if (!splits.length) {
    console.log(paint("dim", liveSince ? "  (no splits found)" : "  (nothing can be a split until the new store is live)"));
  } else {
    for (const s of splits) {
      console.log(
        `  ${paint("cyan", s.run.id.slice(0, 8))}  channel=${s.run.channel_slug.padEnd(20)} ` +
          `started=${(s.run.started_at || "").slice(0, 19).replace("T", " ")}  proposed=${s.n}`,
      );
    }
  }

  console.log(paint("bold", "\nVERDICT"));
  if (!actionsTotal.ok || actionsTotal.n === 0) {
    console.log(
      paint(
        "yellow",
        "  NEW STORE NEVER WRITTEN — the deployed backend predates the switch.\n" +
          "  Zero splits is expected and proves nothing yet.",
      ),
    );
  } else if (!splits.length) {
    console.log(paint("green", `  CLEAN — ${actionsTotal.n} rows in the new store, 0 splits.`));
  } else {
    console.log(
      paint(
        "red",
        `  SPLITS FOUND — ${splits.length} run(s) proposed work into the old store on a\n` +
          "  switched channel. Those proposals are invisible on the channel page.",
      ),
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(paint("red", `channel-store-check failed: ${e.message}`));
  process.exit(1);
});
