
import { asTenantId, tenantClient } from "@/services/tenant-client";
import * as e2b from "@/services/sandbox/e2b-client";
import type { ResolveSandboxArgs, SandboxHandle } from "@/services/sandbox/lifecycle";
import { SITE_REPO_DIR, type SiteRow, type SiteSandbox, type SiteSandboxResolver, type SiteStore } from "./contract";
import { SiteBackendUnresolved, siteBackendKindOf, type SiteBackendKind } from "./site-backend";

type SandboxRowLite = { e2b_sandbox_id: string | null; status: string | null };

export type SiteSandboxResolverDeps = {
  store: SiteStore;
  loadSandboxRow: (tenant_id: string, repo_full_name: string) => Promise<SandboxRowLite | null>;
  resume: (sandbox_id: string) => Promise<void>;
  exec: typeof e2b.execCommand;
  readFileBytes: (sandbox_id: string, path: string) => Promise<Uint8Array>;
  recreate: ((site: SiteRow) => Promise<string>) | null;
  revokeToken: (sandbox_id: string) => Promise<void>;
  quarantine: (sandbox_id: string) => Promise<void>;
  destroy: (sandbox_id: string) => Promise<void>;
};

const USABLE = new Set(["active", "paused", "creating"]);
const REPO_FULL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;

async function realLoadSandboxRow(tenant_id: string, repo_full_name: string): Promise<SandboxRowLite | null> {
  const { data, error } = await (tenantClient(asTenantId(tenant_id))
    .from("tenant_sandbox")
    .select("e2b_sandbox_id, status") as any)
    .eq("repo_full_name", repo_full_name)
    .maybeSingle();
  if (error) throw new Error(`tenant_sandbox read failed: ${error.message ?? "unknown error"}`);
  return (data as SandboxRowLite | null) ?? null;
}

export type SiteSandboxRecreateDeps = {
  token: () => string | null;
  resolve: (args: ResolveSandboxArgs) => Promise<SandboxHandle>;
  injectSecrets: (sandbox_id: string, secrets: Record<string, string>) => Promise<void>;
  revokeToken: (sandbox_id: string) => Promise<void>;
  headOf: (github_full_name: string) => Promise<string | null>;
  resetRepo: (sandbox_id: string, remoteUrl: string, sha: string) => Promise<void>;
  markFailed: (row_id: string, error: string) => Promise<void>;
  template: (site_id: string, backend: SiteBackendKind) => string | undefined;
  quarantine?: (sandbox_id: string) => Promise<void>;
  destroy?: (sandbox_id: string) => Promise<void>;
  retireExisting?: (site: SiteRow) => Promise<void>;
  log?: (line: Record<string, unknown>) => void;
  alert?: (input: { msg: string; code: string; tenant_id: string }) => Promise<void>;
};

function errText(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 300);
}

export async function recreateSiteSandbox(
  site: SiteRow,
  deps: SiteSandboxRecreateDeps,
  opts: { fresh?: boolean; sha?: string } = {},
): Promise<string> {
  const log = deps.log ?? ((l) => console.log(JSON.stringify(l)));
  const base = { evt: "site_sandbox_recreate", tenant_id: site.tenant_id, site_id: site.id };
  const fail = async (reason: string, err: Error): Promise<never> => {
    log({ ...base, outcome: "failed", reason });
    await deps
      .alert?.({ msg: `site sandbox recreate failed: site=${site.id} reason=${reason}`, code: "site_sandbox_recreate_failed", tenant_id: site.tenant_id })
      .catch(() => undefined);
    throw err;
  };

  const repo = (site.github_full_name ?? "").trim();
  if (!REPO_FULL_RE.test(repo)) return fail("no_repo", new Error("site sandbox recreate: the site has no valid repo"));
  const backend = siteBackendKindOf(site);
  if (!backend) return fail("backend_unresolved", new SiteBackendUnresolved(site.id, "site row has no backend_mode"));
  const token = deps.token();
  if (!token) return fail("no_repo_credential", new Error("site sandbox recreate: the site repo credential is not configured"));

  if (opts.fresh) {
    if (!deps.retireExisting) return fail("no_retire", new Error("site sandbox recreate: a fresh box was required but cannot be guaranteed"));
    try {
      await deps.retireExisting(site);
    } catch (e) {
      return fail(`retire: ${errText(e)}`, new Error(`site sandbox recreate: could not retire the old box: ${errText(e)}`));
    }
  }
  log({ ...base, outcome: "started", backend, fresh: opts.fresh === true });
  const args: ResolveSandboxArgs = {
    tenant_id: site.tenant_id,
    repo_full_name: repo,
    installation_token: token,
    template: deps.template(site.id, backend),
    provisioned: true,
    run_id: site.id,
  };
  let handle: SandboxHandle;
  try {
    handle = await deps.resolve(args);
  } catch (first) {
    if (opts.fresh) return fail(`resolve: ${errText(first)}`, new Error(`site sandbox recreate: ${errText(first)}`));
    try {
      handle = await deps.resolve(args);
    } catch (e) {
      return fail(`resolve: ${errText(first)} / ${errText(e)}`, new Error(`site sandbox recreate: ${errText(e)}`));
    }
  }

  const id = handle.e2b_sandbox_id;
  try {
    await deps.injectSecrets(id, { GITHUB_TOKEN: token });
    const sha = opts.sha ?? (await deps.headOf(repo).catch(() => null)) ?? site.desired_sha;
    if (!sha) throw new Error("no commit to check out for this site");
    await deps.resetRepo(id, `https://github.com/${repo}.git`, sha);
    await deps.revokeToken(id);
  } catch (e) {
    const extra: string[] = [];
    let scrubbed = true;
    await deps.revokeToken(id).catch((r) => {
      scrubbed = false;
      extra.push(`revoke: ${errText(r)}`);
    });
    if (!scrubbed && deps.quarantine) {
      await deps.quarantine(id).catch(async (q) => {
        extra.push(`quarantine: ${errText(q)}`);
        const destroyed = deps.destroy ? await deps.destroy(id).then(() => true, (d) => (extra.push(`destroy: ${errText(d)}`), false)) : false;
        if (!destroyed) {
          await deps
            .alert?.({ msg: `site sandbox credential NOT contained: site=${site.id} box=${id}`, code: "site_sandbox_credential_uncontained", tenant_id: site.tenant_id })
            .catch(() => undefined);
        }
      });
    }
    await deps.markFailed(handle.row_id, `site sandbox setup failed: ${errText(e)}`).catch((m) => void extra.push(`mark: ${errText(m)}`));
    return fail([`setup: ${errText(e)}`, ...extra].join("; "), new Error(`site sandbox recreate: ${errText(e)}`));
  }
  log({ ...base, outcome: "recreated", e2b_sandbox_id: id });
  return id;
}

export async function siteTreeState(
  sandbox_id: string,
  repo: string,
  exec: SiteSandboxResolverDeps["exec"],
): Promise<"foreign" | "credential" | "clean"> {
  const r = await exec(sandbox_id, `cd ${SITE_REPO_DIR} && git remote get-url origin`, 30_000);
  if (r.exit_code !== 0) return "foreign";
  return siteOriginState(r.stdout, repo);
}

export function siteOriginState(originUrl: string | null | undefined, repo: string): "foreign" | "credential" | "clean" {
  const m = String(originUrl ?? "").trim().match(/^https:\/\/(?:([^@/]*)@)?(.+?)(?:\.git)?\/?$/i);
  if (!m) return "foreign";
  const want = `github.com/${repo}`.toLowerCase();
  if (m[2].toLowerCase() !== want) return "foreign";
  const cred = m[1];
  return !cred || cred === "x-access-token:REVOKED" ? "clean" : "credential";
}

export async function realReseedSiteSandbox(tenant_id: string, site: SiteRow, sha?: string): Promise<string> {
  if (site.tenant_id !== tenant_id) throw new Error("site sandbox reseed: the site does not belong to this tenant");
  return realRecreate(site, { fresh: true, ...(sha ? { sha } : {}) });
}

async function realRetireSiteSandbox(site: SiteRow): Promise<void> {
  const repo = (site.github_full_name ?? "").trim();
  const { data, error } = await (tenantClient(asTenantId(site.tenant_id))
    .from("tenant_sandbox")
    .select("id, e2b_sandbox_id") as any)
    .eq("repo_full_name", repo)
    .maybeSingle();
  if (error) throw new Error(`tenant_sandbox read failed: ${error.message ?? "unknown error"}`);
  const row = data as { id?: string; e2b_sandbox_id?: string | null } | null;
  if (!row?.id) return;
  if (row.e2b_sandbox_id) await e2b.destroySandbox(row.e2b_sandbox_id);
  const { markSandboxDestroyed } = await import("@/services/sandbox/lifecycle");
  await markSandboxDestroyed(row.id);
}

async function realRecreate(site: SiteRow, opts: { fresh?: boolean; sha?: string } = {}): Promise<string> {
  const [lifecycle, { readProvisionedRepoHeadSha }, { alert }, { revokeSandboxGithubToken }] = await Promise.all([
    import("@/services/sandbox/lifecycle"),
    import("@/services/provisioning/github-repo"),
    import("@/services/logging/alert"),
    import("@/services/sandbox/e2b-client"),
  ]);
  return recreateSiteSandbox(site, {
    token: () => process.env.GITHUB_PROVISION_TOKEN?.trim() || null,
    resolve: lifecycle.resolveSandboxForRun,
    injectSecrets: (id, secrets) => lifecycle.injectSandboxSecrets(id, secrets),
    revokeToken: (id) => revokeSandboxGithubToken(id),
    headOf: (full) => readProvisionedRepoHeadSha(full, "main"),
    resetRepo: lifecycle.resetSiteRepo,
    markFailed: lifecycle.markSandboxFailed,
    template: (site_id, backend) => lifecycle.sandboxTemplateForRun("engineer", { site_id, site_backend: backend }),
    alert: (i) => alert({ msg: i.msg, code: i.code, tenant_id: i.tenant_id, source: "site-sandbox" }),
    quarantine: (id) => e2b.pauseSandbox(id),
    destroy: (id) => e2b.destroySandbox(id),
    retireExisting: realRetireSiteSandbox,
  }, opts);
}

export function siteSandboxFor(sandbox_id: string, deps: Pick<SiteSandboxResolverDeps, "exec" | "readFileBytes">): SiteSandbox {
  return {
    async run(cmd, opts = {}) {
      const full = opts.cwd ? `cd '${opts.cwd.replace(/'/g, "'\\''")}' && ${cmd}` : cmd;
      const r = await deps.exec(sandbox_id, full, opts.timeoutMs ?? 120_000, { env: opts.env, redact: opts.redact, ...(opts.user ? { user: opts.user } : {}) });
      return {
        exitCode: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        ...(r.timed_out ? { timedOut: true } : {}),
        ...(r.transport_error ? { transportError: true } : {}),
      };
    },
    async readFile(path) {
      return Buffer.from(await deps.readFileBytes(sandbox_id, path));
    },
    async listFiles(dir) {
      const r = await deps.exec(sandbox_id, `cd '${dir.replace(/'/g, "'\\''")}' && find . -type f | sed 's|^\\./||'`, 60_000);
      if (r.exit_code !== 0) throw new Error(`listFiles ${dir} failed (exit ${r.exit_code})`);
      return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    },
  };
}

export function createSiteSandboxResolver(deps: Partial<SiteSandboxResolverDeps> & { store: SiteStore }): SiteSandboxResolver {
  const d: SiteSandboxResolverDeps = {
    loadSandboxRow: realLoadSandboxRow,
    resume: e2b.resumeSandbox,
    exec: e2b.execCommand,
    readFileBytes: e2b.readFileBytes,
    recreate: (site) => realRecreate(site, { fresh: true }),
    revokeToken: (id) => e2b.revokeSandboxGithubToken(id),
    quarantine: (id) => e2b.pauseSandbox(id),
    destroy: (id) => e2b.destroySandbox(id),
    ...deps,
  };
  return {
    async forSite(tenant_id, site_id) {
      const site = await d.store.get(tenant_id, site_id);
      if (!site || site.tenant_id !== tenant_id || !site.github_full_name) return null;
      const row = await d.loadSandboxRow(tenant_id, site.github_full_name);
      if (row && row.e2b_sandbox_id && USABLE.has(String(row.status ?? ""))) {
        let state: "foreign" | "credential" | "clean" | "unresumable" = "unresumable";
        try {
          await d.resume(row.e2b_sandbox_id);
          if (!d.recreate) return siteSandboxFor(row.e2b_sandbox_id, d);
          state = await siteTreeState(row.e2b_sandbox_id, site.github_full_name, d.exec);
        } catch (e) {
          console.warn(`[site-sandbox] resume failed for site ${site_id}: ${errText(e).slice(0, 200)}`);
        }
        if (state === "credential") {
          console.warn(JSON.stringify({ evt: "site_sandbox_credential_scrub", tenant_id, site_id }));
          const id = row.e2b_sandbox_id;
          await d.revokeToken(id).catch(async (e: unknown) => {
            await d
              .quarantine(id)
              .catch(() => d.destroy(id))
              .catch((q: unknown) => {
                console.error(JSON.stringify({ evt: "site_sandbox_credential_uncontained", tenant_id, site_id, error: errText(q).slice(0, 200) }));
              });
            throw e;
          });
        }
        if (state === "credential" || state === "clean") return siteSandboxFor(row.e2b_sandbox_id, d);
        if (state === "foreign") console.warn(`[site-sandbox] sandbox tree of site ${site_id} is not wired to its repo; setting it up again`);
      }
      if (!d.recreate) return null;
      return siteSandboxFor(await d.recreate(site), d);
    },
  };
}
