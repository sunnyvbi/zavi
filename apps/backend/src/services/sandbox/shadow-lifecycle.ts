
import {
  createSandbox,
  cloneRepo,
  destroySandbox,
  setEnv,
} from "./e2b-client";
import {
  resolveRepoCredsForRun,
  type RepoCredsResolved,
} from "./repo-creds";

export const SHADOW_DOGFOOD_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

export type ShadowSandboxHandle = {
  sandbox_id: string;
  repo_full_name: string;
};

export type CreateShadowSandboxArgs = {
  run_id: string;
  tenant_id: string;
  payload: unknown;
};

export class ShadowSandboxProvisionError extends Error {
  readonly sandbox_id?: string;
  constructor(message: string, sandbox_id?: string) {
    super(message);
    this.name = "ShadowSandboxProvisionError";
    this.sandbox_id = sandbox_id;
  }
}

export async function createShadowSandboxForRun(
  args: CreateShadowSandboxArgs,
): Promise<ShadowSandboxHandle> {
  let creds: RepoCredsResolved;
  {
    const resolved = await resolveRepoCredsForRun(args.tenant_id, args.payload);
    if (resolved.kind !== "resolved") {
      throw new ShadowSandboxProvisionError(
        `shadow sandbox: repo creds did not resolve (kind=${resolved.kind}) for ` +
          `tenant=${args.tenant_id}. A shadow run needs an unambiguous repo; ` +
          `pass a payload with an explicit repo_hint.`,
      );
    }
    creds = resolved;
  }

  let sandbox_id: string;
  try {
    sandbox_id = await createSandbox({
      tenant_id: args.tenant_id,
      repo_full_name: creds.repo_full_name,
    });
  } catch (e) {
    throw new ShadowSandboxProvisionError(
      `shadow sandbox: createSandbox failed: ${(e as Error).message}`,
    );
  }

  try {
    await setEnv(sandbox_id, { GITHUB_TOKEN: creds.installation_token });

    const r = await cloneRepo(sandbox_id, creds.owner, creds.repo);
    if (r.exit_code !== 0 && !/already exists/i.test(r.stderr)) {
      throw new Error(
        `cloneRepo failed exit=${r.exit_code} stderr=${r.stderr.slice(0, 400)}`,
      );
    }
  } catch (e) {
    throw new ShadowSandboxProvisionError(
      `shadow sandbox: provisioning failed after create: ${(e as Error).message}`,
      sandbox_id,
    );
  }

  return { sandbox_id, repo_full_name: creds.repo_full_name };
}

export async function destroyShadowSandbox(
  sandbox_id: string | null | undefined,
): Promise<void> {
  if (!sandbox_id) return;
  try {
    await destroySandbox(sandbox_id);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `[shadow-lifecycle] destroyShadowSandbox failed for ${sandbox_id} ` +
        `(box may leak — infra-reaper sweeps orphans): ${(e as Error).message}`,
    );
  }
}

export type ShadowSandboxResolveCtx = {
  shadow_mode?: boolean;
  shadow_sandbox_id?: string;
};

export async function resolveShadowOrLiveSandboxId(
  ctx: ShadowSandboxResolveCtx,
  resolveLive: () => Promise<string | null>,
): Promise<string> {
  if (ctx.shadow_mode === true) {
    if (!ctx.shadow_sandbox_id) {
      throw new Error(
        "shadow run reached sandbox resolution with no shadow_sandbox_id — refusing " +
          "to fall back to the live tenant_sandbox (cross-customer contamination guard). " +
          "createShadowSandboxForRun must run + set ctx.shadow_sandbox_id before any sandbox tool.",
      );
    }
    return ctx.shadow_sandbox_id;
  }
  const id = await resolveLive();
  if (!id) {
    throw new Error(
      "no active sandbox (live resolution returned null). Did resolveSandboxForRun run?",
    );
  }
  return id;
}
