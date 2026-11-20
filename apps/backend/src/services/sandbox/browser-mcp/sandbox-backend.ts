
import { getSandboxIdForRun } from "@/services/sandbox/lifecycle";
import { callDaemon } from "./daemon-client";
import type { BrowserBackend } from "./backend";
import type { BrowserToolCtx, DaemonOp, DaemonResult } from "./types";

const sandboxIdByRun = new Map<string, string>();

export function _resetSandboxIdCache(): void {
  sandboxIdByRun.clear();
}

export const sandboxBackend: BrowserBackend = {
  async runOp(ctx: BrowserToolCtx, op: DaemonOp): Promise<DaemonResult> {
    let sbId = sandboxIdByRun.get(ctx.run_id);
    if (!sbId) {
      const id = await getSandboxIdForRun(ctx.tenant_id, ctx.repo_full_name);
      if (!id) {
        throw new Error(
          `no active sandbox for tenant=${ctx.tenant_id} repo=${ctx.repo_full_name}. Did resolveSandboxForRun run?`,
        );
      }
      sbId = id;
      sandboxIdByRun.set(ctx.run_id, sbId);
    }
    return callDaemon(sbId, op);
  },
};
