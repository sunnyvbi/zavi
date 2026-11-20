
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Classifier } from "./verifier";

const TIMEOUT_MS = 300_000;

function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("OPENAI_") || k.startsWith("CODEX_")) delete env[k];
  return env;
}

function run(cmd: string, args: string[], cwd: string, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd, env: cliEnv(), timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed (${err.killed ? "timeout" : `exit ${err.code}`}): ${String(stderr).slice(-600)}`));
      else resolve(stdout);
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

function serial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}
const gptQueue = serial();
const grokQueue = serial();

async function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const dir = mkdtempSync(join(tmpdir(), "growth-sim-verify-"));
    try {
      return await fn(dir);
    } catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`[verifier] try ${attempt} failed, retrying: ${(e as Error).message.slice(-300)}`);
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export const gptCli: Classifier = (prompt) =>
  gptQueue(() => inTemp(async (dir) => {
    const out = join(dir, "out.txt");
    await run("codex", ["exec", "-", "--skip-git-repo-check", "-s", "read-only", "-c", 'model_reasoning_effort="medium"', "-o", out], dir, prompt);
    return readFileSync(out, "utf8");
  }));

export const grokCli: Classifier = (prompt) =>
  grokQueue(() => inTemp(async (dir) => {
    const file = join(dir, "prompt.md");
    writeFileSync(file, prompt);
    return run("grok", ["--prompt-file", file, "--cwd", dir, "--output-format", "plain", "--no-plan", "--no-subagents", "--sandbox", "read-only"], dir);
  }));

export const checkerCli = async (system: string, user: string): Promise<string | null> => {
  try {
    const out = await gptCli(
      `${system}\n\nReply with ONLY a JSON object: {"verdicts":[{"id":"...","verdict":"confirmed|ruled_out|testing","quote":"...","why":"...","gain_plausible":true|false|null}]}\n\n${user}\n`,
    );
    const m = /\{[\s\S]*\}/.exec(out);
    return m ? m[0] : null;
  } catch (e) {
    console.warn(`[growth-sim] checker CLI failed: ${(e as Error).message.slice(-200)}`);
    return null;
  }
};
