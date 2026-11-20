
import {
  resolveSandboxForRun,
  injectSandboxSecrets,
  bootstrapRepoIfNeeded,
  type SandboxHandle,
} from "./lifecycle";
import { resolveRepoCredsForRun } from "./repo-creds";
import { getNumberSetting } from "@/services/settings";
import { logEvent } from "@/services/logging/logEvent";

export const SANDBOX_LAZY_DAILY_CAP_SETTING = "sandbox_lazy_daily_cap" as const;

export class LazyProvisionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "LazyProvisionError";
    this.code = code;
    this.retryable = retryable;
  }
}

const provisionCounts = new Map<string, number>();

function dayKey(tenant_id: string): string {
  return `${tenant_id}:${new Date().toISOString().slice(0, 10)}`;
}

export function lazyProvisionCountToday(tenant_id: string): number {
  return provisionCounts.get(dayKey(tenant_id)) ?? 0;
}

function reserveProvisionSlot(tenant_id: string, cap: number): number | null {
  const k = dayKey(tenant_id);
  const used = provisionCounts.get(k) ?? 0;
  if (cap > 0 && used >= cap) return null;
  const reserved = used + 1;
  provisionCounts.set(k, reserved);
  return reserved;
}

function releaseProvisionSlot(tenant_id: string): void {
  const k = dayKey(tenant_id);
  const cur = provisionCounts.get(k) ?? 0;
  provisionCounts.set(k, Math.max(0, cur - 1));
}

export function _resetLazyProvisionCounts(): void {
  provisionCounts.clear();
}

const lazyProvisionedByRun = new Map<
  string,
  { handle: SandboxHandle; repo_full_name: string }
>();

export function takeLazyProvisionedSandbox(
  run_id: string,
): { handle: SandboxHandle; repo_full_name: string } | null {
  const v = lazyProvisionedByRun.get(run_id);
  if (v) lazyProvisionedByRun.delete(run_id);
  return v ?? null;
}

export function _resetLazyProvisionedHandles(): void {
  lazyProvisionedByRun.clear();
}

export type LazyProvisionArgs = {
  tenant_id: string;
  run_id: string;
  agent_slug: string;
  repo_full_name: string;
  payload: unknown;
};

export async function lazyProvisionSandboxForRun(
  args: LazyProvisionArgs,
): Promise<string> {
  const { tenant_id, run_id, agent_slug, repo_full_name } = args;
  const started = Date.now();

  let cap = 50;
  try {
    cap = await getNumberSetting(SANDBOX_LAZY_DAILY_CAP_SETTING, tenant_id);
  } catch {
  }
  const reserved = reserveProvisionSlot(tenant_id, cap);
  if (reserved === null) {
    await logEvent({
      level: "warn",
      source: "sandbox.lazy_provision",
      code: "sandbox.lazy_provision.cost_capped",
      tenant_id,
      run_id,
      meta: { agent_slug, count: lazyProvisionCountToday(tenant_id), cap },
    });
    throw new LazyProvisionError(
      "sandbox_daily_cap_exhausted",
      `This workspace has reached its daily sandbox-provision limit (${cap}). ` +
        `No new code sandbox can be started until tomorrow (UTC). This is a cost ` +
        `safeguard, not a transient error — do NOT retry; summarize what you can ` +
        `do without the sandbox.`,
      false,
    );
  }

  try {
    const creds = await resolveRepoCredsForRun(tenant_id, args.payload);
    if (creds.kind !== "resolved") {
      throw new LazyProvisionError(
        "repo_unresolved",
        "Could not resolve a single repository to provision the sandbox. " +
          "Pass an explicit repo_hint and retry.",
        false,
      );
    }
    if (creds.repo_full_name !== repo_full_name) {
      throw new LazyProvisionError(
        "repo_mismatch",
        `Resolved repo "${creds.repo_full_name}" does not match the repo this ` +
          `run is pinned to ("${repo_full_name}"). Refusing to provision.`,
        false,
      );
    }

    const handle = await resolveSandboxForRun({
      tenant_id,
      repo_full_name: creds.repo_full_name,
      installation_token: creds.installation_token,
    });

    await injectSandboxSecrets(handle.e2b_sandbox_id, {
      GITHUB_TOKEN: creds.installation_token,
    });

    await bootstrapRepoIfNeeded(
      handle.e2b_sandbox_id,
      creds.repo_full_name,
      tenant_id,
    );

    lazyProvisionedByRun.set(run_id, {
      handle,
      repo_full_name: creds.repo_full_name,
    });

    await logEvent({
      level: "info",
      source: "sandbox.lazy_provision",
      code: "sandbox.lazy_provision.ok",
      tenant_id,
      run_id,
      meta: { agent_slug, ms: Date.now() - started, count: reserved, cap },
    });

    return handle.e2b_sandbox_id;
  } catch (e) {
    releaseProvisionSlot(tenant_id);

    if (e instanceof LazyProvisionError) throw e;
    await logEvent({
      level: "warn",
      source: "sandbox.lazy_provision",
      code: "sandbox.lazy_provision.failed",
      tenant_id,
      run_id,
      error: e,
      meta: { agent_slug, ms: Date.now() - started },
    });
    throw new LazyProvisionError(
      "sandbox_provision_failed",
      `Sandbox provisioning failed transiently (${(e as Error).message}). ` +
        `Provisioning is idempotent — retry this tool call.`,
      true,
    );
  }
}
