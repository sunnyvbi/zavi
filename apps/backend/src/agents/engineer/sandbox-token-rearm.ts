
import { resolveRepoCredsForRun } from "@/services/sandbox/repo-creds";
import { injectSandboxSecrets, quarantineSandbox } from "@/services/sandbox/lifecycle";
import {
  revokeSandboxGithubToken,
  ENGINEER_NODE_OPTIONS,
} from "@/services/sandbox/e2b-client";

export type RearmDeps = {
  resolveCreds?: typeof resolveRepoCredsForRun;
  inject?: typeof injectSandboxSecrets;
  revoke?: typeof revokeSandboxGithubToken;
  quarantine?: (sandbox_id: string, tenant_id: string, cause: string) => Promise<unknown>;
  strictRevoke?: boolean;
};

const realQuarantine = (sandbox_id: string, tenant_id: string, cause: string) =>
  quarantineSandbox(
    { e2b_sandbox_id: sandbox_id },
    { source: "engineer-token-rearm", tenant_id, reason: cause },
  );

export async function withSandboxGithubToken<T>(
  tenant_id: string,
  payload: unknown,
  sandbox_id: string,
  fn: () => Promise<T>,
  deps: RearmDeps = {},
): Promise<T> {
  const resolveCreds = deps.resolveCreds ?? resolveRepoCredsForRun;
  const inject = deps.inject ?? injectSandboxSecrets;
  const revoke = deps.revoke ?? revokeSandboxGithubToken;
  const quarantine = deps.quarantine ?? realQuarantine;

  const scrub = async (): Promise<unknown> => {
    try {
      await revoke(sandbox_id, { NODE_OPTIONS: ENGINEER_NODE_OPTIONS });
      return null;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      console.warn(`[engineer post-run] github-token re-revoke failed, quarantining sandbox: ${msg}`);
      await quarantine(sandbox_id, tenant_id, msg).catch(() => undefined);
      return e;
    }
  };

  let reArmed = false;
  let injecting = false;
  try {
    const creds = await resolveCreds(tenant_id, payload);
    if (creds.kind === "resolved") {
      injecting = true;
      await inject(sandbox_id, {
        GITHUB_TOKEN: creds.installation_token,
        NODE_OPTIONS: ENGINEER_NODE_OPTIONS,
      });
      reArmed = true;
    }
  } catch (e) {
    const scrubErr = injecting ? await scrub() : null;
    if (deps.strictRevoke && injecting) throw scrubErr ?? e;
    console.warn(
      `[engineer post-run] github-token re-arm failed (per-base fetch may 128): ${
        (e as Error).message
      }`,
    );
  }

  try {
    return await fn();
  } finally {
    if (reArmed) {
      const scrubErr = await scrub();
      if (scrubErr && deps.strictRevoke) throw scrubErr;
    }
  }
}
