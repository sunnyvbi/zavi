import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const state = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    state.calls.push(options);
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0 };
    })();
  },
}));
vi.mock("@/services/agents/generic-dispatcher", () => ({
  resolveClaudeBinary: () => undefined,
  buildSystemPromptForTest: () => "sys",
}));

import {
  AGENT_SDK_ISOLATION_SETTINGS,
  INHERITED_CLAUDE_SESSION_ENV,
  agentSdkConfigDir,
  isolateAgentSdkEnv,
} from "../sdk-isolation";
import { claudeOneShot } from "@/services/llm/claude-oneshot";
import { cgoQueryOptions } from "@/services/eval/growth-sim/cgo-model";
import { driveResearchRun } from "@/services/eval/research-quality/driver";
import { driveEngineerRun } from "@/services/eval/engineer-quality/driver";
import { FIXTURE_REPO_PATH } from "@/services/eval/engineer-quality/task-loader";

const BACKEND = resolve(__dirname, "../../../..");
const DEV_CLAUDE_DIR = join(homedir(), ".claude");

const PARENT_SESSION_ENV: Record<string, string> = {
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_SESSION_ID: "dev-session-7d",
  CLAUDE_CODE_SESSION_KIND: "bg",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_HOST_SESSION_ID: "dev-host",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks-501/4242.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "peer-token",
  CLAUDE_BG_RENDEZVOUS_SOCK: "/tmp/bg.sock",
  CLAUDE_CONFIG_DIR: DEV_CLAUDE_DIR,
};

let saved: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  state.calls.length = 0;
  saved = {};
  setEnv(PARENT_SESSION_ENV);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function expectIsolated(options: Record<string, unknown>) {
  const env = options.env as Record<string, string | undefined>;
  expect(env).toBeDefined();
  for (const key of Object.keys(PARENT_SESSION_ENV).filter((k) => k !== "CLAUDE_CONFIG_DIR")) {
    expect(env[key], key).toBeUndefined();
  }
  const dir = env.CLAUDE_CONFIG_DIR as string;
  expect(dir).toBe(agentSdkConfigDir());
  expect(realpathSync(dir).startsWith(realpathSync(tmpdir()))).toBe(true);
  expect(resolve(dir).startsWith(DEV_CLAUDE_DIR)).toBe(false);
  expect(options.settingSources).toEqual([]);
  expect(options.strictMcpConfig).toBe(true);
  expect(options.settings).toMatchObject({ crossSessionInbound: "refuse", autoMemoryEnabled: false });
}

describe("agent SDK config dir", () => {
  it("is a fresh private dir under the OS temp dir, never the developer's ~/.claude, stable within the process", () => {
    const dir = agentSdkConfigDir();
    expect(agentSdkConfigDir()).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(dir).toContain(`praxis-agent-sdk-${process.pid}-`);
    expect(realpathSync(dir).startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(resolve(dir).startsWith(DEV_CLAUDE_DIR)).toBe(false);
    expect(readdirSync(dir).filter((f) => f === "CLAUDE.md" || f === "settings.json" || f === "sessions")).toEqual([]);
  });

  it("differs between two backend processes", () => {
    const probe = `import(${JSON.stringify(join(BACKEND, "src/services/agents/sdk-isolation.ts"))}).then((m) => process.stdout.write((m.agentSdkConfigDir ?? m.default.agentSdkConfigDir)()))`;
    const run = () =>
      execFileSync(process.execPath, ["--import", "tsx", "-e", probe], {
        cwd: BACKEND,
        env: { ...process.env },
        encoding: "utf8",
      }).trim();
    const a = run();
    const b = run();
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
    expect(a).not.toBe(agentSdkConfigDir());
    expect(resolve(a).startsWith(DEV_CLAUDE_DIR)).toBe(false);
    expect(existsSync(a)).toBe(false);
  });
});

describe("isolateAgentSdkEnv", () => {
  it("drops every inherited Claude Code session variable, overrides CLAUDE_CONFIG_DIR, keeps auth and PATH", () => {
    const env = isolateAgentSdkEnv({
      ...PARENT_SESSION_ENV,
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "seat-1",
      ANTHROPIC_API_KEY: "key",
      ENABLE_PROMPT_CACHING_1H: "1",
    });
    for (const key of INHERITED_CLAUDE_SESSION_ENV.filter((k) => k !== "CLAUDE_CONFIG_DIR")) {
      expect(env[key], key).toBeUndefined();
    }
    expect(env.CLAUDE_BG_RENDEZVOUS_SOCK).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe(agentSdkConfigDir());
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("seat-1");
    expect(env.ANTHROPIC_API_KEY).toBe("key");
    expect(env.ENABLE_PROMPT_CACHING_1H).toBe("1");
  });

  it("refuses inbound cross-session messages via documented settings", () => {
    expect(AGENT_SDK_ISOLATION_SETTINGS.crossSessionInbound).toBe("refuse");
  });
});

describe("every backend query() call site launches an isolated session", () => {
  it("claudeOneShot", async () => {
    setEnv({ ANTHROPIC_API_KEY: "key" });
    await claudeOneShot({ model: "m", system: "s", user: "u", timeoutMs: 5_000 });
    expect(state.calls).toHaveLength(1);
    expectIsolated(state.calls[0]);
    expect((state.calls[0].env as Record<string, string>).ANTHROPIC_API_KEY).toBe("key");
  });

  it("growth-sim cgo options", () => {
    const options = cgoQueryOptions("sys", "tok", () => {}) as Record<string, unknown>;
    expectIsolated(options);
    expect((options.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });

  it("research-quality driver", async () => {
    await driveResearchRun({ task_id: "rq-iso", ask: "a" } as Parameters<typeof driveResearchRun>[0]);
    expect(state.calls).toHaveLength(1);
    expectIsolated(state.calls[0]);
  });

  it("engineer-quality driver", async () => {
    await driveEngineerRun(
      FIXTURE_REPO_PATH,
      {
        task_id: "eq-iso",
        agent_slug: "engineer",
        bucket: "bug-fix",
        source: "synthetic",
        prompt: "fix it",
        fixture_file: "src/clamp.mjs",
        test_file: "test/clamp.test.mjs",
        pass_check: "true",
        expected_touch: ["x.txt"],
        known_good_reference: "x",
      } as Parameters<typeof driveEngineerRun>[1],
      { maxRetries: 0, backoffMs: 0 },
    );
    expect(state.calls.length).toBeGreaterThan(0);
    for (const call of state.calls) expectIsolated(call);
  });

  it("no query() call in backend source builds its options without the isolation helper", () => {
    const roots = ["src", "workers", "scripts"].map((r) => join(BACKEND, r));
    const offenders: string[] = [];
    const scanned: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === "node_modules" || name === "__tests__") continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|mts)$/.test(name)) {
          const src = readFileSync(p, "utf8");
          const importsQuery =
            /import\s*\{[^}]*\bquery\b[^}]*\}\s*from\s*"@anthropic-ai\/claude-agent-sdk"/.test(src) ||
            /\{[^}]*\bquery\b[^}]*\}\s*=\s*(await import\("@anthropic-ai\/claude-agent-sdk"\)|sdk)/.test(src);
          if (!importsQuery) continue;
          scanned.push(p.slice(BACKEND.length + 1));
          const re = /^(?!\s*\/\/).*\bquery\(\{/gm;
          let m: RegExpExecArray | null;
          while ((m = re.exec(src))) {
            const rest = src.slice(m.index);
            const opt = /\n\s*options:\s*([^\n]*)/.exec(rest);
            const helper = /^([A-Za-z_$][\w$]*)\(/.exec(opt?.[1] ?? "")?.[1];
            const ok =
              helper === "withAgentSdkIsolation" ||
              (helper !== undefined &&
                new RegExp(`function ${helper}\\([\\s\\S]*?return withAgentSdkIsolation\\(`).test(src));
            if (!ok) offenders.push(`${p.slice(BACKEND.length + 1)}@${src.slice(0, m.index).split("\n").length}`);
          }
        }
      }
    };
    roots.forEach(walk);
    expect(scanned).toEqual(
      expect.arrayContaining([
        "src/services/agents/generic-dispatcher.ts",
        "src/services/agents/engine/anthropic-engine.ts",
        "src/services/llm/claude-oneshot.ts",
        "src/services/eval/growth-sim/cgo-model.ts",
      ]),
    );
    expect(offenders).toEqual([]);
  });
});
