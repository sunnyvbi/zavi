
import type { EnsureInput, Provisioner, ProvisionResult, ResourceKind } from "./types";
import { CredentialNotConfigured } from "./github-repo";
import { setResourceSecret } from "./secret";
import { tenantScopedSlug } from "./tenant-slug";

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

type NeonDeps = {
  token?: () => string | null;
  orgId?: () => string | null;
  fetchFn?: FetchLike;
  persistSecret?: (t: string, k: ResourceKind, key: string, val: string) => Promise<string>;
};

const NEON = "https://console.neon.tech/api/v2";
const URI_KEY = "db.connection_uri";

const NEON_LIST_PAGE_SIZE = 100;
const NEON_LIST_MAX_PAGES = 50;

type NeonRole = { name?: string; protected?: boolean };
type NeonDatabase = { name?: string; owner_name?: string };
type NeonBranch = { id?: string; default?: boolean; primary?: boolean };
type NeonCreateBody = {
  project?: { id?: string };
  roles?: NeonRole[];
  databases?: NeonDatabase[];
  branch?: NeonBranch;
};

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };
}

function ensureSslRequire(uri: string): string {
  if (/[?&]sslmode=/i.test(uri)) return uri;
  return `${uri}${uri.includes("?") ? "&" : "?"}sslmode=require`;
}

const MANAGED_READ_ONLY_ROLE = "zavi_readonly";

function pickRole(roles?: NeonRole[], ownerName?: string | null): string | null {
  const named = (roles ?? []).filter(
    (r): r is NeonRole & { name: string } =>
      typeof r.name === "string" && !!r.name && r.name !== MANAGED_READ_ONLY_ROLE,
  );
  if (ownerName && named.some((r) => r.name === ownerName)) return ownerName;
  const owner = named.find((r) => r.protected !== true);
  return owner?.name ?? named[0]?.name ?? null;
}

function pickDatabase(dbs?: NeonDatabase[]): string | null {
  const first = (dbs ?? []).find((d): d is NeonDatabase & { name: string } => typeof d.name === "string" && !!d.name);
  return first?.name ?? null;
}

const NEON_PROJECT_NAME_MAXLEN = 51;

export function neonProjectName(company_name: string, tenant_id: string): string {
  return tenantScopedSlug(company_name, tenant_id, NEON_PROJECT_NAME_MAXLEN);
}

export type FreshDatabaseInput = {
  tenant_id: string;
  existing_ref: Record<string, unknown>;
  database_name: string;
};

export type NeonDbProvisioner = Provisioner & {
  freshDatabase: (input: FreshDatabaseInput) => Promise<ProvisionResult>;
};

function recordedDatabaseName(ref: Record<string, unknown> | null | undefined): string | null {
  const name = ref?.database_name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

export function createNeonDbProvisioner(deps: NeonDeps = {}): NeonDbProvisioner {
  const getToken = deps.token ?? (() => process.env.NEON_API_KEY ?? null);
  const getOrg = deps.orgId ?? (() => process.env.NEON_ORG_ID ?? null);
  const fetchFn = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);
  const persist = deps.persistSecret ?? setResourceSecret;

  async function resolveBranchId(token: string, projectId: string, hint?: NeonBranch): Promise<string | null> {
    if (typeof hint?.id === "string" && hint.id) return hint.id;
    const r = await fetchFn(`${NEON}/projects/${projectId}/branches`, { headers: headers(token) });
    if (r.status !== 200) return null;
    const body = (await r.json()) as { branches?: NeonBranch[] };
    const branches = body.branches ?? [];
    const def = branches.find((b) => b.default === true) ?? branches.find((b) => b.primary === true);
    return (def?.id ?? branches[0]?.id) ?? null;
  }

  async function resolveRoleName(
    token: string,
    projectId: string,
    branchId: string | null,
    hint?: NeonRole[],
    ownerName?: string | null,
  ): Promise<string | null> {
    const fromHint = pickRole(hint, ownerName);
    if (fromHint) return fromHint;
    if (!branchId) return null;
    const r = await fetchFn(`${NEON}/projects/${projectId}/branches/${branchId}/roles`, { headers: headers(token) });
    if (r.status !== 200) return null;
    const body = (await r.json()) as { roles?: NeonRole[] };
    return pickRole(body.roles, ownerName);
  }

  async function resolveDatabaseName(
    token: string,
    projectId: string,
    branchId: string | null,
    hint?: NeonDatabase[],
  ): Promise<string | null> {
    const fromHint = pickDatabase(hint);
    if (fromHint) return fromHint;
    if (!branchId) return null;
    const r = await fetchFn(`${NEON}/projects/${projectId}/branches/${branchId}/databases`, {
      headers: headers(token),
    });
    if (r.status !== 200) return null;
    const body = (await r.json()) as { databases?: NeonDatabase[] };
    return pickDatabase(body.databases);
  }

  async function fetchPooledConnectionUri(
    token: string,
    projectId: string,
    roleName: string,
    databaseName: string,
  ): Promise<string | null> {
    const q = new URLSearchParams({
      role_name: roleName,
      database_name: databaseName,
      pooled: "true",
    }).toString();
    const r = await fetchFn(`${NEON}/projects/${projectId}/connection_uri?${q}`, { headers: headers(token) });
    if (r.status !== 200) return null;
    const body = (await r.json()) as { uri?: string };
    return typeof body.uri === "string" && body.uri ? body.uri : null;
  }

  async function resolveConnectionUri(token: string, projectId: string, hints?: NeonCreateBody): Promise<string | null> {
    const haveRoleHint = pickRole(hints?.roles) !== null;
    const haveDbHint = pickDatabase(hints?.databases) !== null;
    const branchId =
      haveRoleHint && haveDbHint ? null : await resolveBranchId(token, projectId, hints?.branch);

    const databaseName = await resolveDatabaseName(token, projectId, branchId, hints?.databases);
    const ownerName = (hints?.databases ?? []).find((d) => d.name === databaseName)?.owner_name ?? null;
    const roleName = await resolveRoleName(token, projectId, branchId, hints?.roles, ownerName);
    if (!roleName || !databaseName) return null;

    const pooled = await fetchPooledConnectionUri(token, projectId, roleName, databaseName);
    return pooled ? ensureSslRequire(pooled) : null;
  }

  async function resolveAndPersist(
    token: string,
    tenantId: string,
    projectId: string,
    hints?: NeonCreateBody,
  ): Promise<Record<string, string>> {
    const uri = await resolveConnectionUri(token, projectId, hints);
    if (!uri) {
      throw new Error(
        `neon db provisioned (neon_project_id=${projectId}) but the Postgres connection URI ` +
          `could not be resolved (no role/database resolvable, or the connection_uri endpoint ` +
          `returned none) — refusing to return a database-less db resource`,
      );
    }
    return { connection_uri: await persist(tenantId, "db", URI_KEY, uri) };
  }

  async function ensure(input: EnsureInput): Promise<ProvisionResult> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("NEON_API_KEY");
    const org = getOrg();
    const slug = neonProjectName(input.company_name, input.tenant_id);
    const orgQ = org ? `?org_id=${encodeURIComponent(org)}` : "";

    const recorded = input.existing_ref?.neon_project_id;
    if (typeof recorded === "string" && recorded.length > 0) {
      const probe = await fetchFn(`${NEON}/projects/${encodeURIComponent(recorded)}`, {
        headers: headers(token),
      });
      if (probe.status === 200) {
        const recordedDb = recordedDatabaseName(input.existing_ref);
        const vault_keys = await resolveAndPersist(
          token,
          input.tenant_id,
          recorded,
          recordedDb ? await ownedDatabaseHints(token, recorded, recordedDb) : undefined,
        );
        return {
          external_ref: recordedDb ? { neon_project_id: recorded, database_name: recordedDb } : { neon_project_id: recorded },
          vault_keys,
        };
      }
      if (probe.status !== 404) {
        throw new Error(
          `neon project probe failed (${probe.status}) for recorded ${recorded}: ${await probe.text()}`,
        );
      }
      console.warn(
        `[neon-db] recorded project ${recorded} for tenant ${input.tenant_id} is GONE (404) — reprovisioning`,
      );
    }

    let cursor: string | undefined;
    let scanComplete = false;
    let sawUnavailable = false;
    for (let page = 0; page < NEON_LIST_MAX_PAGES; page++) {
      const q = `${orgQ}${orgQ ? "&" : "?"}limit=${NEON_LIST_PAGE_SIZE}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const list = await fetchFn(`${NEON}/projects${q}`, { headers: headers(token) });
      if (list.status !== 200) {
        throw new Error(`neon project list failed (${list.status}): ${await list.text()}`);
      }
      const body = (await list.json()) as {
        projects?: Array<{ id?: string; name?: string }>;
        pagination?: { cursor?: string };
        unavailable_project_ids?: string[];
      };
      const projects = body.projects ?? [];
      if ((body.unavailable_project_ids ?? []).length > 0) sawUnavailable = true;
      const existing = projects.find((p) => p.name === slug);
      if (existing?.id) {
        const vault_keys = await resolveAndPersist(token, input.tenant_id, existing.id);
        return { external_ref: { neon_project_id: existing.id }, vault_keys };
      }
      const next = body.pagination?.cursor;
      if (!next) {
        scanComplete = !sawUnavailable;
        break;
      }
      if (projects.length === 0) {
        scanComplete = !sawUnavailable;
        break;
      }
      if (next === cursor) break;
      cursor = next;
    }

    if (!scanComplete) {
      throw new Error(
        `neon project scan for ${slug} did not complete (stuck cursor or page cap) — refusing to create a possible duplicate`,
      );
    }

    const res = await fetchFn(`${NEON}/projects`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ project: { name: slug, ...(org ? { org_id: org } : {}) } }),
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`neon project create failed (${res.status}): ${await res.text()}`);
    }
    const createBody = (await res.json()) as NeonCreateBody;
    const projectId = createBody.project?.id ?? null;
    if (!projectId) {
      throw new Error("neon project create returned no project id — cannot resolve connection string");
    }

    const vault_keys = await resolveAndPersist(token, input.tenant_id, projectId, createBody);
    return { external_ref: { neon_project_id: projectId }, vault_keys };
  }

  async function teardown(external_ref: Record<string, unknown>): Promise<void> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("NEON_API_KEY");
    const id = String(external_ref.neon_project_id ?? "");
    if (!id) return;
    const res = await fetchFn(`${NEON}/projects/${id}`, { method: "DELETE", headers: headers(token) });
    if (res.status !== 200 && res.status !== 204 && res.status !== 404) {
      throw new Error(`neon project teardown failed (${res.status}): ${await res.text()}`);
    }
  }

  async function ownedDatabaseHints(token: string, projectId: string, databaseName: string): Promise<NeonCreateBody> {
    const branchId = await resolveBranchId(token, projectId);
    if (!branchId) throw new Error(`neon project ${projectId}: no branch resolvable for database ${databaseName}`);
    const r = await fetchFn(`${NEON}/projects/${projectId}/branches/${branchId}/databases`, { headers: headers(token) });
    if (r.status !== 200) throw new Error(`neon database list failed (${r.status}): ${await r.text()}`);
    const owner = (((await r.json()) as { databases?: NeonDatabase[] }).databases ?? []).find(
      (d) => d.name === databaseName,
    )?.owner_name;
    if (!owner) throw new Error(`neon project ${projectId}: recorded database ${databaseName} not found`);
    return { databases: [{ name: databaseName, owner_name: owner }], roles: [{ name: owner }], branch: { id: branchId } };
  }

  async function freshDatabase(input: FreshDatabaseInput): Promise<ProvisionResult> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("NEON_API_KEY");
    const projectId = input.existing_ref.neon_project_id;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("fresh app database: the tenant's db row records no neon_project_id");
    }
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(input.database_name)) {
      throw new Error(`fresh app database: invalid database name ${JSON.stringify(input.database_name)}`);
    }
    const branchId = await resolveBranchId(token, projectId);
    if (!branchId) throw new Error(`fresh app database: no branch resolvable on neon project ${projectId}`);

    const listed = await fetchFn(`${NEON}/projects/${projectId}/branches/${branchId}/databases`, {
      headers: headers(token),
    });
    if (listed.status !== 200) {
      throw new Error(`fresh app database: database list failed (${listed.status}): ${await listed.text()}`);
    }
    const databases = ((await listed.json()) as { databases?: NeonDatabase[] }).databases ?? [];
    const current = recordedDatabaseName(input.existing_ref) ?? pickDatabase(databases);
    const roleName =
      databases.find((d) => d.name === current)?.owner_name ?? (await resolveRoleName(token, projectId, branchId));
    if (!roleName) throw new Error(`fresh app database: no owner role resolvable on neon project ${projectId}`);

    if (!databases.some((d) => d.name === input.database_name)) {
      const created = await fetchFn(`${NEON}/projects/${projectId}/branches/${branchId}/databases`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ database: { name: input.database_name, owner_name: roleName } }),
      });
      if (created.status !== 200 && created.status !== 201) {
        throw new Error(`fresh app database: create failed (${created.status}): ${await created.text()}`);
      }
    }

    const vault_keys = await resolveAndPersist(token, input.tenant_id, projectId, {
      databases: [{ name: input.database_name, owner_name: roleName }],
      roles: [{ name: roleName }],
      branch: { id: branchId },
    });
    return { external_ref: { neon_project_id: projectId, database_name: input.database_name }, vault_keys };
  }

  return { kind: "db", provider: "neon", ensure, teardown, freshDatabase };
}
