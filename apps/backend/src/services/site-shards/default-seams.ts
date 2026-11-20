
import { zaviStarterProvider } from "@/services/provisioning/templates/vite-react-zavi";
import * as manifestPkg from "@/services/provisioning/templates/vite-react-zavi/manifest";
import {
  defaultBrokerDeps,
  deleteSiteAuthUser,
  ensureSiteAdmin,
  ensureSiteCustomer,
  resumeDeletions,
  siteCustomerMagicLink,
  siteOwnerMagicLink,
} from "@/services/site-auth";
import { pooledAuthFromBroker } from "./auth-config";
import { createSqlSiteImporter } from "./export-v2";
import { createStorageCopier } from "./storage-copy";
import { createShardMgmt, type ShardMgmt } from "./shard-mgmt";
import { defaultKernelPrepDeps, prepareKernelProject } from "./kernel-provision";
import type { SiteManifestPackage } from "./contract";
import type { PooledSeams } from "./facade";

const pkgFns = manifestPkg as unknown as Record<string, unknown>;
export const sharedManifestPackage: SiteManifestPackage = {
  validateManifest: (raw) => manifestPkg.validateManifest(raw),
  diffManifest: (prev, next) => manifestPkg.diffManifest(prev as never, next as never),
  ...(typeof pkgFns.shardCollectionRow === "function"
    ? { shardCollectionRow: pkgFns.shardCollectionRow as NonNullable<SiteManifestPackage["shardCollectionRow"]> }
    : {}),
  ...(typeof pkgFns.siteContractRow === "function"
    ? { siteContractRow: pkgFns.siteContractRow as NonNullable<SiteManifestPackage["siteContractRow"]> }
    : {}),
};

export function kernelPrepConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const https = (v: string | undefined) => /^https:\/\//.test((v ?? "").trim());
  return https(env.SITE_AUTH_HOOK_BASE_URL) && https(env.SITE_AUTH_BROKER_CALLBACK_URL) && !!(env.SUPABASE_MGMT_TOKEN ?? "").trim();
}

export function defaultGraduationSeam(): NonNullable<PooledSeams["graduation"]> {
  let mgmt: ShardMgmt | null = null;
  const sql = { query: (ref: string, q: string) => (mgmt ??= createShardMgmt()).query(ref, q) };
  const serviceKey = async (ref: string) => (await (mgmt ??= createShardMgmt()).apiKeys(ref)).service_role;
  return {
    importer: createSqlSiteImporter({ sql, copyFile: createStorageCopier({ sql, serviceKey }) }),
    prepareKernel: async (i) => {
      await prepareKernelProject(await defaultKernelPrepDeps(), i);
    },
    ready: () => kernelPrepConfigured(),
  };
}

export function defaultPooledSeams(): PooledSeams {
  return {
    graduation: defaultGraduationSeam(),
    manifest: sharedManifestPackage,
    starter: zaviStarterProvider,
    auth: pooledAuthFromBroker({
      ensureSiteAdmin: (a) => ensureSiteAdmin(defaultBrokerDeps(), a),
      ownerMagicLink: (a) => siteOwnerMagicLink(defaultBrokerDeps(), a),
      deleteAuthUser: (a) => deleteSiteAuthUser(defaultBrokerDeps(), a),
      ensureSiteCustomer: (a) => ensureSiteCustomer(defaultBrokerDeps(), a),
      customerMagicLink: (a) => siteCustomerMagicLink(defaultBrokerDeps(), a),
    }),
    resumeDeletions: async (project_ref) => {
      const deps = defaultBrokerDeps();
      const shard = await deps.directory.shard(project_ref);
      if (!shard) throw new Error("shard not resolvable for the auth broker");
      return resumeDeletions(shard, 100, deps.log);
    },
  };
}
