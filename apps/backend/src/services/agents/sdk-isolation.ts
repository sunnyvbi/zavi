import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";

export const INHERITED_CLAUDE_SESSION_ENV: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_KIND",
  "CLAUDE_CODE_SESSION_NAME",
  "CLAUDE_CODE_SESSION_LOG",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_AGENT",
  "CLAUDE_CODE_PLUGIN_DIRS",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_JOB_DIR",
  "CLAUDE_CONFIG_DIR",
];

const INHERITED_CLAUDE_SESSION_ENV_PREFIXES: readonly string[] = ["CLAUDE_BG_"];

export const AGENT_SDK_ISOLATION_SETTINGS: Settings = {
  crossSessionInbound: "refuse",
  autoMemoryEnabled: false,
  disableRemoteControl: true,
  remoteControlAtStartup: false,
  autoUploadSessions: false,
};

let isolatedConfigDir: string | undefined;

export function agentSdkConfigDir(): string {
  if (isolatedConfigDir === undefined) {
    const dir = mkdtempSync(join(tmpdir(), `praxis-agent-sdk-${process.pid}-`));
    process.once("exit", () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        return;
      }
    });
    isolatedConfigDir = dir;
  }
  return isolatedConfigDir;
}

export function isolateAgentSdkEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of Object.keys(env)) {
    if (
      INHERITED_CLAUDE_SESSION_ENV.includes(key) ||
      INHERITED_CLAUDE_SESSION_ENV_PREFIXES.some((p) => key.startsWith(p))
    ) {
      delete env[key];
    }
  }
  env.CLAUDE_CONFIG_DIR = agentSdkConfigDir();
  return env;
}

export function withAgentSdkIsolation(options: Options): Options {
  return {
    ...options,
    env: isolateAgentSdkEnv(options.env ?? process.env),
    settingSources: [],
    strictMcpConfig: true,
    settings: AGENT_SDK_ISOLATION_SETTINGS,
  };
}
