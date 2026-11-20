
import { pathToFileURL } from "node:url";
import { createScriptClient } from "./_supabase-script-client.mjs";

let sb = null;

const argv = process.argv.slice(2);
const noProbe = argv.includes("--no-probe");
const jsonOut = argv.includes("--json");
const stripAnsi = (s) => String(s == null ? "" : s).replace(/\x1b\[[0-9;]*m/g, "");
const tenantIdx = argv.indexOf("--tenant");
const tenantId = tenantIdx >= 0 ? argv[tenantIdx + 1] : null;
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--tenant");
const target = positional[0] || "latest";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const paint = (c, s) => `${C[c] || ""}${s}${C.reset}`;
const STAGE_ORDER = ["provision", "spec", "scaffold", "build", "qa", "deploy"];

const SEED_PLACEHOLDER_MARKERS = [
  "<title>Your Company</title>",
  "Your company app is live.",
  "This is a working Next.js starter.",
  'data-zavi-seed="placeholder"',
  "This site is being built.",
  "A starter to-do app. Extend it.",
  "Starter blog. Add posts.",
  "Starter view. Replace mocks with real data.",
];

async function probe(url) {
  if (!url || noProbe) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    let seed = false;
    if (String(r.status).startsWith("2")) {
      try {
        const body = (await r.text()).toLowerCase();
        seed = SEED_PLACEHOLDER_MARKERS.some((m) => body.includes(m.toLowerCase()));
      } catch {
      }
    }
    clearTimeout(t);
    return { status: r.status, seed };
  } catch {
    return { status: "ERR", seed: false };
  }
}

const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITE_SERVING = new Set(["live", "publishing"]);

export function siteIdOfRun(goalGraph) {
  if (!Array.isArray(goalGraph)) return null;
  for (const n of goalGraph) {
    const id = n?.payload?.site_id;
    if (typeof id === "string" && SITE_ID_RE.test(id)) return id.toLowerCase();
  }
  return null;
}

export function siteServingUrl(site) {
  if (!site || !SITE_SERVING.has(site.status) || !site.live_deploy_id) return null;
  if (typeof site.live_url === "string" && /^https:\/\//.test(site.live_url)) return site.live_url;
  return `https://${site.hostname}`;
}

export function liveTargetOf({ siteId, site, resources }) {
  if (siteId && site?.status !== "fell_back_old") {
    const url = siteServingUrl(site);
    return {
      hosting: { resource_kind: "site", status: site?.status ?? "missing", external_ref: url ? { url } : {} },
      liveUrl: url,
      ready: url !== null,
    };
  }
  const hosting = (resources || []).find((r) => r.resource_kind === "hosting");
  const domain = (resources || []).find((r) => r.resource_kind === "domain");
  const liveUrl =
    hosting?.external_ref?.url ||
    (domain?.external_ref?.hostname ? `https://${domain.external_ref.hostname}` : null);
  return { hosting, liveUrl, ready: hosting?.status === "ready" };
}

export async function describeBuild(run, deep = false, db = sb) {
  const graph = Array.isArray(run.goal_graph) ? run.goal_graph : [];
  const childIds = graph.map((n) => n.child_run_id).filter(Boolean);
  const childById = {};
  if (childIds.length) {
    const { data: kids } = await db
      .from("agent_runs")
      .select("id,agent_slug,status,error,parse_error,finished_at")
      .in("id", childIds);
    for (const k of kids || []) childById[k.id] = k;
  }
  const stages = graph.map((n) => {
    const stage = n.id.split("-").pop();
    const kid = n.child_run_id ? childById[n.child_run_id] : null;
    return {
      stage,
      node_status: n.status,
      child_status: kid?.status ?? null,
      error: kid?.error || kid?.parse_error || null,
      node_signal: n.last_failure_signal || null,
      screen_check: n.screen_check || null,
    };
  });

  const attempts = deep ? await loadAttempts(run, db) : [];
  const nodeByChild = new Map(graph.filter((n) => n.child_run_id).map((n) => [n.child_run_id, n.id.split("-").pop()]));
  const stageNames = new Set(stages.map((s) => s.stage));
  const stageOfAttempt = (a) => nodeByChild.get(a.id) ?? (stageNames.has(a.stage) ? a.stage : null);
  for (const s of stages) s.attempts = attempts.filter((a) => stageOfAttempt(a) === s.stage);
  const unplaced = attempts.filter((a) => stageOfAttempt(a) === null);
  for (const s of stages) {
    const node = graph.find((n) => n.id.split("-").pop() === s.stage);
    const nodeStage = node?.payload?.stage;
    if (nodeStage) s.attempts.push(...unplaced.filter((a) => a.stage === nodeStage && !s.attempts.includes(a)));
    s.attempts.sort((a, b) => String(a.enqueued_at).localeCompare(String(b.enqueued_at)));
  }

  const { data: resources } = await db
    .from("tenant_resources")
    .select("resource_kind,mode,status,external_ref")
    .eq("tenant_id", run.tenant_id);
  const siteId = siteIdOfRun(graph);
  const site = siteId
    ? (
        await db
          .from("sites")
          .select("id,tenant_id,hostname,status,live_url,live_deploy_id")
          .eq("id", siteId)
          .eq("tenant_id", run.tenant_id)
          .maybeSingle()
      ).data ?? null
    : null;
  const { hosting, liveUrl, ready } = liveTargetOf({ siteId, site, resources });
  const probeResult = await probe(liveUrl);
  const httpStatus = probeResult ? probeResult.status : null;
  const servesSeed = probeResult ? probeResult.seed : false;

  const firstStuck = stages.find(
    (s) => s.node_status === "dispatched" || s.node_status === "failed",
  );
  let verdict;
  if (run.status === "failed" || run.status === "halted") {
    const f = stages.find((s) => s.node_status === "failed") || firstStuck;
    const why = f?.error || f?.node_signal || run.failure_reason || null;
    const where = f?.stage ?? (run.failure_class ? `no stage (${run.failure_class})` : "?");
    const label = run.status === "halted" ? "HALTED" : "FAILED";
    verdict = paint("red", `❌ ${label} at ${where}${why ? ` — ${String(why).slice(0, 120)}` : ""}`);
  } else if (run.status === "done") {
    if (httpStatus && String(httpStatus).startsWith("2") && servesSeed) {
      verdict = paint("red", `❌ FALSE-LIVE — ${liveUrl} returns ${httpStatus} but serves the SEED PLACEHOLDER, not the built app (codegen never reached the repo)`);
    } else if (httpStatus && String(httpStatus).startsWith("2")) {
      verdict = paint("green", `✅ LIVE — ${liveUrl} (HTTP ${httpStatus})`);
    } else if (ready && liveUrl && httpStatus) {
      verdict = paint("yellow", `⚠️ deployed but NOT serving — ${liveUrl} (deploy ran; app returns ${httpStatus} at root)`);
    } else if (ready && liveUrl) {
      verdict = paint("green", `✅ built+deployed — ${liveUrl} (probe skipped)`);
    } else {
      verdict = paint(
        "yellow",
        `⚠️ pipeline DONE but NOT live — hosting=${hosting?.status ?? "none"} url=${liveUrl ?? "none"}${httpStatus ? ` probe=${httpStatus}` : ""} (deploy is the gap)`,
      );
    }
  } else if (firstStuck && liveAttempt(firstStuck)) {
    const a = liveAttempt(firstStuck);
    verdict = paint(
      "cyan",
      `▶ RUNNING at ${firstStuck.stage} — attempt ${firstStuck.attempts.indexOf(a) + 1} of ${firstStuck.attempts.length}, last activity ${fmtAge(a.idle_ms)} ago${a.activity ? ` (${a.activity.tool_calls} tool calls, ${a.activity.file_writes} file writes)` : ""}`,
    );
  } else if (firstStuck) {
    const ageMin = Math.round((Date.now() - new Date(run.updated_at).getTime()) / 60000);
    const why = firstStuck.error
      ? ` — ${firstStuck.error.slice(0, 120)}`
      : firstStuck.child_status
        ? ` (child=${firstStuck.child_status}; node still ${firstStuck.node_status} after ${ageMin}min — likely a held/needs_review or reconcile stall)`
        : ` (no child yet — dispatch stall, ${ageMin}min)`;
    verdict = paint("yellow", `⏳ STUCK at ${firstStuck.stage}${why}`);
  } else {
    verdict = paint("cyan", `… ${run.status} (no stuck/failed stage detected)`);
  }

  return { stages, resources: resources || [], site, liveUrl, httpStatus, hosting, verdict };
}

const LIVE_IDLE_MS = 3 * 60 * 1000;
const DEAD_IDLE_MS = 5 * 60 * 1000;

function fmtAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}min`;
}

function liveAttempt(stage) {
  return (stage.attempts || []).find((a) => a.status === "running" && a.idle_ms != null && a.idle_ms < LIVE_IDLE_MS) || null;
}

async function loadAttempts(run, db = sb) {
  const { data, error } = await db
    .from("agent_runs")
    .select(
      "id,agent_slug,status,worker_id,enqueued_at,started_at,finished_at,last_progress_at,error,parse_error,cost_usd,output_tokens,stage:payload->>stage",
    )
    .eq("tenant_id", run.tenant_id)
    .eq("payload->>build_conductor_run_id", run.id)
    .gte("enqueued_at", run.created_at)
    .order("enqueued_at", { ascending: false })
    .limit(60);
  if (error || !data) return [];
  data.reverse();
  const now = Date.now();
  const attempts = data.map((a) => {
    const start = a.started_at ? new Date(a.started_at).getTime() : null;
    const end = a.finished_at ? new Date(a.finished_at).getTime() : now;
    const lastSeen = a.last_progress_at || a.started_at || a.enqueued_at;
    return {
      ...a,
      duration_ms: start ? end - start : null,
      idle_ms: a.finished_at ? null : now - new Date(lastSeen).getTime(),
      activity: null,
      notes: [],
    };
  });
  for (const a of attempts.slice(-6)) {
    const { data: events } = await db
      .from("agent_run_events")
      .select("stage,meta,created_at")
      .eq("agent_run_id", a.id)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (!events?.length) continue;
    events.reverse();
    const capped = events.length >= 1000;
    const started = events.filter((e) => e.stage === "tool_use_started");
    const toolName = (e) => e.meta?.tool_name || "";
    a.activity = {
      tool_calls: started.length,
      file_writes: started.filter((e) => /__(create|str_replace|insert)$/.test(toolName(e))).length,
      shell_runs: started.filter((e) => /run_bash$/.test(toolName(e))).length,
      tool_errors: events.filter((e) => e.stage === "tool_use_errored").length,
      claims: events.filter((e) => e.stage === "claimed").length,
      last_tool: toolName(started[started.length - 1] || {}).replace(/^mcp__/, "") || null,
      capped,
    };
  }
  const workers = new Set(attempts.map((a) => a.worker_id).filter(Boolean));
  for (const a of attempts) {
    if (workers.size > 1 && /^canonical(:|$)/.test(a.worker_id || ""))
      a.notes.push("ran on the deployed worker (canonical), not this laptop: another machine on the same database took this step");
    if (/^resolve-repo-creds:/.test(a.error || ""))
      a.notes.push("that worker is missing a secret or GitHub access; nothing ran");
    if (a.status === "parse_failed" && (a.activity?.tool_calls ?? 0) === 0)
      a.notes.push("the model ended with no answer and no tool calls; the conductor re-dispatches the stage");
    else if (a.status === "parse_failed")
      a.notes.push("the agent worked, then ended without its final result block (often a backend restart mid-run)");
    if (a.status === "running" && a.idle_ms != null && a.idle_ms > DEAD_IDLE_MS)
      a.notes.push(`no activity for ${fmtAge(a.idle_ms)}: the worker that claimed it is probably gone`);
  }
  return attempts;
}

function fmtAttempt(a, i) {
  const color = a.status === "success" ? "green" : a.status === "running" ? "cyan" : a.status === "queued" ? "gray" : "red";
  const act = a.activity
    ? `  ${a.activity.capped ? "latest 1000 events: " : ""}${a.activity.tool_calls} tools / ${a.activity.file_writes} files / ${a.activity.shell_runs} shell${a.activity.tool_errors ? ` / ${a.activity.tool_errors} tool errors` : ""}`
    : "";
  const idle = a.idle_ms != null ? `  last activity ${fmtAge(a.idle_ms)} ago${a.activity?.last_tool ? ` (${a.activity.last_tool})` : ""}` : "";
  let out =
    `        ${paint("dim", `#${i + 1}`)} ${a.id.slice(0, 8)} ${paint(color, (a.status || "?").padEnd(14))}` +
    ` ${(a.worker_id || "unclaimed").padEnd(12)} ${(a.started_at || a.enqueued_at || "").slice(11, 19)}  ${fmtAge(a.duration_ms).padStart(6)}${act}${idle}`;
  const why = a.error || a.parse_error;
  if (why) out += `\n            ${paint("red", "↳ " + String(why).slice(0, 140))}`;
  for (const n of a.notes) out += `\n            ${paint("yellow", "• " + n)}`;
  return out;
}

function fmtStage(s, showAttempts = false) {
  const color =
    s.node_status === "done" ? "green" :
    s.node_status === "failed" ? "red" :
    s.node_status === "dispatched" ? "yellow" : "gray";
  let line = `    ${paint(color, s.stage.padEnd(10))} node:${(s.node_status || "?").padEnd(11)}`;
  if (s.child_status) line += ` child:${s.child_status}`;
  if (s.error) line += paint("red", `  ⚠ ${s.error.slice(0, 100)}`);
  if (!s.error && s.node_signal)
    line += paint("red", `  ⚠ ${String(s.node_signal).slice(0, 120)}`);
  if (s.screen_check) {
    const sc = s.screen_check;
    const c = sc.status === "pass" ? "green" : sc.status === "fail" ? "red" : "gray";
    const why = sc.status === "skipped" ? sc.reason : (sc.fails || [])[0];
    line += paint(c, `  screen:${sc.status}${why ? ` (${String(why).slice(0, 100)})` : ""}`);
  }
  if (showAttempts && s.attempts?.length) line += "\n" + s.attempts.map(fmtAttempt).join("\n");
  return line;
}

async function main() {
  let runs = [];
  if (target === "latest" || target === "all") {
    let q = sb
      .from("conductor_runs")
      .select("id,tenant_id,objective,status,goal_graph,kind,created_at,updated_at,failure_reason,failure_class")
      .eq("kind", "build_app")
      .order("updated_at", { ascending: false })
      .limit(target === "all" ? 20 : 5);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    runs = (await q).data || [];
  } else if (tenantId) {
    runs = (
      await sb
        .from("conductor_runs")
        .select("id,tenant_id,objective,status,goal_graph,kind,created_at,updated_at,failure_reason,failure_class")
        .eq("tenant_id", tenantId)
        .eq("kind", "build_app")
        .order("updated_at", { ascending: false })
        .limit(10)
    ).data || [];
  } else {
    let { data } = await sb
      .from("conductor_runs")
      .select("id,tenant_id,objective,status,goal_graph,kind,created_at,updated_at,failure_reason,failure_class")
      .eq("id", target)
      .limit(1);
    if (!data?.length) {
      const recent =
        (
          await sb
            .from("conductor_runs")
            .select("id,tenant_id,objective,status,goal_graph,kind,created_at,updated_at,failure_reason,failure_class")
            .order("updated_at", { ascending: false })
            .limit(200)
        ).data || [];
      data = recent.filter((r) => r.id.startsWith(target)).slice(0, 5);
    }
    runs = data || [];
  }

  if (!runs.length) {
    if (jsonOut) { console.log(JSON.stringify({ runs: [] })); return; }
    console.log(paint("red", `No build_app conductor_runs found for "${target}".`));
    return;
  }

  if (jsonOut) {
    const out = [];
    for (const run of runs) {
      const d = await describeBuild(run, runs.length === 1);
      const v = stripAnsi(d.verdict);
      let phase = "active";
      if (/✅ LIVE/.test(v)) phase = "live";
      else if (/FALSE-LIVE/.test(v)) phase = "false_live";
      else if (/❌ (FAILED|HALTED)/.test(v)) phase = "failed";
      else if (/STUCK/.test(v)) phase = "stuck";
      else if (/pipeline DONE but NOT live|not 2xx/.test(v)) phase = "deploy_gap";
      out.push({
        run_id: run.id,
        tenant_id: run.tenant_id,
        objective: (run.objective || "").slice(0, 120),
        status: run.status,
        updated_at: run.updated_at,
        phase,
        verdict: v,
        liveUrl: d.liveUrl || null,
        httpStatus: d.httpStatus || null,
        hosting_status: d.hosting?.status || null,
        site_id: d.site?.id || null,
        stages: (d.stages || []).map((s) => ({
          stage: s.stage,
          node: s.node_status,
          child: s.child_status || null,
          error: s.error || null,
          node_signal: s.node_signal || null,
          attempts: (s.attempts || []).map((a) => ({
            run_id: a.id,
            status: a.status,
            worker_id: a.worker_id || null,
            started_at: a.started_at || null,
            duration_ms: a.duration_ms,
            idle_ms: a.idle_ms,
            activity: a.activity,
            error: a.error || a.parse_error || null,
            notes: a.notes,
          })),
        })),
      });
    }
    console.log(JSON.stringify(out.length === 1 ? out[0] : out));
    return;
  }

  console.log(paint("bold", `\n━━ BUILD STATUS (${runs.length}) ${noProbe ? "[probe off]" : ""} ━━`));
  for (const run of runs) {
    const d = await describeBuild(run, runs.length === 1);
    console.log(
      `\n${paint("cyan", run.id.slice(0, 8))} ${paint("dim", run.id)}` +
        `\n  ${paint("bold", (run.objective || "").slice(0, 90))}` +
        `\n  status=${run.status}  tenant=${run.tenant_id.slice(0, 8)}  updated=${run.updated_at?.slice(0, 19).replace("T", " ")}`,
    );
    console.log(`  ${paint("bold", "VERDICT:")} ${d.verdict}`);
    console.log(paint("dim", "  stages:"));
    const ordered = [...d.stages].sort(
      (a, b) => (STAGE_ORDER.indexOf(a.stage) + 1 || 99) - (STAGE_ORDER.indexOf(b.stage) + 1 || 99),
    );
    for (const s of ordered) console.log(fmtStage(s, runs.length === 1));
    if (d.site) console.log(`    ${paint("dim", "site")}     ${(d.site.status || "?").padEnd(13)} ${paint("dim", d.liveUrl || d.site.hostname || "")}`);
    console.log(paint("dim", "  resources:"));
    for (const r of d.resources) {
      const rc = r.status === "ready" ? "green" : r.status === "failed" ? "red" : "yellow";
      const url = r.external_ref?.url || r.external_ref?.hostname || r.external_ref?.repo_url || "";
      const why = r.status === "failed" && r.external_ref?.error ? `  ${paint("red", "↳ " + r.external_ref.error)}` : "";
      console.log(`    ${r.resource_kind.padEnd(9)} ${paint(rc, (r.status || "?").padEnd(13))} ${paint("dim", url)}${why}`);
    }
  }
  console.log("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sb = createScriptClient();
  main().catch((e) => {
    console.error(paint("red", `build-status failed: ${e.message}`));
    process.exit(1);
  });
}
