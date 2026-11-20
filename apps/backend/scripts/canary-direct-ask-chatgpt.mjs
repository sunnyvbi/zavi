#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const QA_EMAIL_FALLBACK = "rravi149+1@gmail.com";
const ASK = "Run a $25 ChatGPT ad for 1 day";
const MAX_USD = 25;
const CLASS = "chatgpt_ads.create_and_launch";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
if (!args.includes("--i-understand-real-money")) {
  console.error("Refusing: this canary creates a real ChatGPT campaign on upcar-ai and holds up to $25 until it is archived.\nRe-run with --i-understand-real-money once Ravi has approved THIS run.");
  process.exit(2);
}
const API = flag("--api", "https://api.zaviagent.com").replace(/\/$/, "");
const AGENT = flag("--agent", "operator");
const TIMEOUT_MS = Number(flag("--timeout-s", "900")) * 1000;
const HARD_CAP_MS = 30 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env(file) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const qa = env(join(homedir(), ".zavi", "prodqa.env"));
for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "QA_TEST_PASSWORD"]) if (!qa[k]) { console.error(`~/.zavi/prodqa.env is missing ${k}.`); process.exit(2); }

async function token() {
  const r = await fetch(`${qa.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: qa.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: qa.QA_TEST_EMAIL || QA_EMAIL_FALLBACK, password: qa.QA_TEST_PASSWORD }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`QA sign-in failed (HTTP ${r.status}).`);
  return j.access_token;
}
function claims(jwt) {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
function sql(query) {
  const out = execFileSync(join(homedir(), "bin", "zavi-prod-sql"), [`select coalesce(json_agg(t), '[]'::json) from (${query}) t`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const line = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("["));
  return line ? JSON.parse(line) : [];
}

async function api(tok, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
const campaignPath = (id) => (/^cmpn_/.test(id) ? `/api/channels/chatgpt_ads/campaigns/${encodeURIComponent(id)}` : `/api/ads/chatgpt/campaigns/${encodeURIComponent(id)}`);

const receipt = { ask: ASK, checks: {}, notes: [] };
const check = (name, ok, detail) => { receipt.checks[name] = { ok, detail }; };
let tok;
let campaignIds = new Set();
const started = new Date();

try {
  tok = await token();
  const c = claims(tok);
  const active = c.active_tenant_id ?? c.app_metadata?.active_tenant_id ?? c.tenant_id ?? null;
  if (active !== TENANT) throw new Error(`The QA token's active tenant is ${active ?? "unknown"}, not upcar-ai. Run the CLAUDE.md QA preflight, then try again. Nothing was sent.`);

  const open = sql(`select id from channel_actions where tenant_id = ${quote(TENANT)} and exec_class = ${quote(CLASS)} and exec_status in ('queued','dispatching') limit 1`);
  if (open.length) throw new Error(`A ChatGPT create (${open[0].id}) is already queued or launching on upcar-ai. Nothing was sent.`);

  const sent = await api(tok, "POST", `/api/agents/${encodeURIComponent(AGENT)}/chat`, { message: ASK });
  if (sent.status >= 300) throw new Error(`Chat send failed (HTTP ${sent.status}).`);
  const threadId = sent.body.thread_id;
  receipt.thread_id = threadId;
  if (!threadId) throw new Error("The chat API returned no thread id.");

  let action = null;
  const findBy = Date.now() + TIMEOUT_MS;
  const hardCap = started.getTime() + HARD_CAP_MS;
  while (Date.now() < (action ? hardCap : Math.min(findBy, hardCap))) {
    const roots = sql(`select id from agent_runs where tenant_id = ${quote(TENANT)} and trigger = 'chat' and payload->>'thread_id' = ${quote(threadId)} and enqueued_at >= ${quote(started.toISOString())} order by enqueued_at desc limit 1`);
    if (roots.length) {
      receipt.root_run_id = roots[0].id;
      const rows = sql(`select id, exec_status, status, exec_result, approval_envelope, exec_payload->'bundle'->'campaign' as campaign from channel_actions where tenant_id = ${quote(TENANT)} and exec_class = ${quote(CLASS)} and approval_envelope->>'envelope_id' = ${quote(`ask:${roots[0].id}`)} limit 2`);
      if (rows.length > 1) receipt.notes.push("MORE THAN ONE action carries this ask's envelope.");
      if (rows[0]) {
        action = rows[0];
        const er = action.exec_result ?? {};
        if (er.created?.id) campaignIds.add(er.created.id);
        for (const m of JSON.stringify(er).match(/cmpn_[A-Za-z0-9]+/g) ?? []) campaignIds.add(m);
        if (action.exec_status === "executed" || action.exec_status === "failed") break;
      }
    }
    await sleep(10_000);
  }
  const terminal = (x) => x && (x.exec_status === "executed" || x.exec_status === "failed");
  if (action && !terminal(action)) {
    receipt.notes.push(`HARD CAP: action ${action.id} did not end within 30 minutes (exec_status ${action.exec_status}).`);
    if (campaignIds.size === 0) {
      const r = await api(tok, "POST", `/api/channel-actions/${encodeURIComponent(action.id)}`, { action: "rejected", note: "canary hard cap: stopped before any campaign existed", request_id: `canary-reject:${action.id}` }).catch((e) => ({ status: 0, body: { error: e.message } }));
      const ok = r.status >= 200 && r.status < 300;
      check("hard_cap_rejected_action", ok, `HTTP ${r.status}`);
      if (ok) console.error(`\n!!! CANARY HARD CAP: action ${action.id} never made a campaign in 30 minutes; it was REJECTED so it cannot dispatch.\n`);
      else {
        console.error(`\n!!! CANARY: action ${action.id} could not be rejected (HTTP ${r.status}); it may be in flight. Watching it until it ends or makes a campaign (no time cap; Ctrl-C prints the action id).\n`);
        const loud = () => {
          console.error(`\n!!!!!! CANARY INTERRUPTED: action ${action.id} may still create a ChatGPT campaign (named with ${action.id}). Watch ChatGPT Ads and ARCHIVE it by hand. !!!!!!\n`);
          process.exit(130);
        };
        process.once("SIGINT", loud);
        let lastProgress = 0;
        while (!terminal(action) && campaignIds.size === 0) {
          await sleep(15_000);
          if (Date.now() - lastProgress >= 60_000) {
            lastProgress = Date.now();
            console.error(`[canary] ${new Date().toISOString()} action ${action.id} exec_status=${action.exec_status ?? "?"}, no campaign yet; still watching.`);
          }
          const [row] = sql(`select id, exec_status, status, exec_result, approval_envelope, exec_payload->'bundle'->'campaign' as campaign from channel_actions where tenant_id = ${quote(TENANT)} and id = ${quote(action.id)}`);
          if (row) action = row;
          const er = action.exec_result ?? {};
          if (er.created?.id) campaignIds.add(er.created.id);
          for (const m of JSON.stringify(er).match(/cmpn_[A-Za-z0-9]+/g) ?? []) campaignIds.add(m);
          for (const bnd of sql(`select provider_campaign_id from ads_campaign_bindings where tenant_id = ${quote(TENANT)} and created_at >= ${quote(started.toISOString())}`)) {
            if (campaignIds.has(bnd.provider_campaign_id)) continue;
            const sm = await api(tok, "GET", `${campaignPath(bnd.provider_campaign_id)}/launch`).catch(() => null);
            if (sm?.status === 200 && String(sm.body?.campaign?.name ?? "").includes(action.id)) campaignIds.add(bnd.provider_campaign_id);
          }
        }
        process.removeListener("SIGINT", loud);
      }
    }
  }
  if (!action && receipt.root_run_id) {
    const returned = sql(`select c->'returned_ids' as ids from agent_runs, jsonb_array_elements(tool_calls::jsonb) c where tenant_id = ${quote(TENANT)} and parent_run_id = ${quote(receipt.root_run_id)} and c->>'name' like '%chatgpt_ads__propose_new_campaign' and c->>'status' = 'ok'`);
    for (const id of returned.flatMap((r) => r.ids ?? [])) {
      const [old] = sql(`select id, status, exec_status, proposed_at, approval_envelope->>'envelope_id' as envelope from channel_actions where tenant_id = ${quote(TENANT)} and id = ${quote(id)}`);
      if (old) receipt.notes.push(`The ask's proposal came back as an OLDER card ${old.id} (proposed ${old.proposed_at}, ${old.status}/${old.exec_status ?? "not run"}, envelope ${old.envelope ?? "none"}): the duplicate check kept it instead of filing a new one.`);
    }
  }
  receipt.action = action ? { id: action.id, exec_status: action.exec_status, status: action.status, code: action.exec_result?.code ?? null } : null;
  check("filed_and_approved_by_ask", !!action && action.exec_status != null, action ? `action ${action.id}, exec_status ${action.exec_status}` : "no channel_action carries this ask's envelope");
  if (action?.campaign) {
    const plan = action.campaign;
    check("filed_cap_is_ask", plan.lifetime_budget_micros === MAX_USD * 1e6 && plan.daily_budget_micros == null, `lifetime ${plan.lifetime_budget_micros}, daily ${plan.daily_budget_micros ?? "none"}`);
    check("filed_flight_24h", plan.end_time - plan.start_time === 86_400, `end - start = ${plan.end_time - plan.start_time}s`);
  }
  check("executed", action?.exec_status === "executed", action?.exec_result?.notice ?? action?.exec_result?.error ?? "not settled in time");

  if (action) {
    for (const b of sql(`select provider_campaign_id from ads_campaign_bindings where tenant_id = ${quote(TENANT)} and created_at >= ${quote(started.toISOString())}`)) {
      if (campaignIds.has(b.provider_campaign_id)) continue;
      const s = await api(tok, "GET", `${campaignPath(b.provider_campaign_id)}/launch`).catch(() => null);
      if (s?.status === 200 && String(s.body?.campaign?.name ?? "").includes(action.id)) campaignIds.add(b.provider_campaign_id);
    }
  }
  if (campaignIds.size > 1) receipt.notes.push(`MORE THAN ONE campaign was made: ${[...campaignIds].join(", ")}`);

  for (const id of campaignIds) {
    const s = await api(tok, "GET", `${campaignPath(id)}/launch`);
    if (s.status !== 200) { check(`readback_${id}`, false, `launch summary HTTP ${s.status}`); continue; }
    const sum = s.body;
    const camp = sum.campaign ?? {};
    check(`readback_cap_${id}`, camp.lifetime_budget_micros === MAX_USD * 1e6, `lifetime ${camp.lifetime_budget_micros}`);
    check(`readback_flight_${id}`, camp.end_time - camp.start_time === 86_400, `end - start = ${camp.end_time - camp.start_time}s`);
    const review = (sum.ads ?? []).map((a) => `${a.status}/${a.review_status ?? "?"}`).join(", ");
    check(`readback_active_${id}`, sum.state === "launched", `state ${sum.state}, campaign ${camp.status}, ads ${review}`);
  }

  const replies = sql(`select body, created_at from agent_thread_messages where tenant_id = ${quote(TENANT)} and thread_id = ${quote(threadId)} and sender_role = 'assistant' and meta->>'channel_action_id' = ${quote(action?.id ?? "")} order by created_at`);
  check("one_founder_outcome_line", replies.length === 1, replies.map((r) => r.body).join(" | ") || "none");
} catch (e) {
  receipt.error = e.message;
} finally {
  for (const id of campaignIds) {
    try {
      tok ??= await token();
      const r = await api(tok, "POST", campaignPath(id), { status: "archived" });
      check(`archived_${id}`, r.status === 200 && r.body?.campaign?.status === "archived", `HTTP ${r.status}`);
    } catch (e) {
      check(`archived_${id}`, false, `ARCHIVE FAILED: ${e.message}. Archive ${id} by hand in ChatGPT Ads now.`);
    }
  }
  for (const id of campaignIds) {
    try {
      receipt[`hold_${id}`] = sql(`select status, amount_usd, released_usd from ad_budget_reservations where tenant_id = ${quote(TENANT)} and object_id = ${quote(id)}`);
      receipt[`funding_${id}`] = sql(`select f.reserved_cents, f.spent_cents from ads_campaign_funding f where f.campaign_id = ${quote(id)}`);
    } catch (e) {
      receipt.notes.push(`hold/spend read failed for ${id}: ${e.message}`);
    }
  }
  const failed = Object.entries(receipt.checks).filter(([, v]) => !v.ok).map(([k]) => k);
  receipt.verdict = !receipt.error && failed.length === 0 && campaignIds.size <= 1 ? "PASS" : "FAIL";
  receipt.failed = failed;
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(receipt.verdict === "PASS" ? 0 : 1);
}
