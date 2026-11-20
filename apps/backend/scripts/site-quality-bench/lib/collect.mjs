import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { VIEWPORTS } from "./schema.mjs";

export const LIVE_ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

export const CONDUCTOR_COLUMNS =
  "id,tenant_id,status,kind,created_at,updated_at,first_draft_at,first_preview_at,first_content_at,failure_reason,failure_class";
export const ATTEMPT_COLUMNS = "id,agent_slug,status,enqueued_at,started_at,finished_at,cost_usd,error,parse_error,stage:payload->>stage";

export function missingLiveEnv(env = process.env) {
  return LIVE_ENV_KEYS.filter((k) => !env[k]);
}

export async function readRunFromDb(db, runId) {
  const { data: runs, error } = await db.from("conductor_runs").select(CONDUCTOR_COLUMNS).eq("id", runId).limit(1);
  if (error) throw new Error(`conductor_runs read failed: ${error.message}`);
  const run = runs?.[0];
  if (!run) throw new Error(`conductor run ${runId} not found`);
  const { data: attempts, error: aErr } = await db
    .from("agent_runs")
    .select(ATTEMPT_COLUMNS)
    .eq("tenant_id", run.tenant_id)
    .eq("payload->>build_conductor_run_id", run.id)
    .gte("enqueued_at", run.created_at)
    .order("enqueued_at", { ascending: true })
    .limit(200);
  if (aErr) throw new Error(`agent_runs read failed: ${aErr.message}`);
  return { run, attempts: attempts || [] };
}

function secondsBetween(from, to) {
  if (!from || !to) return null;
  const s = (new Date(to).getTime() - new Date(from).getTime()) / 1000;
  return Number.isFinite(s) && s >= 0 ? Math.round(s * 10) / 10 : null;
}

function clip(s, n = 200) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}

export function deriveRunMetrics(run, attempts) {
  const done = run.status === "done";
  const lastFinish = attempts
    .map((a) => a.finished_at)
    .filter(Boolean)
    .sort()
    .pop();
  const timings = {
    to_first_preview_s: secondsBetween(run.created_at, run.first_preview_at),
    to_usable_complete_s: done ? secondsBetween(run.created_at, lastFinish || run.updated_at) : null,
  };
  const costs = attempts.map((a) => (a.cost_usd == null ? null : Number(a.cost_usd))).filter((c) => Number.isFinite(c));
  const cost = costs.length
    ? { usd: Math.round(costs.reduce((a, b) => a + b, 0) * 10000) / 10000, source: `agent_runs.cost_usd sum over ${costs.length} attempts` }
    : { usd: null, source: "agent_runs.cost_usd: no attempt reported a cost" };
  const perStage = new Map();
  for (const a of attempts) {
    const stage = a.stage || a.agent_slug || "unknown";
    perStage.set(stage, (perStage.get(stage) || 0) + 1);
  }
  const repairs = attempts.length ? [...perStage.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0) : null;
  const failures = [];
  if (run.status === "failed" || run.status === "halted") {
    failures.push(`run ${run.status}: ${clip(run.failure_reason || run.failure_class || "no reason recorded")}`);
  }
  for (const a of attempts) {
    if (a.status === "failed") failures.push(`${a.stage || a.agent_slug || "stage"}: ${clip(a.error || a.parse_error || "failed")}`);
  }
  return { timings, cost, repairs, failures, run_status: run.status };
}

export async function loadPlaywright(modulePath) {
  const spec = modulePath || process.env.BENCH_PLAYWRIGHT_MODULE || "playwright-core";
  const mod = await import(spec);
  const pw = mod.chromium ? mod : mod.default;
  if (!pw?.chromium) throw new Error(`playwright module ${spec} has no chromium export`);
  return pw;
}

export function requirementCoverage(brief, text) {
  const hay = String(text || "").toLowerCase();
  return brief.requirements.map((req) => {
    if (!req.match || req.match.length === 0) {
      return { requirement: req.text, met: false, evidence: "unverified: no text signal, needs a human check" };
    }
    const hits = req.match.filter((m) => hay.includes(m.toLowerCase()));
    const met = req.match_all ? hits.length === req.match.length : hits.length > 0;
    const evidence = met
      ? `auto-text: found ${hits.map((h) => `"${h}"`).join(", ")}`
      : `auto-text: missing ${req.match.filter((m) => !hits.includes(m)).map((m) => `"${m}"`).join(", ")}`;
    return { requirement: req.text, met, evidence };
  });
}

async function checkJourney(page, journey, timeoutMs) {
  const re = new RegExp(journey.cta_pattern, "i");
  const candidates = page.locator("a:visible, button:visible");
  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const label = (await el.innerText().catch(() => "")).trim();
    if (!re.test(label)) continue;
    await el.click({ timeout: timeoutMs }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
    await page.waitForTimeout(300);
    const fields = await page
      .locator("input:visible:not([type=hidden]), textarea:visible, select:visible")
      .count()
      .catch(() => 0);
    return fields > 0
      ? { name: journey.name, passed: true, detail: `clicked "${clip(label, 60)}", ${fields} visible form fields` }
      : { name: journey.name, passed: false, detail: `clicked "${clip(label, 60)}", no visible form fields after` };
  }
  return { name: journey.name, passed: false, detail: `no visible link or button matching /${journey.cta_pattern}/i` };
}

export async function captureSite({ url, outDir, baseName, brief = null, playwrightModule = null, timeoutMs = 30000 }) {
  mkdirSync(outDir, { recursive: true });
  const pw = await loadPlaywright(playwrightModule);
  const browser = await pw.chromium.launch();
  const shots = {};
  let text = "";
  let journeys = [];
  try {
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, isMobile: vp === "mobile", hasTouch: vp === "mobile" });
      try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
        const file = join(outDir, `${baseName}-${vp}.png`);
        await page.screenshot({ path: file, fullPage: true, timeout: timeoutMs });
        shots[vp] = file;
        if (vp === "desktop") {
          text = `${await page.innerText("body").catch(() => "")}\n${await page.content()}`;
          if (brief?.core_journey) journeys = [await checkJourney(page, brief.core_journey, Math.min(timeoutMs, 5000))];
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return {
    screenshots: shots,
    journeys,
    requirement_coverage: brief ? requirementCoverage(brief, text) : [],
  };
}
