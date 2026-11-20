
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execCommand, writeFile } from "@/services/sandbox/e2b-client";
import type { DaemonOp, DaemonResult } from "./types";

const DAEMON_PATH = "/home/user/browser-daemon.js";
const DAEMON_LOG = "/home/user/browser-daemon.log";
const DAEMON_PORT = 9223;
const DAEMON_BOOT_TIMEOUT_MS = 20_000;
const CALL_MAX_SEC = 60;

const daemonReady = new Set<string>();

let cachedDaemonSource: string | null = null;
function loadDaemonSource(): string {
  if (cachedDaemonSource !== null) return cachedDaemonSource;
  cachedDaemonSource = readFileSync(
    join(
      process.cwd(),
      "src",
      "services",
      "sandbox",
      "browser-mcp",
      "daemon.js",
    ),
    "utf8",
  );
  return cachedDaemonSource;
}

async function probeHealth(sandbox_id: string): Promise<boolean> {
  const r = await execCommand(
    sandbox_id,
    `curl -sf --max-time 2 http://127.0.0.1:${DAEMON_PORT}/health || true`,
  );
  if (!r.stdout) return false;
  try {
    const parsed = JSON.parse(r.stdout);
    return !!parsed.ok;
  } catch {
    return false;
  }
}

export async function ensureDaemonRunning(sandbox_id: string): Promise<void> {
  if (daemonReady.has(sandbox_id)) return;

  if (await probeHealth(sandbox_id)) {
    daemonReady.add(sandbox_id);
    return;
  }

  await writeFile(sandbox_id, DAEMON_PATH, loadDaemonSource());

  await execCommand(
    sandbox_id,
    `NODE_PATH=/home/user/qa/node_modules nohup node ${DAEMON_PATH} > ${DAEMON_LOG} 2>&1 & echo $!`,
  );

  const deadline = Date.now() + DAEMON_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeHealth(sandbox_id)) {
      daemonReady.add(sandbox_id);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const tail = await execCommand(
    sandbox_id,
    `tail -30 ${DAEMON_LOG} 2>/dev/null || true`,
  );
  throw new Error(
    `browser-daemon failed to boot in sandbox ${sandbox_id} within ${
      DAEMON_BOOT_TIMEOUT_MS / 1000
    }s. log tail:\n${tail.stdout || tail.stderr || "<empty>"}`,
  );
}

export async function callDaemon(
  sandbox_id: string,
  op: DaemonOp,
): Promise<DaemonResult> {
  let r = await postOp(sandbox_id, op);
  if (r === null) {
    daemonReady.delete(sandbox_id);
    await ensureDaemonRunning(sandbox_id);
    r = await postOp(sandbox_id, op);
  }
  if (r === null) {
    throw new Error(
      `browser-daemon empty response in sandbox ${sandbox_id} after retry`,
    );
  }
  return r;
}

async function postOp(
  sandbox_id: string,
  op: DaemonOp,
): Promise<DaemonResult | null> {
  await ensureDaemonRunning(sandbox_id);
  const body = JSON.stringify(op).replace(/'/g, "'\\''");
  const r = await execCommand(
    sandbox_id,
    `curl -sf --max-time ${CALL_MAX_SEC} -X POST -H 'content-type: application/json' -d '${body}' http://127.0.0.1:${DAEMON_PORT}/op`,
  );
  if (!r.stdout) return null;
  try {
    return JSON.parse(r.stdout) as DaemonResult;
  } catch (e) {
    throw new Error(
      `browser-daemon malformed JSON: ${r.stdout.slice(0, 200)}`,
    );
  }
}

export function _resetDaemonReadyCache(): void {
  daemonReady.clear();
}
