
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serviceClient } from "@/services/supabase";
import { serverClientFromBearer } from "@/services/supabase";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { BuildSessionError, resolveBuildSessionApp } from "@/services/sites/session-site";
import type { SiteRow } from "@/services/sites/contract";
import { siteStore } from "@/services/sites/store";
import { resolveProvisionOrg } from "@/services/provisioning/provision-org";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";
import {
  DestRepoMissing,
  destRepoExists,
  exportRepoToOwnGitHub,
  readSourceHead,
  type ExportToOwnGitHubResult,
} from "@/services/provisioning/export-to-own-github";
import { mintInstallationToken } from "@/services/connectors/github/oauth";

function sanitizeRepoName(raw: unknown): string | null | { invalid: true } {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return { invalid: true };
  const v = raw.trim();
  if (!v) return null;
  if (v.length > 90 || !/^[A-Za-z0-9._-]+$/.test(v)) return { invalid: true };
  return v;
}

const WRITE_ROLES = ["owner", "admin"] as const;

const exportsInFlight = new Set<string>();

export function __resetExportsInFlight(): void {
  exportsInFlight.clear();
}

function fullNameOf(external_ref: unknown): string | null {
  const v = (external_ref as { github_full_name?: unknown } | null)?.github_full_name;
  return typeof v === "string" && /^[^/]+\/[^/]+$/.test(v) ? v : null;
}

function repoFromTarget(target: unknown): string | null {
  const t = target as { github_full_name?: unknown; repo_url?: unknown } | null;
  if (typeof t?.github_full_name === "string" && /^[^/\s]+\/[^/\s]+$/.test(t.github_full_name)) return t.github_full_name;
  if (typeof t?.repo_url === "string") {
    const m = t.repo_url.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s#?]+?)(?:\.git)?\/?$/);
    if (m) return m[1];
  }
  return null;
}

type BuildSource =
  | { ok: true; full_name: string; site: SiteRow | null }
  | { ok: false; status: number; code: string; message: string };

const REPO_FULL_NAME_RE = /^[^/\s]+\/[^/\s]+$/;

async function resolveBuildSource(
  tenant_id: string,
  access_token: string,
  conductor_run_id: unknown,
  tenantRepo: string | null,
): Promise<BuildSource> {
  let app;
  try {
    app = await resolveBuildSessionApp(serverClientFromBearer(access_token), tenant_id, conductor_run_id);
  } catch (e) {
    if (e instanceof BuildSessionError) return { ok: false, status: e.status, code: e.code, message: e.message };
    throw e;
  }
  if (app.kind === "none") {
    return { ok: false, status: 400, code: "invalid_build_session", message: "build_session_id must be a build id" };
  }
  if (app.kind === "site") {
    const full_name = app.site.github_full_name ?? "";
    if (!REPO_FULL_NAME_RE.test(full_name)) {
      return { ok: false, status: 409, code: "no_provisioned_repo", message: "This site has no code to export yet. It arrives once the build finishes." };
    }
    if (full_name.split("/")[0].toLowerCase() !== resolveProvisionOrg().toLowerCase()) {
      return { ok: false, status: 409, code: "not_zavi_managed", message: "This site's code is already in your own GitHub repo, so there is nothing to export." };
    }
    return { ok: true, full_name, site: app.site };
  }
  const run_id = app.run_id;
  const { data, error } = await serviceClient()
    .from("conductor_runs")
    .select("goal_graph")
    .eq("id", run_id)
    .eq("tenant_id", tenant_id)
    .eq("kind", "build_app")
    .maybeSingle();
  if (error) return { ok: false, status: 503, code: "build_session_check_failed", message: error.message };
  if (!data) return { ok: false, status: 404, code: "build_session_not_found", message: "That build isn't in this workspace." };
  const graph = (data as { goal_graph?: unknown }).goal_graph;
  const nodes = Array.isArray(graph) ? graph : [];
  const full_name = nodes
    .map((n) => repoFromTarget((n as { payload?: { target?: unknown } } | null)?.payload?.target))
    .find((r): r is string => r !== null);
  if (!full_name) {
    return { ok: false, status: 409, code: "no_provisioned_repo", message: "This build has no code to export yet. It arrives once the build finishes." };
  }
  const owner = full_name.split("/")[0].toLowerCase();
  const managed = new Set([resolveProvisionOrg().toLowerCase()]);
  if (tenantRepo) managed.add(tenantRepo.split("/")[0].toLowerCase());
  if (!managed.has(owner)) {
    return { ok: false, status: 409, code: "not_zavi_managed", message: "This build's code is already in your own GitHub repo, so there is nothing to export." };
  }
  return { ok: true, full_name, site: null };
}

export type ExportRecord = {
  full_name: string;
  url: string;
  branch: string;
  commit_sha: string | null;
  source_sha: string | null;
  file_count: number;
  exported_at: string;
};

async function sourceUpToDate(record: ExportRecord | null, source: string | null): Promise<boolean | null> {
  if (!record?.source_sha || !source) return null;
  const token = process.env.GITHUB_PROVISION_TOKEN;
  if (!token) return null;
  try {
    const head = await readSourceHead(source, token, (globalThis as { fetch: typeof fetch }).fetch);
    return head.sha === record.source_sha;
  } catch (e) {
    console.warn("[export-github] could not read the source head", (e as Error).message);
    return null;
  }
}

function exportForSource(external_ref: unknown, source: string | null): ExportRecord | null {
  if (!source) return readExportRecord(external_ref);
  const byRepo = (external_ref as { exports?: Record<string, unknown> } | null)?.exports;
  const scoped = byRepo && typeof byRepo === "object" ? parseExportRecord(byRepo[source]) : null;
  if (scoped) return scoped;
  return fullNameOf(external_ref) === source ? readExportRecord(external_ref) : null;
}

function readExportRecord(external_ref: unknown): ExportRecord | null {
  return parseExportRecord((external_ref as { export?: unknown } | null)?.export);
}

function parseExportRecord(raw: unknown): ExportRecord | null {
  const rec = raw as Partial<ExportRecord> | null | undefined;
  if (!rec || typeof rec.full_name !== "string" || typeof rec.url !== "string") return null;
  return {
    full_name: rec.full_name,
    url: rec.url,
    branch: typeof rec.branch === "string" ? rec.branch : "main",
    commit_sha: typeof rec.commit_sha === "string" ? rec.commit_sha : null,
    source_sha: typeof rec.source_sha === "string" ? rec.source_sha : null,
    file_count: typeof rec.file_count === "number" ? rec.file_count : 0,
    exported_at: typeof rec.exported_at === "string" ? rec.exported_at : "",
  };
}

export async function getWorkspaceExportGithubStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { data: repoRow, error: repoErr } = await serviceClient()
    .from("tenant_resources")
    .select("external_ref")
    .eq("tenant_id", auth.tenant_id)
    .eq("resource_kind", "repo")
    .maybeSingle();
  if (repoErr) {
    res.status(500).json({ error: { code: "repo_lookup_failed", message: repoErr.message } });
    return;
  }
  const buildId = (req.query ?? {}).conductor_run_id;
  let source: string | null = null;
  if (buildId !== undefined) {
    const built = await resolveBuildSource(auth.tenant_id, auth.access_token, buildId, fullNameOf(repoRow?.external_ref));
    if (!built.ok) {
      if (built.status === 409) {
        res.json({ ok: true, export: null, source: null, up_to_date: null });
        return;
      }
      res.status(built.status).json({ error: { code: built.code, message: built.message } });
      return;
    }
    if (built.site) {
      const record = parseExportRecord(built.site.github_export);
      res.json({ ok: true, export: record, source: built.full_name, up_to_date: await sourceUpToDate(record, built.full_name) });
      return;
    }
    source = built.full_name;
  }
  const record = exportForSource(repoRow?.external_ref, source);
  const resolvedSource = source ?? fullNameOf(repoRow?.external_ref);
  res.json({
    ok: true,
    export: record,
    source: resolvedSource,
    up_to_date: await sourceUpToDate(record, resolvedSource),
  });
}

function sameExport(previous: ExportRecord | null, result: ExportToOwnGitHubResult): boolean {
  return (
    previous !== null &&
    previous.full_name === result.dest_full_name &&
    (previous.source_sha ?? null) === (result.source_sha ?? null)
  );
}

function exportRecordOf(result: ExportToOwnGitHubResult, previous: ExportRecord | null): ExportRecord {
  return {
    full_name: result.dest_full_name,
    url: result.dest_url,
    branch: result.branch,
    commit_sha: result.exported ? result.commit_sha : previous?.commit_sha ?? null,
    source_sha: result.source_sha ?? previous?.source_sha ?? null,
    file_count: result.file_count,
    exported_at: result.exported ? new Date().toISOString() : previous?.exported_at ?? new Date().toISOString(),
  };
}

async function rememberSiteExport(tenant_id: string, site: SiteRow, result: ExportToOwnGitHubResult): Promise<void> {
  let fresh: SiteRow | null;
  try {
    fresh = await siteStore().get(tenant_id, site.id);
  } catch (e) {
    console.warn("[export-github] could not remember site export", (e as Error).message);
    return;
  }
  if (!fresh || fresh.tenant_id !== tenant_id) {
    console.warn("[export-github] could not remember site export", "site row gone");
    return;
  }
  const previous = parseExportRecord(fresh.github_export);
  if (!result.exported && sameExport(previous, result)) return;
  const { error } = await tenantRpc(asTenantId(tenant_id), "site_set_github_export", {
    p_site_id: site.id,
    p_record: exportRecordOf(result, previous),
  });
  if (error) console.warn("[export-github] could not remember site export", error.message);
}

async function rememberExport(
  tenant_id: string,
  source_full_name: string,
  result: ExportToOwnGitHubResult,
): Promise<void> {
  const { data: fresh, error: readErr } = await serviceClient()
    .from("tenant_resources")
    .select("external_ref")
    .eq("tenant_id", tenant_id)
    .eq("resource_kind", "repo")
    .maybeSingle();
  if (readErr || !fresh) {
    console.warn("[export-github] could not remember export", readErr?.message ?? "repo row gone");
    return;
  }
  const external_ref: unknown = fresh.external_ref;
  const previous = exportForSource(external_ref, source_full_name);
  if (!result.exported && sameExport(previous, result)) return;
  const record = exportRecordOf(result, previous);
  const base =
    external_ref && typeof external_ref === "object" ? (external_ref as Record<string, unknown>) : {};
  const prior = base.exports && typeof base.exports === "object" ? (base.exports as Record<string, unknown>) : {};
  const next: Record<string, unknown> = { ...base, exports: { ...prior, [source_full_name]: record } };
  if (fullNameOf(base) === source_full_name) next.export = record;
  const { error } = await serviceClient()
    .from("tenant_resources")
    .update({ external_ref: next })
    .eq("tenant_id", tenant_id)
    .eq("resource_kind", "repo");
  if (error) console.warn("[export-github] could not remember export", error.message);
}

export async function getWorkspaceExportGithubDest(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const nameOrErr = sanitizeRepoName((req.query ?? {}).dest_repo_name);
  if (!nameOrErr || typeof nameOrErr === "object") {
    res.status(400).json({
      error: {
        code: "bad_dest_repo_name",
        message: "dest_repo_name is required: letters, numbers, '.', '_', '-', at most 90 chars.",
      },
    });
    return;
  }
  const { data: gh, error: ghErr } = await serviceClient()
    .from("connector_metadata")
    .select("installation_id, account_login")
    .eq("tenant_id", auth.tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (ghErr) {
    res.status(500).json({ error: { code: "github_lookup_failed", message: ghErr.message } });
    return;
  }
  const installation_id = (gh as { installation_id?: number | null } | null)?.installation_id;
  const account_login = (gh as { account_login?: string | null } | null)?.account_login;
  if (!installation_id || !account_login) {
    res.status(409).json({ error: { code: "github_not_connected", message: "Connect your own GitHub before exporting." } });
    return;
  }
  try {
    const installToken = await mintInstallationToken({ tenant_id: auth.tenant_id, installation_id });
    const exists = await destRepoExists(
      { dest_owner: account_login, dest_repo_name: nameOrErr, installToken },
      (globalThis as { fetch: typeof fetch }).fetch,
    );
    res.json({ ok: true, exists, full_name: `${account_login}/${nameOrErr}` });
  } catch (e) {
    res.status(502).json({ error: { code: "dest_lookup_failed", message: (e as Error).message || "GitHub lookup failed" } });
  }
}

export async function postWorkspaceExportGithub(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;

  const nameOrErr = sanitizeRepoName((req.body ?? {}).dest_repo_name);
  if (nameOrErr && typeof nameOrErr === "object" && "invalid" in nameOrErr) {
    res.status(400).json({
      error: {
        code: "bad_dest_repo_name",
        message:
          "dest_repo_name may contain only letters, numbers, '.', '_', '-' and be ≤90 chars.",
      },
    });
    return;
  }
  const dest_repo_name = (nameOrErr as string | null) ?? undefined;

  const { data: repoRow, error: repoErr } = await serviceClient()
    .from("tenant_resources")
    .select("mode, status, external_ref")
    .eq("tenant_id", auth.tenant_id)
    .eq("resource_kind", "repo")
    .maybeSingle();
  if (repoErr) {
    res
      .status(500)
      .json({ error: { code: "repo_lookup_failed", message: repoErr.message } });
    return;
  }
  const buildId = (req.body ?? {}).conductor_run_id;
  let source_full_name =
    typeof (repoRow?.external_ref as { github_full_name?: string } | null)
      ?.github_full_name === "string"
      ? (repoRow!.external_ref as { github_full_name: string }).github_full_name
      : "";
  let site: SiteRow | null = null;
  if (buildId !== undefined && buildId !== null) {
    const built = await resolveBuildSource(auth.tenant_id, auth.access_token, buildId, repoRow?.mode === "provisioned" ? fullNameOf(repoRow?.external_ref) : null);
    if (!built.ok) {
      res.status(built.status).json({ error: { code: built.code, message: built.message } });
      return;
    }
    source_full_name = built.full_name;
    site = built.site;
  } else if (!repoRow || repoRow.mode !== "provisioned" || !source_full_name) {
    res.status(409).json({
      error: {
        code: "no_provisioned_repo",
        message:
          "This workspace has no Praxis-built product repo to export. The build flow creates one; nothing to migrate yet.",
      },
    });
    return;
  }

  const { data: gh, error: ghErr } = await serviceClient()
    .from("connector_metadata")
    .select("installation_id, account_login, account_type")
    .eq("tenant_id", auth.tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (ghErr) {
    res
      .status(500)
      .json({ error: { code: "github_lookup_failed", message: ghErr.message } });
    return;
  }
  const installation_id = (gh as { installation_id?: number | null } | null)
    ?.installation_id;
  const account_login = (gh as { account_login?: string | null } | null)
    ?.account_login;
  const account_type =
    (gh as { account_type?: string | null } | null)?.account_type ?? "Organization";
  if (!installation_id || !account_login) {
    res.status(409).json({
      error: {
        code: "github_not_connected",
        message:
          "Connect your own GitHub (Settings → Connectors → GitHub) before exporting. We push the built product into a repo you own.",
      },
    });
    return;
  }

  const tenant_id = auth.tenant_id;
  const dest_owner: string = account_login;
  const install_id: number = installation_id;
  const flightKey = `${tenant_id}\n${source_full_name}`;
  if (exportsInFlight.has(flightKey)) {
    res.status(409).json({
      error: {
        code: "idempotency_in_progress",
        message: "This build is being exported right now. It finishes on its own.",
      },
    });
    return;
  }
  exportsInFlight.add(flightKey);
  try {
    await runExport();
  } finally {
    exportsInFlight.delete(flightKey);
  }

  async function runExport(): Promise<void> {
  let result: ExportToOwnGitHubResult;
  try {
    result = await exportRepoToOwnGitHub({
      tenant_id,
      source_full_name,
      dest_owner,
      dest_account_type: account_type,
      installation_id: install_id,
      dest_repo_name,
    });
  } catch (e) {
    if (e instanceof CredentialNotConfigured) {
      res.status(503).json({
        error: {
          code: "export_not_configured",
          message: "Export is not configured on the server yet (missing GitHub provisioning token).",
        },
      });
      return;
    }
    if (e instanceof DestRepoMissing) {
      res.status(409).json({
        error: {
          code: "dest_repo_must_exist",
          message: e.message.replace(/^dest_user_repo_must_exist:\s*/, ""),
          owner: e.owner,
          repo_name: e.repo_name,
          access_url:
            account_type === "Organization"
              ? `https://github.com/organizations/${encodeURIComponent(dest_owner)}/settings/installations/${install_id}`
              : `https://github.com/settings/installations/${install_id}`,
        },
      });
      return;
    }
    const msg = (e as Error).message || "export failed";
    if (msg.startsWith("dest_repo_not_empty")) {
      res.status(409).json({
        error: {
          code: "dest_repo_not_empty",
          message: msg.replace(/^dest_repo_not_empty:\s*/, ""),
        },
      });
      return;
    }
    if (msg.startsWith("dest_repo_changed_since_export")) {
      res.status(409).json({
        error: {
          code: "dest_repo_changed_since_export",
          message: msg.replace(/^dest_repo_changed_since_export:\s*/, ""),
        },
      });
      return;
    }
    res.status(502).json({ error: { code: "export_failed", message: msg } });
    return;
  }

  if (site) await rememberSiteExport(tenant_id, site, result);
  else await rememberExport(tenant_id, source_full_name, result);

  res.json({
    ok: true,
    exported: result.exported,
    reason: result.exported ? "exported" : result.reason,
    dest: {
      full_name: result.dest_full_name,
      url: result.dest_url,
      branch: result.branch,
      created_repo: result.created_dest_repo,
    },
    file_count: result.file_count,
    commit_sha: result.exported ? result.commit_sha : null,
    up_to_date: await sourceUpToDate(
      { full_name: result.dest_full_name, url: result.dest_url, branch: result.branch, commit_sha: null, source_sha: result.source_sha, file_count: result.file_count, exported_at: "" },
      source_full_name,
    ),
  });
  }
}
