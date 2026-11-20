
import { execCommand } from "@/services/sandbox/e2b-client";
import { reapOrphanWorktrees } from "@/services/sandbox/run-worktree";
import { logEvent } from "@/services/logging/logEvent";

const REPO_ROOT = "/home/user/repo";

const MIN_FREE_KB_FLOOR = 2 * 1024 * 1024;

const TREE_MARGIN_KB = 512 * 1024;

const PROBE_TIMEOUT_MS = 30_000;
const GC_TIMEOUT_MS = 120_000;

export function requiredFreeKb(measuredTreeKb: number | null | undefined): number {
  if (measuredTreeKb == null || !Number.isFinite(measuredTreeKb) || measuredTreeKb <= 0) {
    return MIN_FREE_KB_FLOOR;
  }
  return Math.max(MIN_FREE_KB_FLOOR, Math.ceil(measuredTreeKb * 1.1) + TREE_MARGIN_KB);
}

export async function probeFreeKb(sandbox_id: string): Promise<number | null> {
  try {
    const probe = await execCommand(
      sandbox_id,
      `df -Pk "${REPO_ROOT}" 2>/dev/null | tail -1 | awk '{print $4}'`,
      PROBE_TIMEOUT_MS,
    );
    if (probe.exit_code !== 0) return null;
    const n = Number((probe.stdout || "").trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export type GcResult = {
  freedKb: number;
  steps: string[];
};

export async function gcSandboxDisk(opts: {
  sandbox_id: string;
  tenant_id: string;
  keepRunIds?: readonly string[];
}): Promise<GcResult> {
  const { sandbox_id, tenant_id, keepRunIds = [] } = opts;
  const before = await probeFreeKb(sandbox_id);
  const steps: string[] = [];

  try {
    const { removed } = await reapOrphanWorktrees({ sandbox_id, keepRunIds });
    if (removed.length > 0) steps.push(`reaped:${removed.length}`);
  } catch (e) {
    console.warn(`[disk-hygiene] worktree reap failed on ${sandbox_id}: ${(e as Error).message}`);
  }

  for (const [label, cmd] of [
    ["yarn", "yarn cache clean --all 2>/dev/null || rm -rf /home/user/.cache/yarn || true"],
    ["npm", "npm cache clean --force 2>/dev/null || rm -rf /home/user/.npm || true"],
  ] as const) {
    try {
      const r = await execCommand(sandbox_id, cmd, GC_TIMEOUT_MS);
      if (r.exit_code === 0) steps.push(label);
    } catch (e) {
      console.warn(
        `[disk-hygiene] ${label} cache clean failed on ${sandbox_id}: ${(e as Error).message}`,
      );
    }
  }

  const after = await probeFreeKb(sandbox_id);
  const freedKb = before != null && after != null ? Math.max(after - before, 0) : 0;

  void logEvent({
    tenant_id,
    level: "info",
    source: "sandbox-hygiene",
    code: "sandbox.disk_gc",
    meta: { freed_kb: freedKb, free_kb_after: after ?? -1, gc_steps: steps.join(",") },
  }).catch(() => {});

  return { freedKb, steps };
}

export type HygieneMode = "off" | "probe_only" | "gc_only" | "recreate";

export function diskHygieneMode(): HygieneMode {
  const raw = (process.env.SANDBOX_DISK_HYGIENE ?? "").trim().toLowerCase();
  if (raw === "off") return "off";
  if (raw === "probe_only" || raw === "gc_only" || raw === "recreate") return raw;
  return "gc_only";
}

export function templateReconcileEnabled(): boolean {
  return (process.env.SANDBOX_TEMPLATE_RECONCILE ?? "").trim() === "1";
}
