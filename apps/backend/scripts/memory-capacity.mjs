
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const argv = process.argv.slice(2);
const numArg = (flag, def) => {
  const i = argv.indexOf(flag);
  return i !== -1 ? Number(argv[i + 1]) : def;
};
const days = numArg("--days", 7);
const NODE_HEADROOM_MB = numArg("--node-headroom", 600);
const includeUnknown = argv.includes("--include-unknown");
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const READ_LIMIT = 50000;

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  if (p <= 0) return s[0];
  if (p >= 100) return s[s.length - 1];
  return s[Math.min(Math.ceil((p / 100) * s.length), s.length) - 1];
}
const nums = (rows, key) =>
  rows.map((r) => r[key]).filter((v) => typeof v === "number");

async function main() {
  const { data, error } = await sb
    .from("runtime_memory_samples")
    .select(
      "sampled_at, container_role, cgroup_current_mb, cgroup_peak_mb, cgroup_max_mb, node_rss_mb, claude_proc_count, claude_rss_max_mb, claude_rss_sum_mb",
    )
    .gte("sampled_at", since)
    .order("sampled_at", { ascending: false })
    .limit(READ_LIMIT);

  if (error) {
    console.error("read failed:", error.message);
    process.exit(1);
  }
  if (data.length === READ_LIMIT) {
    console.warn(
      `⚠️  hit the ${READ_LIMIT}-row read cap — results cover only the most recent\n` +
        `   slice of the requested ${days}d window. Narrow with --days for an exact read.`,
    );
  }
  if (!data.length) {
    console.log(
      `No runtime_memory_samples in the last ${days}d.\n` +
        `Possible causes: (a) sampler not deployed yet; (b) box idle (no claude procs\n` +
        `→ window-peak insert-when-loaded writes nothing); (c) role!=canonical (run with\n` +
        `--include-unknown to check). If you KNOW agent runs were live in this window and\n` +
        `still see zero rows, the /proc 'claude' matcher may be broken — check the binary name.`,
    );
    return;
  }

  const rows = includeUnknown
    ? data
    : data.filter((r) => r.container_role === "canonical");
  if (!rows.length) {
    console.log(
      `0 canonical rows (${data.length} total, all non-canonical). Re-run with --include-unknown to inspect.`,
    );
    return;
  }
  const loaded = rows.filter((r) => (r.claude_proc_count ?? 0) > 0);

  const procRssMax = nums(loaded, "claude_rss_max_mb");
  const limitMb = Math.max(0, ...nums(rows, "cgroup_max_mb")) || null;
  const p95Proc = percentile(procRssMax, 95);
  const maxProc = percentile(procRssMax, 100);

  console.log(`\n=== runtime memory capacity — last ${days}d ===`);
  console.log(`samples: ${rows.length} canonical (loaded: ${loaded.length})  node_headroom=${NODE_HEADROOM_MB}MB`);
  console.log(
    `window: ${rows[rows.length - 1]?.sampled_at?.slice(0, 19)} → ${rows[0]?.sampled_at?.slice(0, 19)} UTC`,
  );

  console.log(`\n--- per-claude-proc RSS (MB), largest proc per window ---`);
  for (const p of [50, 90, 95, 99, 100]) console.log(`  p${p}: ${percentile(procRssMax, p) ?? "n/a"}`);

  console.log(`\n--- node backend RSS (MB) — informs node_headroom ---`);
  for (const p of [50, 95, 99, 100]) console.log(`  p${p}: ${percentile(nums(rows, "node_rss_mb"), p) ?? "n/a"}`);
  const node95 = percentile(nums(rows, "node_rss_mb"), 95);
  if (node95 !== null && node95 > NODE_HEADROOM_MB)
    console.log(`  ⚠️  observed node p95 (${node95}MB) EXCEEDS --node-headroom (${NODE_HEADROOM_MB}MB) — raise the headroom.`);

  console.log(`\n--- observed concurrency (claude_proc_count, loaded windows) ---`);
  for (const p of [50, 90, 95, 100]) console.log(`  p${p}: ${percentile(nums(loaded, "claude_proc_count"), p) ?? "n/a"}`);

  console.log(`\n--- container memory (MB) ---`);
  console.log(`  cgroup limit (cgroup_max): ${limitMb ?? "n/a"}`);
  console.log(`  cgroup peak observed:      ${Math.max(0, ...nums(rows, "cgroup_peak_mb"), ...nums(rows, "cgroup_current_mb")) || "n/a"}`);

  const marginals = loaded
    .map((r) =>
      typeof r.cgroup_current_mb === "number" && r.claude_proc_count > 0
        ? (r.cgroup_current_mb - NODE_HEADROOM_MB) / r.claude_proc_count
        : null,
    )
    .filter((v) => typeof v === "number" && v > 0);
  const p95Marginal = percentile(marginals, 95);

  console.log(`\n--- derived safe concurrency (MIN of two bounds) ---`);
  const bounds = [];
  if (limitMb && p95Proc) {
    const usable = limitMb - NODE_HEADROOM_MB;
    if (usable <= 0) {
      console.log(`  ⚠️  node_headroom (${NODE_HEADROOM_MB}) >= cgroup limit (${limitMb}) — headroom too high or box too small.`);
    } else {
      if (maxProc > usable)
        console.log(`  ⚠️  largest observed proc (${maxProc}MB) exceeds usable RAM (${usable}MB) — even 1 is tight.`);
      const perProc = Math.max(1, Math.floor(usable / p95Proc));
      console.log(`  [1] per-proc bound:        floor((${limitMb} - ${NODE_HEADROOM_MB}) / p95_proc ${p95Proc}) = ${perProc}`);
      bounds.push(perProc);
    }
  }
  if (limitMb && p95Marginal) {
    const containerBound = Math.max(1, Math.floor((limitMb - NODE_HEADROOM_MB) / p95Marginal));
    console.log(`  [2] container-pressure:    floor((${limitMb} - ${NODE_HEADROOM_MB}) / p95_marginal ${Math.round(p95Marginal)}) = ${containerBound}`);
    bounds.push(containerBound);
  }
  if (bounds.length) {
    console.log(`\n  → RECOMMENDED cap (min): ${Math.min(...bounds)}   (current RUN_AGENT_CONCURRENCY default: 8)`);
    console.log(`  If recommended > 8 with headroom, the box can take a higher cap; if <= 8, grow the box first.`);
  } else {
    console.log(`  insufficient data (need cgroup_max + loaded proc-RSS samples).`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
