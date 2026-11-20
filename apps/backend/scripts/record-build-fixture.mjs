import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createScriptClient } from "./_supabase-script-client.mjs";

const FIXTURES = ["dog-grooming", "landing-page", "db-app"];
const REPLAY_STAGES = { spec: "pm", scaffold: "engineer", build: "engineer" };
const DOGFOOD_SLUGS = new Set(["upcar-ai", "upcar-private", "apna-tutor-dogfood"]);
const STRIP_PARSED_KEYS = [
  "commit_sha",
  "critic",
  "files",
  "push_to_main",
  "postdeploy_verify",
  "typecheck_verify",
  "repo",
  "head_branch",
  "pr_url",
  "pr_repo",
  "pr_number",
  "pr_head_branch",
];

const [conductorRunId, fixture] = process.argv.slice(2);
if (!conductorRunId || !FIXTURES.includes(fixture)) {
  console.error(`usage: node --env-file=.env scripts/record-build-fixture.mjs <conductor_run_id> <${FIXTURES.join("|")}>`);
  process.exit(1);
}

const sb = createScriptClient();

function fail(message) {
  console.error(`record-build-fixture: ${message}`);
  process.exit(1);
}

const { data: run, error: runErr } = await sb
  .from("conductor_runs")
  .select("id, tenant_id, status, goal_graph")
  .eq("id", conductorRunId)
  .maybeSingle();
if (runErr) fail(runErr.message);
if (!run) fail(`conductor run ${conductorRunId} not found`);

const { data: tenant, error: tenantErr } = await sb
  .from("tenants")
  .select("slug, kind")
  .eq("id", run.tenant_id)
  .maybeSingle();
if (tenantErr) fail(tenantErr.message);
if (!tenant || (tenant.kind !== "test" && !DOGFOOD_SLUGS.has(tenant.slug))) {
  fail(`tenant ${tenant?.slug ?? run.tenant_id} is a real customer; record only from test or dogfood tenants`);
}

const nodes = Array.isArray(run.goal_graph) ? run.goal_graph : run.goal_graph?.nodes;
if (!Array.isArray(nodes)) fail("goal_graph has no node list");

const stageNodes = nodes.filter((n) => REPLAY_STAGES[n?.payload?.stage]);
if (stageNodes.length === 0) fail("no spec, scaffold or build node in this run");

const outDir = path.join(process.cwd(), "dev-fixtures", "build-replay", fixture);
rmSync(outDir, { recursive: true, force: true });
const written = [];

for (const node of stageNodes) {
  const stage = node.payload.stage;
  const stack = node.payload.stack ?? (stage === "spec" ? "nextjs-supabase-tailwind" : undefined);
  if (typeof stack !== "string" || !/^[a-z0-9-]{1,64}$/.test(stack)) fail(`${stage} node has no stack`);
  if (node.status !== "done") fail(`${stage} node is ${node.status}, not done`);
  if ((node.repair_attempts ?? 0) > 0 || (node.site_repair_attempts ?? 0) > 0) {
    fail(`${stage} node was repaired, so its last run holds only the fix; pick a build that passed first time`);
  }
  if (!node.child_run_id) fail(`${stage} node has no child run`);

  const { data: child, error: childErr } = await sb
    .from("agent_runs")
    .select("id, agent_slug, status, output_text, parsed")
    .eq("id", node.child_run_id)
    .eq("tenant_id", run.tenant_id)
    .maybeSingle();
  if (childErr) fail(childErr.message);
  if (!child || child.status !== "success") fail(`${stage} run ${node.child_run_id} did not succeed`);
  if (child.agent_slug !== REPLAY_STAGES[stage]) fail(`${stage} run is ${child.agent_slug}, expected ${REPLAY_STAGES[stage]}`);

  let files = [];
  if (child.agent_slug === "engineer") {
    const { data: decisions, error: decErr } = await sb
      .from("decisions")
      .select("body, status")
      .eq("tenant_id", run.tenant_id)
      .eq("agent_run_id", child.id)
      .eq("decision_class", "engineer.ship-pr")
      .order("emitted_at", { ascending: false })
      .limit(1);
    if (decErr) fail(decErr.message);
    const body = decisions?.[0]?.body;
    if (!Array.isArray(body?.files) || body.files.length === 0) fail(`${stage} run ${child.id} has no shipped files`);
    files = body.files.map((f) => ({
      path: f.path,
      action: f.action,
      ...(typeof f.content === "string" ? { content: f.content } : {}),
      ...(f.encoding === "base64" ? { encoding: "base64" } : {}),
    }));
  }

  const parsed = child.parsed && typeof child.parsed === "object" ? { ...child.parsed } : child.parsed;
  if (parsed && typeof parsed === "object") for (const k of STRIP_PARSED_KEYS) delete parsed[k];

  const record = {
    agent: child.agent_slug,
    stage,
    stack,
    source_run_id: child.id,
    output_text: child.output_text ?? "",
    parsed,
    files,
  };
  const file = path.join(outDir, stack, `${stage}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  written.push(`${path.relative(process.cwd(), file)} (${files.length} files)`);
}

console.log(`recorded ${fixture} from ${tenant.slug} conductor run ${conductorRunId}:`);
for (const w of written) console.log(`  ${w}`);
