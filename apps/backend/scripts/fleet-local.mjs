
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mapClaudeJsonToDispatcherResult } from "./lib/envelope-mapper.mjs";

const API_BASE = (process.env.ZAVI_API_BASE || "").replace(/\/$/, "");
const TOKEN = process.env.ZAVI_MAC_WORKER_TOKEN;
if (!API_BASE || !TOKEN) fail("ZAVI_API_BASE + ZAVI_MAC_WORKER_TOKEN required");

function fail(msg) {
  process.stderr.write(`fleet-local: ${msg}\n`);
  process.exit(1);
}
function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function apiPost(pathSuffix, body) {
  const res = await fetch(`${API_BASE}/api/internal/local-runs${pathSuffix}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

async function cmdList() {
  const { ok, status, json } = await apiPost("/list", {});
  if (!ok) fail(`/list -> ${status} ${json?.error?.code ?? ""}`);
  out({ pending: json.pending ?? [] });
}

async function cmdClaim(tenantId, limitArg) {
  if (!tenantId) fail("claim <tenant_id> [limit]");
  const limit = limitArg ? Number(limitArg) : 10;
  const { ok, status, json } = await apiPost("/claim", { tenant_id: tenantId, limit });
  if (!ok) fail(`/claim -> ${status} ${json?.error?.code ?? ""}`);
  out({ claimed: json.claimed ?? [] });
}

async function cmdStart(id, triggerArg) {
  if (!id) fail("start <id> [trigger]");
  const body = triggerArg ? { trigger: triggerArg } : {};
  const { ok, status, json } = await apiPost(`/${id}/start`, body);
  if (!ok) fail(`/start -> ${status} ${json?.error?.code ?? ""}`);
  if (!json?.run_id) fail("/start returned no run_id");
  out({ run_id: json.run_id });
}

async function cmdRenew(id, leaseArg) {
  if (!id) fail("renew <id> [lease_seconds]");
  const body = leaseArg ? { lease_seconds: Number(leaseArg) } : {};
  const { ok, status, json } = await apiPost(`/${id}/renew`, body);
  if (status === 409 && json?.error?.code === "lease_lost") {
    out({ renewed: false });
    return;
  }
  if (!ok) fail(`/renew -> ${status} ${json?.error?.code ?? ""}`);
  out({ renewed: json.renewed === true });
}

async function cmdSecrets(id) {
  if (!id) fail("secrets <id>");
  const { ok, status, json } = await apiPost(`/${id}/secrets`, {});
  if (!ok) fail(`/secrets -> ${status} ${json?.error?.code ?? ""}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-${id.slice(0, 8)}-`));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "creds.json");
  fs.writeFileSync(file, JSON.stringify(json, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  out({
    tenant_id: json.tenant_id,
    agent_slug: json.agent_slug,
    creds_file: file,
    has_slack: !!json.slack_bot_token,
    has_github: !!json.github_token,
  });
}

async function cmdTerminal(runId, workItemId, status, outputFile, triggerArg) {
  if (!runId || !workItemId || !status || !outputFile) {
    fail("terminal <run_id> <work_item_id> <status> <output_file> [trigger]");
  }
  if (!["done", "failed"].includes(status)) fail(`invalid status ${status} (done|failed)`);

  let rawText;
  try {
    rawText = fs.readFileSync(outputFile, "utf8");
  } catch (e) {
    fail(`cannot read output_file ${outputFile}: ${e.message}`);
  }
  let cliJson;
  try {
    cliJson = JSON.parse(rawText);
  } catch {
    cliJson = { is_error: true, result: rawText };
  }

  let localPr;
  if (process.env.FLEET_LOCAL_PR) {
    try {
      localPr = JSON.parse(process.env.FLEET_LOCAL_PR);
    } catch {
      localPr = undefined;
    }
  }

  const result = mapClaudeJsonToDispatcherResult(cliJson, {
    status,
    promptSnapshot: process.env.FLEET_PROMPT_SNAPSHOT ?? "",
    localPr,
  });

  const body = { result, work_item_id: workItemId, status, trigger: triggerArg ?? "cron" };
  const { ok, status: code, json } = await apiPost(`/${runId}/terminal`, body);
  if (code === 409 || code === 410) {
    out({ completed: false });
    return;
  }
  if (code === 400) fail(`/terminal invalid_envelope (mapper bug): ${json?.error?.code ?? ""}`);
  if (!ok) fail(`/terminal -> ${code} ${json?.error?.code ?? ""}`);
  out({ run_id: json.run_id, status: json.status });
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "list": await cmdList(); break;
  case "claim": await cmdClaim(args[0], args[1]); break;
  case "start": await cmdStart(args[0], args[1]); break;
  case "renew": await cmdRenew(args[0], args[1]); break;
  case "secrets": await cmdSecrets(args[0]); break;
  case "terminal": await cmdTerminal(args[0], args[1], args[2], args[3], args[4]); break;
  default:
    fail(`unknown command "${cmd ?? ""}". Commands: list|claim|start|renew|secrets|terminal`);
}
