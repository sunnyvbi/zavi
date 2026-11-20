
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteFn } from "../checks/model";
import type { EnrichmentComplete } from "@/services/onboarding/enrichment/text-model";

export const LOCAL_MODEL = "claude-haiku-5-5";
const OUTPUT_CAP_BYTES = 2_000_000;

export type RunCli = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;

export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ["HOME", "PATH", "USER", "LANG"]) if (env[k]) out[k] = env[k];
  return out;
}

export function cliArgs(model: string, system: string, user: string): string[] {
  return [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--tools", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt", system,
    user,
  ];
}

export function envelopeText(stdout: string): string {
  let env: { is_error?: unknown; result?: unknown; subtype?: unknown };
  try {
    env = JSON.parse(stdout.trim());
  } catch {
    throw new Error("claude_cli_bad_envelope");
  }
  if (env.is_error === true || typeof env.result !== "string") {
    throw new Error(`claude_cli_error:${String(env.subtype ?? "unknown").slice(0, 40)}`);
  }
  return env.result;
}

const defaultRunCli: RunCli = (args, { cwd, env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let size = 0;
    let settled = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
      }
    };
    const timer = setTimeout(() => {
      kill();
      if (!settled) {
        settled = true;
        reject(new Error("claude_cli_timeout"));
      }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > OUTPUT_CAP_BYTES) {
        kill();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("claude_cli_output_cap"));
        }
        return;
      }
      out += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve(out);
      else reject(new Error(`claude_cli_exit_${code}`));
    });
  });

export function claudeCli(opts: { model?: string; timeoutMs?: number; runCli?: RunCli } = {}) {
  const model = opts.model ?? LOCAL_MODEL;
  const runCli = opts.runCli ?? defaultRunCli;
  const call = async (system: string, user: string, timeoutMs: number): Promise<string> => {
    const cwd = await mkdtemp(join(tmpdir(), "seed-model-"));
    try {
      return envelopeText(await runCli(cliArgs(model, system, user), { cwd, env: cliEnv(), timeoutMs }));
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  };
  const complete: CompleteFn = (system, user) => call(system, user, opts.timeoutMs ?? 60_000);
  const enrichment: EnrichmentComplete = ({ system, user, timeoutMs }) => call(system, user, Math.max(timeoutMs, 60_000));
  return { model, complete, enrichment };
}
