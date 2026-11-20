
import { randomBytes } from "node:crypto";
import type { EnsureInput, Provisioner, ProvisionResult, ResourceStatus } from "./types";
import { CredentialNotConfigured } from "./github-repo";
import { tenantScopedSlug } from "./tenant-slug";
import { getSecret } from "@/services/secrets/vault";
import { setResourceSecret } from "./secret";
import { realEnqueueDeployTruthDeps } from "@/services/pipeline/deploy-truth";

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

type RenderDeps = {
  token?: () => string | null;
  ownerId?: () => string | null;
  fetchFn?: FetchLike;
  dbUrl?: (tenant_id: string) => Promise<string | null>;
  sessionSecret?: (tenant_id: string) => Promise<SessionSecretResult>;
};

type SessionSecretResult = { value: string; created: boolean };

const RENDER = "https://api.render.com";

const SESSION_SECRET_KEY = "app.session_secret";
const SESSION_SECRET_BYTES = 48;

const DB_RESOLVE_TIMEOUT_MS = 5000;
const DB_RESOLVE_ATTEMPTS = 3;
const DB_RESOLVE_BACKOFF_MS = 250;
const DB_TIMEDOUT = Symbol("db_resolve_timeout");
const DB_ERRORED = Symbol("db_resolve_error");
const ENV_VAR_PUT_ATTEMPTS = 3;
const ENV_VAR_PUT_BACKOFF_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureSslRequire(uri: string): string {
  if (/[?&]sslmode=/i.test(uri)) return uri;
  return `${uri}${uri.includes("?") ? "&" : "?"}sslmode=require`;
}

async function defaultSessionSecret(tenant_id: string): Promise<SessionSecretResult> {
  const existing = await getSecret(tenant_id, SESSION_SECRET_KEY);
  if (existing && existing.length >= 32) return { value: existing, created: false };
  const value = randomBytes(SESSION_SECRET_BYTES).toString("base64url");
  await setResourceSecret(tenant_id, "hosting", SESSION_SECRET_KEY, value);
  return { value, created: true };
}

async function resolveDbUrlWith(
  getDbUrl: (tenant_id: string) => Promise<string | null>,
  tenant_id: string,
  expected: boolean,
): Promise<string | null> {
  const attempts = expected ? DB_RESOLVE_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let caught: Error | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valueP: Promise<string | null | typeof DB_ERRORED> = getDbUrl(tenant_id).catch((e) => {
      caught = e as Error;
      return DB_ERRORED;
    });
    const timeoutP = new Promise<typeof DB_TIMEDOUT>((resolve) => {
      timer = setTimeout(() => resolve(DB_TIMEDOUT), DB_RESOLVE_TIMEOUT_MS);
    });
    const result = await Promise.race([valueP, timeoutP]);
    if (timer) clearTimeout(timer);

    if (typeof result === "string" && result) return result;
    if (result === null && !expected) return null;
    const why =
      result === DB_TIMEDOUT
        ? "timeout"
        : result === DB_ERRORED
          ? ((caught as Error | null)?.message ?? "error")
          : "empty";
    if (expected) {
      // eslint-disable-next-line no-console
      console.warn(
        `[render-hosting] db connection_uri resolve attempt ${attempt}/${attempts} unresolved (${why}) for tenant ${tenant_id}`,
      );
    }
    if (attempt < attempts) await sleep(DB_RESOLVE_BACKOFF_MS);
  }
  return null;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

export function serviceSlug(company_name: string, tenant_id: string): string {
  return tenantScopedSlug(company_name, tenant_id, 51);
}

export function createRenderHostingProvisioner(deps: RenderDeps = {}): Provisioner {
  const getToken = deps.token ?? (() => process.env.RENDER_API_KEY ?? null);
  const getOwner = deps.ownerId ?? (() => process.env.RENDER_OWNER_ID ?? null);
  const fetchFn = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);
  const getDbUrl = deps.dbUrl ?? ((t: string) => getSecret(t, "db.connection_uri"));
  const getSessionSecret = deps.sessionSecret ?? defaultSessionSecret;

  async function upsertEnvVar(token: string, serviceId: string, key: string, value: string): Promise<boolean> {
    for (let attempt = 1; attempt <= ENV_VAR_PUT_ATTEMPTS; attempt++) {
      try {
        const r = await fetchFn(`${RENDER}/v1/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, {
          method: "PUT",
          headers: headers(token),
          body: JSON.stringify({ value }),
        });
        if (r.status === 200 || r.status === 201 || r.status === 204) return true;
        // eslint-disable-next-line no-console
        console.warn(`[render-hosting] env-var upsert failed (${r.status}) for ${key} on ${serviceId}: ${await r.text()}`);
      } catch (e) {
        console.warn(`[render-hosting] env-var upsert threw for ${key} on ${serviceId}: ${(e as Error).message}`);
      }
      if (attempt < ENV_VAR_PUT_ATTEMPTS) await sleep(ENV_VAR_PUT_BACKOFF_MS * attempt);
    }
    return false;
  }

  async function upsertEnvVars(
    token: string,
    serviceId: string,
    envVars: Array<{ key: string; value: string }>,
  ): Promise<string[]> {
    const failed: string[] = [];
    for (const ev of envVars) {
      if (!(await upsertEnvVar(token, serviceId, ev.key, ev.value))) failed.push(ev.key);
    }
    return failed;
  }

  function resolveDbUrl(tenant_id: string, expected: boolean): Promise<string | null> {
    return resolveDbUrlWith(getDbUrl, tenant_id, expected);
  }

  async function triggerDeploy(token: string, serviceId: string): Promise<void> {
    try {
      const r = await fetchFn(`${RENDER}/v1/services/${serviceId}/deploys`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ clearCache: "do_not_clear" }),
      });
      if (r.status !== 200 && r.status !== 201 && r.status !== 202) {
        // eslint-disable-next-line no-console
        console.warn(`[render-hosting] deploy trigger failed (${r.status}) for ${serviceId}: ${await r.text()}`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[render-hosting] deploy trigger threw for ${serviceId}: ${(e as Error).message}`);
    }
  }

  async function ensure(input: EnsureInput): Promise<ProvisionResult> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("RENDER_API_KEY");
    const owner = getOwner();
    if (!owner) throw new CredentialNotConfigured("RENDER_OWNER_ID");

    const repoUrl = String(input.context?.repo_url ?? "");
    if (!repoUrl) {
      throw new Error("render hosting requires a repo (run the repo provisioner first; missing context.repo_url)");
    }
    const slug = serviceSlug(input.company_name, input.tenant_id);
    const dbExpected = typeof input.context?.neon_project_id === "string" && input.context.neon_project_id.length > 0;
    const resolvedDbUrl = await resolveDbUrl(input.tenant_id, dbExpected);
    if (dbExpected && !resolvedDbUrl) {
      throw new Error(
        `render hosting: db resource provisioned (neon_project_id=${String(input.context?.neon_project_id)}) ` +
          `but DATABASE_URL could not be resolved from Vault after ${DB_RESOLVE_ATTEMPTS} attempts — ` +
          `refusing to deploy a database-less app`,
      );
    }
    const dbUrl: string | null = resolvedDbUrl ? ensureSslRequire(resolvedDbUrl) : null;
    let sessionSecretCreated = false;
    const sessionEnvVars: Array<{ key: string; value: string }> = [];
    if (dbUrl) {
      const ss = await getSessionSecret(input.tenant_id);
      sessionSecretCreated = ss.created;
      sessionEnvVars.push({ key: "SESSION_SECRET", value: ss.value });
    }
    const envVars = [
      ...(dbUrl ? [{ key: "DATABASE_URL", value: dbUrl }] : []),
      ...sessionEnvVars,
    ];

    const found = await fetchFn(`${RENDER}/v1/services?name=${encodeURIComponent(slug)}&ownerId=${owner}&limit=1`, {
      headers: headers(token),
    });
    if (found.status === 200) {
      const arr = (await found.json()) as Array<{
        service?: {
          id?: string;
          suspended?: string;
          suspenders?: string[];
          serviceDetails?: { url?: string };
        };
      }>;
      const svc = arr?.[0]?.service;
      if (svc?.id) {
        if (svc.suspended === "suspended") {
          const by = svc.suspenders ?? [];
          if (by.length === 0 || by.some((s) => s !== "user")) {
            throw new Error(`render service ${svc.id} is suspended by Render (${by.join(",") || "unknown"}), not resuming`);
          }
          if (resolvedDbUrl && !dbExpected) {
            throw new Error(`render service ${svc.id} stays suspended: its database was not re-provisioned`);
          }
          const resumed = await fetchFn(`${RENDER}/v1/services/${svc.id}/resume`, {
            method: "POST",
            headers: headers(token),
          });
          if (![200, 202, 204].includes(resumed.status)) {
            throw new Error(`render resume ${svc.id} failed (${resumed.status}): ${await resumed.text()}`);
          }
        }
        const failed = await upsertEnvVars(token, svc.id, envVars);
        if (failed.length > 0) {
          throw new Error(`render hosting: could not set ${failed.join(", ")} on ${svc.id}; refusing to report hosting ready without them`);
        }
        if (dbUrl || sessionSecretCreated) await triggerDeploy(token, svc.id);
        return { external_ref: { render_service_id: svc.id, url: svc.serviceDetails?.url ?? null }, vault_keys: {} };
      }
    } else if (found.status !== 404) {
      throw new Error(`render service lookup failed (${found.status}): ${await found.text()}`);
    }

    const res = await fetchFn(`${RENDER}/v1/services`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        type: "web_service",
        name: slug,
        ownerId: owner,
        repo: repoUrl,
        branch: "main",
        autoDeploy: "yes",
        serviceDetails: {
          env: "node",
          region: "oregon",
          plan: process.env.RENDER_PLAN ?? "free",
          envVars,
          envSpecificDetails: {
            buildCommand: "npm ci && npm run build",
            startCommand: "npm start",
          },
        },
      }),
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`render service create failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as {
      id?: string;
      service?: { id?: string; serviceDetails?: { url?: string } };
      serviceDetails?: { url?: string };
    };
    const id = body.id ?? body.service?.id ?? null;
    let url = body.serviceDetails?.url ?? body.service?.serviceDetails?.url ?? null;
    if (id) {
      const failed = await upsertEnvVars(token, id, envVars);
      if (failed.length > 0) {
        throw new Error(`render hosting: could not set ${failed.join(", ")} on ${id}; refusing to deploy an app without them`);
      }
      if (dbUrl || sessionSecretCreated) await triggerDeploy(token, id);

      if (!url) {
        try {
          const svcRes = await fetchFn(`${RENDER}/v1/services/${id}`, { headers: headers(token) });
          if (svcRes.status === 200) {
            const svc = (await svcRes.json()) as {
              serviceDetails?: { url?: string };
              service?: { serviceDetails?: { url?: string } };
            };
            url = svc.serviceDetails?.url ?? svc.service?.serviceDetails?.url ?? null;
          }
        } catch {
        }
      }
    }
    return { external_ref: { render_service_id: id, url }, vault_keys: {} };
  }

  async function teardown(external_ref: Record<string, unknown>): Promise<void> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("RENDER_API_KEY");
    const id = String(external_ref.render_service_id ?? "");
    if (!id) return;
    const res = await fetchFn(`${RENDER}/v1/services/${id}`, { method: "DELETE", headers: headers(token) });
    if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
      throw new Error(`render service teardown failed (${res.status}): ${await res.text()}`);
    }
  }

  function initialStatus(_result: ProvisionResult): ResourceStatus {
    return "provisioning";
  }

  return { kind: "hosting", provider: "render", ensure, teardown, initialStatus };
}

export class HostingServiceMissingError extends Error {
  constructor(tenant_id: string) {
    super(`attach app database: no provisioned Render service for tenant ${tenant_id}`);
    this.name = "HostingServiceMissingError";
  }
}

export type AttachAppDatabaseDeps = {
  token?: () => string | null;
  fetchFn?: FetchLike;
  resolveServiceId?: (tenant_id: string) => Promise<string | null>;
  dbUrl?: (tenant_id: string) => Promise<string | null>;
  sessionSecret?: (tenant_id: string) => Promise<SessionSecretResult>;
};

export async function attachAppDatabase(
  tenant_id: string,
  deps: AttachAppDatabaseDeps = {},
): Promise<{ render_service_id: string }> {
  const token = (deps.token ?? (() => process.env.RENDER_API_KEY ?? null))();
  if (!token) throw new CredentialNotConfigured("RENDER_API_KEY");
  const fetchFn = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);
  const resolveServiceId = deps.resolveServiceId ?? realEnqueueDeployTruthDeps.resolveHostingServiceId;
  const getDbUrl = deps.dbUrl ?? ((t: string) => getSecret(t, "db.connection_uri"));
  const getSessionSecret = deps.sessionSecret ?? defaultSessionSecret;

  const serviceId = await resolveServiceId(tenant_id);
  if (!serviceId) throw new HostingServiceMissingError(tenant_id);

  const resolved = await resolveDbUrlWith(getDbUrl, tenant_id, true);
  if (!resolved) {
    throw new Error(
      `attach app database: DATABASE_URL could not be resolved from Vault after ${DB_RESOLVE_ATTEMPTS} attempts`,
    );
  }
  const dbUrl = ensureSslRequire(resolved);
  const ss = await getSessionSecret(tenant_id);

  for (const [key, value] of [
    ["DATABASE_URL", dbUrl],
    ["SESSION_SECRET", ss.value],
  ] as const) {
    const r = await fetchFn(`${RENDER}/v1/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify({ value }),
    });
    if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
      throw new Error(`attach app database: env-var PUT ${key} on ${serviceId} failed (${r.status}): ${await r.text()}`);
    }
  }
  return { render_service_id: serviceId };
}
