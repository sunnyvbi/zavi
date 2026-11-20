
import * as e2b from "@/services/sandbox/e2b-client";

export const GATE_RUNNER_DIR = "/home/user/zavi-gate";
export const GATE_RUNNER_PATH = `${GATE_RUNNER_DIR}/runner.cjs`;
export const GATE_CONFIG_PATH = `${GATE_RUNNER_DIR}/config.json`;
const DEFAULT_TEMPLATE = "praxis-qa";
const DEFAULT_NODE_PATH = "/home/user/qa/node_modules";

export type GateRunnerExecInput = {
  tenant_id: string;
  site_id: string;
  files: Record<string, string>;
  command: string;
  env: Record<string, string>;
  redact: string[];
  timeoutMs: number;
};
export type GateRunnerExec = (input: GateRunnerExecInput) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type E2bGateRunnerDeps = {
  create: typeof e2b.createSandbox;
  write: typeof e2b.writeFile;
  exec: typeof e2b.execCommand;
  destroy: typeof e2b.destroySandbox;
};

export function createE2bGateRunner(overrides: Partial<E2bGateRunnerDeps> = {}): GateRunnerExec {
  const d: E2bGateRunnerDeps = {
    create: e2b.createSandbox,
    write: e2b.writeFile,
    exec: e2b.execCommand,
    destroy: e2b.destroySandbox,
    ...overrides,
  };
  return async (input) => {
    const id = await d.create({
      tenant_id: input.tenant_id,
      repo_full_name: `site-gate:${input.site_id}`,
      template: process.env.SITE_GATE_RUNNER_TEMPLATE?.trim() || DEFAULT_TEMPLATE,
    });
    try {
      for (const [path, content] of Object.entries(input.files)) await d.write(id, path, content);
      const env = { NODE_PATH: process.env.SITE_GATE_RUNNER_NODE_PATH?.trim() || DEFAULT_NODE_PATH, ...input.env };
      const r = await d.exec(id, input.command, input.timeoutMs, { env, redact: input.redact });
      return { exitCode: r.exit_code, stdout: r.stdout, stderr: r.stderr };
    } finally {
      await d.destroy(id).catch((e: unknown) => {
        console.warn(`[site-gate] runner sandbox destroy failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      });
    }
  };
}
