
import { createHash, randomBytes } from "node:crypto";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { setResourceSecret } from "@/services/provisioning/secret";
import { getSecret } from "@/services/secrets/vault";
import { siteStore } from "./store";
import {
  SITE_PROJECT_DELETE_GRACE_DAYS,
  siteVaultKey,
  type SiteProviderKind,
  type SiteProviderState,
  type SiteRow,
  type SiteStore,
  type SupabaseSiteProvisioner,
  type SupabaseSiteRef,
} from "./contract";
import { createSupabaseMgmt, projectUrl, SiteDeleteRefused, type SupabaseMgmt } from "./supabase-mgmt";
import { defaultSiteDeleteGuard, reportDeleteRefusal, takeDeleteSlot, type SiteDeleteGuard } from "./delete-guard";
import { catalogAssertionSql, catalogProblems, ROLE_FINGERPRINT_SQL, siteCatalogCheckSql } from "./site-catalog-check";
import { rowGuardAssertSql, rowGuardSnapshotSql } from "./site-row-guard";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MIGRATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const EMAIL_RE = /^[^\s@"\\<>]{1,64}@[^\s@"'\\<>]{1,255}$/;

export const PROJECT_HEALTH_TIMEOUT_MS = 4 * 60_000;
export const PROJECT_POLL_MS = 5_000;
const MAX_USER_PAGES = 50;
const USERS_PER_PAGE = 200;

export const MIGRATION_LEDGER = "zavi._zavi_migrations";

export function siteProjectName(site_id: string): string {
  if (!UUID_RE.test(site_id)) throw new Error("invalid site id");
  return `zs-${site_id.toLowerCase()}`;
}

class SiteDeleteAborted extends Error {
  constructor() {
    super("site project delete aborted: provider row changed");
    this.name = "SiteDeleteAborted";
  }
}

export class SiteMigrationChecksumMismatch extends Error {
  constructor(public migration_id: string) {
    super(`site migration '${migration_id}' was already applied with different contents; add a new migration instead of editing an applied one`);
    this.name = "SiteMigrationChecksumMismatch";
  }
}

export type ProviderRow = {
  state: SiteProviderState;
  ref: Record<string, unknown>;
  scheduled_delete_at?: string | null;
};

export type SiteVault = {
  get(tenant_id: string, key: string): Promise<string | null>;
  set(tenant_id: string, key: string, value: string): Promise<void>;
};

export type SupabaseSiteProvisionerDeps = {
  mgmt: () => SupabaseMgmt;
  store: SiteStore;
  vault: SiteVault;
  providerRow: (tenant_id: string, site_id: string, kind: SiteProviderKind) => Promise<ProviderRow | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  newPassword: () => string;
  deleteGuard: SiteDeleteGuard;
  healthTimeoutMs?: number;
  pollMs?: number;
  log?: (msg: string) => void;
};

function defaultDeps(): SupabaseSiteProvisionerDeps {
  let mgmt: SupabaseMgmt | null = null;
  return {
    mgmt: () => (mgmt ??= createSupabaseMgmt()),
    store: siteStore(),
    vault: {
      get: (t, k) => getSecret(t, k),
      set: async (t, k, v) => {
        await setResourceSecret(t, "db", k, v);
      },
    },
    providerRow: async (tenant_id, site_id, kind) => {
      const { data, error } = await (tenantClient(asTenantId(tenant_id)).from("site_providers").select("state, ref, scheduled_delete_at") as any)
        .eq("site_id", site_id)
        .eq("kind", kind)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`site_providers read failed: ${error.message ?? "unknown error"}`);
      return (data as ProviderRow | null) ?? null;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    newPassword: () => randomBytes(24).toString("base64url"),
    deleteGuard: defaultSiteDeleteGuard(),
    log: (m) => console.warn(m),
  };
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function isRedirectUnderHost(redirect: string, hostname: string): boolean {
  let u: URL;
  try {
    u = new URL(redirect);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.username === "" &&
    u.password === "" &&
    u.port === "" &&
    u.hostname.toLowerCase() === hostname.toLowerCase()
  );
}

export function createSupabaseSiteProvisioner(
  overrides: Partial<SupabaseSiteProvisionerDeps> = {},
): SupabaseSiteProvisioner {
  const d: SupabaseSiteProvisionerDeps = { ...defaultDeps(), ...overrides };
  const log = d.log ?? (() => {});
  const healthTimeout = d.healthTimeoutMs ?? PROJECT_HEALTH_TIMEOUT_MS;
  const pollMs = d.pollMs ?? PROJECT_POLL_MS;

  async function loadSite(tenant_id: string, site_id: string): Promise<SiteRow> {
    if (!UUID_RE.test(site_id)) throw new Error("invalid site id");
    const site = await d.store.get(tenant_id, site_id);
    if (!site) throw new Error("site not found for this workspace");
    return site;
  }

  function requireRef(site: SiteRow): string {
    if (!site.supabase_project_ref) throw new Error("site has no Supabase project yet");
    return site.supabase_project_ref;
  }

  async function waitHealthy(mgmt: SupabaseMgmt, ref: string): Promise<void> {
    const deadline = d.now() + healthTimeout;
    for (;;) {
      if (await mgmt.isHealthy(ref).catch(() => false)) return;
      if (d.now() >= deadline) throw new Error("Supabase project did not become healthy in time");
      await d.sleep(pollMs);
    }
  }

  async function findByName(mgmt: SupabaseMgmt, name: string): Promise<string | null> {
    const found = await mgmt.listProjectsByName(name);
    if (found.length > 1) log(`[sites] ${found.length} Supabase projects share the name ${name}; rebinding the first`);
    return found[0]?.ref ?? null;
  }

  async function dbPassword(tenant_id: string, site_id: string): Promise<string> {
    const key = siteVaultKey.dbPassword(site_id);
    const existing = await d.vault.get(tenant_id, key);
    if (existing) return existing;
    const pw = d.newPassword();
    await d.vault.set(tenant_id, key, pw);
    return pw;
  }

  async function serviceRoleKey(mgmt: SupabaseMgmt, tenant_id: string, site: SiteRow): Promise<string> {
    const stored = await d.vault.get(tenant_id, siteVaultKey.serviceRole(site.id));
    if (stored) return stored;
    const keys = await mgmt.apiKeys(requireRef(site));
    await d.vault.set(tenant_id, siteVaultKey.serviceRole(site.id), keys.service_role);
    await d.vault.set(tenant_id, siteVaultKey.anon(site.id), keys.anon);
    return keys.service_role;
  }

  async function recordProvider(
    tenant_id: string,
    site_id: string,
    state: SiteProviderState,
    ref: Record<string, unknown>,
  ): Promise<void> {
    const row = await d.providerRow(tenant_id, site_id, "supabase_project");
    if (!row) return;
    await d.store.setProviderState(tenant_id, site_id, "supabase_project", state, ref);
  }

  return {
    async ensureProject({ tenant_id, site_id }): Promise<SupabaseSiteRef> {
      const site = await loadSite(tenant_id, site_id);
      const mgmt = d.mgmt();
      const name = siteProjectName(site.id);

      let ref = site.supabase_project_ref;
      if (!ref) {
        const prior = await d.providerRow(tenant_id, site.id, "supabase_project");
        const priorRef = typeof prior?.ref?.project_ref === "string" ? (prior.ref.project_ref as string) : null;
        if (priorRef) {
          ref = priorRef;
        } else {
          await d.store.claimProvider(tenant_id, site.id, "supabase_project", { name });
          if (prior) ref = await findByName(mgmt, name);
          if (!ref) {
            const dbPass = await dbPassword(tenant_id, site.id);
            try {
              ref = (await mgmt.createProject({ name, dbPass })).ref;
            } catch (e) {
              ref = await findByName(mgmt, name).catch(() => null);
              if (!ref) throw e;
            }
          }
        }
        await d.store.setProviderState(tenant_id, site.id, "supabase_project", "created", { name, project_ref: ref });
        await d.store.update(tenant_id, site.id, { supabase_project_ref: ref });
      }

      await waitHealthy(mgmt, ref);

      const keys = await mgmt.apiKeys(ref);
      await d.vault.set(tenant_id, siteVaultKey.serviceRole(site.id), keys.service_role);
      await d.vault.set(tenant_id, siteVaultKey.anon(site.id), keys.anon);

      const url = projectUrl(ref);
      if (site.supabase_url !== url) await d.store.update(tenant_id, site.id, { supabase_url: url });
      return { project_ref: ref, url };
    },

    async configureAuth({ tenant_id, site_id, site_url }) {
      const site = await loadSite(tenant_id, site_id);
      if (!isRedirectUnderHost(site_url, site.hostname)) {
        throw new Error("site_url must be the site's own https hostname");
      }
      await d.mgmt().updateAuthConfig(requireRef(site), {
        site_url: `https://${site.hostname}`,
        uri_allow_list: `https://${site.hostname}/**`,
      });
    },

    async applySql({ tenant_id, site_id, migration_id, sql, guard, preserveExistingRows }) {
      if (!MIGRATION_ID_RE.test(migration_id)) throw new Error("invalid migration id");
      const site = await loadSite(tenant_id, site_id);
      const ref = requireRef(site);
      const mgmt = d.mgmt();
      const sha = sha256Hex(sql);
      if (!SHA256_RE.test(sha)) throw new Error("checksum failed");

      await mgmt.query(
        ref,
        [
          "create schema if not exists zavi;",
          "revoke all on schema zavi from public;",
          `create table if not exists ${MIGRATION_LEDGER} (id text primary key, sha256 text not null, applied_at timestamptz not null default now());`,
        ].join("\n"),
      );

      const rows = (await mgmt.query(ref, `select sha256 from ${MIGRATION_LEDGER} where id = '${migration_id}';`)) as Array<{
        sha256?: string;
      }>;
      const recorded = rows[0]?.sha256;
      if (recorded) {
        if (recorded !== sha) throw new SiteMigrationChecksumMismatch(migration_id);
        return "skipped";
      }
      guard?.(sql);

      const roles = (await mgmt.query(ref, ROLE_FINGERPRINT_SQL)) as Array<{ f?: unknown }>;
      const rolesBefore = typeof roles[0]?.f === "string" ? roles[0].f : "";
      const assertion = catalogAssertionSql(rolesBefore, randomBytes(12).toString("hex"));
      const rowTag = randomBytes(8).toString("hex");
      const before = preserveExistingRows ? `${rowGuardSnapshotSql(rowTag)}\n` : "";
      const after = preserveExistingRows ? `\n${rowGuardAssertSql(rowTag)}` : "";
      await mgmt.query(
        ref,
        `${before}${sql}\n;\nset constraints all immediate;\n${assertion}\ninsert into ${MIGRATION_LEDGER} (id, sha256) values ('${migration_id}', '${sha}');${after}`,
      );
      return "applied";
    },

    async verifyCatalog({ tenant_id, site_id }) {
      const site = await loadSite(tenant_id, site_id);
      const ref = requireRef(site);
      return catalogProblems(await d.mgmt().query(ref, siteCatalogCheckSql()));
    },

    async ensureOwnerAdmin({ tenant_id, site_id, owner_email }) {
      const email = String(owner_email ?? "").trim();
      if (!EMAIL_RE.test(email)) throw new Error("invalid owner email");
      const site = await loadSite(tenant_id, site_id);
      const ref = requireRef(site);
      const mgmt = d.mgmt();
      const admin = mgmt.authAdmin(ref, await serviceRoleKey(mgmt, tenant_id, site));

      let userId: string | null = null;
      const created = await admin.createUser(email);
      if ("user" in created) {
        userId = created.user.id;
      } else {
        const want = email.toLowerCase();
        for (let page = 1; page <= MAX_USER_PAGES && !userId; page++) {
          const users = await admin.listUsers(page, USERS_PER_PAGE);
          userId = users.find((u) => (u.email ?? "").toLowerCase() === want)?.id ?? null;
          if (users.length < USERS_PER_PAGE) break;
        }
        if (!userId) throw new Error("owner is registered but could not be found");
      }

      if (!UUID_RE.test(userId)) throw new Error("owner user id is not a uuid");
      const updated = (await mgmt.query(
        ref,
        `update public.profiles set role = 'admin' where id = '${userId.toLowerCase()}'::uuid returning role;`,
      )) as Array<{ role?: string }>;
      if (updated[0]?.role !== "admin") throw new Error("owner profile row is missing");
      return { user_id: userId.toLowerCase() };
    },

    async ownerMagicLink({ tenant_id, site_id, owner_email, redirect_to }) {
      const email = String(owner_email ?? "").trim();
      if (!EMAIL_RE.test(email)) throw new Error("invalid owner email");
      const site = await loadSite(tenant_id, site_id);
      if (!isRedirectUnderHost(redirect_to, site.hostname)) {
        throw new Error("magic link redirect must stay on the site's hostname");
      }
      const mgmt = d.mgmt();
      const admin = mgmt.authAdmin(requireRef(site), await serviceRoleKey(mgmt, tenant_id, site));
      return admin.generateMagicLink(email, redirect_to);
    },

    async pause({ tenant_id, site_id }) {
      const site = await loadSite(tenant_id, site_id);
      if (!site.supabase_project_ref) return "no_project";
      const mgmt = d.mgmt();
      const ref = site.supabase_project_ref;
      const p = await mgmt.getProject(ref);
      if (!p) return "no_project";
      if (p.status !== "INACTIVE" && p.status !== "PAUSING") {
        const r = await mgmt.pause(ref);
        if (r === "not_found") return "no_project";
        if (r === "unsupported") return "unsupported";
      }
      await recordProvider(tenant_id, site.id, "created", { paused: true, paused_at: new Date(d.now()).toISOString() });
      return "paused";
    },

    async restore({ tenant_id, site_id }) {
      const site = await loadSite(tenant_id, site_id);
      const ref = requireRef(site);
      const mgmt = d.mgmt();
      const p = await mgmt.getProject(ref);
      if (!p) throw new Error("Supabase project is gone");
      if (p.status === "INACTIVE") {
        const r = await mgmt.restore(ref);
        if (r === "not_found") throw new Error("Supabase project is gone");
      }
      await waitHealthy(mgmt, ref);
      await recordProvider(tenant_id, site.id, "created", { paused: false });
    },

    async teardown({ tenant_id, site_id }) {
      const site = await loadSite(tenant_id, site_id);
      const row = await d.providerRow(tenant_id, site.id, "supabase_project");
      if (row?.state === "deleted") return "absent";
      if (row?.state === "delete_scheduled" || row?.state === "delete_issuing") return "scheduled";
      if (row?.ref?.retained === true) return "retained";
      const mgmt = d.mgmt();
      const rowRef = typeof row?.ref?.project_ref === "string" ? (row.ref.project_ref as string) : null;
      const ref = site.supabase_project_ref ?? rowRef ?? (await findByName(mgmt, siteProjectName(site.id)));
      if (!ref) {
        await recordProvider(tenant_id, site.id, "deleted", {});
        return "absent";
      }
      if (!row) throw new Error("site has a Supabase project but no supabase_project claim");
      if (!(await takeDeleteSlot(d.deleteGuard, "schedule", { tenant_id, site_id: site.id }))) return "refused";
      const p = await mgmt.getProject(ref);
      if (p && p.status !== "INACTIVE" && p.status !== "PAUSING") await mgmt.pause(ref);
      await d.store.scheduleProviderDelete(tenant_id, site.id, "supabase_project", SITE_PROJECT_DELETE_GRACE_DAYS, {
        project_ref: ref,
        paused: true,
        delete_requested_at: new Date(d.now()).toISOString(),
      });
      return "scheduled";
    },

    async purge({ tenant_id, site_id }) {
      const site = await loadSite(tenant_id, site_id);
      const row = await d.providerRow(tenant_id, site.id, "supabase_project");
      if (!row || (row.state !== "delete_scheduled" && row.state !== "delete_issuing")) return "not_scheduled";
      const issuing = row.state === "delete_issuing";
      if (!issuing) {
        const due = Date.parse(String(row.scheduled_delete_at ?? ""));
        if (!Number.isFinite(due) || due > d.now()) return "not_due";
      }

      const ref = typeof row.ref?.project_ref === "string" ? (row.ref.project_ref as string) : site.supabase_project_ref;
      const ctx = { tenant_id, site_id: site.id };
      if (!ref) {
        await reportDeleteRefusal(d.deleteGuard, "sites.delete.name_mismatch", { ...ctx, detail: "reason=no_project_ref" });
        return "refused";
      }
      if (!(await takeDeleteSlot(d.deleteGuard, "execute", ctx))) return "refused";

      const mgmt = d.mgmt();
      try {
        await mgmt.deleteSiteProject(ref, siteProjectName(site.id), async () => {
          if (!(await d.store.beginProviderDelete(tenant_id, site.id, "supabase_project", row.state as "delete_scheduled" | "delete_issuing"))) {
            throw new SiteDeleteAborted();
          }
        });
      } catch (e) {
        if (e instanceof SiteDeleteAborted) {
          log(`[sites] hard delete of tenant=${tenant_id} site=${site.id} aborted: its provider row changed (cancelled?) before the DELETE`);
          return "not_scheduled";
        }
        if (!(e instanceof SiteDeleteRefused)) throw e;
        const ours = e.reason === "not_found" && issuing;
        if (!ours) {
          await reportDeleteRefusal(d.deleteGuard, "sites.delete.name_mismatch", { ...ctx, detail: `reason=${e.reason} ref=${ref}` });
          return "refused";
        }
      }
      await d.store.setProviderState(tenant_id, site.id, "supabase_project", "deleted", {
        project_ref: ref,
        hard_deleted_at: new Date(d.now()).toISOString(),
      });
      return "deleted";
    },

    async cancelDeletion({ tenant_id, site_id }) {
      const site = await loadSite(tenant_id, site_id);
      const row = await d.providerRow(tenant_id, site.id, "supabase_project");
      const retained = row?.state === "created" && row.ref?.retained === true;
      if (!row || (row.state !== "delete_scheduled" && !retained)) return "not_scheduled";
      const ref = typeof row.ref?.project_ref === "string" ? (row.ref.project_ref as string) : site.supabase_project_ref;
      if (row.state === "delete_scheduled") {
        const cancelled = await d.store.cancelProviderDelete(tenant_id, site.id, "supabase_project", {
          retained: true,
          delete_cancelled_at: new Date(d.now()).toISOString(),
        });
        if (!cancelled) {
          const now = await d.providerRow(tenant_id, site.id, "supabase_project");
          if (!(now?.state === "created" && now.ref?.retained === true)) return "not_scheduled";
        }
      }
      if (ref) {
        const mgmt = d.mgmt();
        const p = await mgmt.getProject(ref);
        if (!p) throw new Error("Supabase project is gone");
        if (p.status === "INACTIVE") {
          if ((await mgmt.restore(ref)) === "not_found") throw new Error("Supabase project is gone");
        }
        await d.store.setProviderState(tenant_id, site.id, "supabase_project", "created", { paused: false });
      }
      return "restored";
    },
  };
}

let _provisioner: SupabaseSiteProvisioner | null = null;
export function supabaseSiteProvisioner(): SupabaseSiteProvisioner {
  return (_provisioner ??= createSupabaseSiteProvisioner());
}

export async function cancelSiteProjectDeletion(
  tenant_id: string,
  site_id: string,
  provisioner: Pick<SupabaseSiteProvisioner, "cancelDeletion"> = supabaseSiteProvisioner(),
): Promise<"restored" | "not_scheduled"> {
  return provisioner.cancelDeletion({ tenant_id, site_id });
}
