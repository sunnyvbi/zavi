
import { randomUUID } from "node:crypto";
import { deriveAlias, normalizeEmail } from "./alias";
import { confirmLink, ensureAuthUser } from "./broker";
import type { SiteAuthDirectory } from "./types";

export interface EnsureAdminDeps {
  directory: SiteAuthDirectory;
  aliasKey: () => string;
  newId?: () => string;
}

export async function ensureSiteAdmin(
  deps: EnsureAdminDeps,
  args: { siteId: string; email: string; sendPasswordSetup?: boolean },
): Promise<{ authUserId: string; created: boolean }> {
  const email = normalizeEmail(args.email);
  if (!email) throw new Error("ensureSiteAdmin: invalid email");
  const site = await deps.directory.site(args.siteId);
  if (!site || !site.active) throw new Error("ensureSiteAdmin: site not active");
  const shard = await deps.directory.shard(site.shardId);
  if (!shard) throw new Error("ensureSiteAdmin: shard not found");
  const alias = deriveAlias(deps.aliasKey(), site.siteId, email);
  const uid = deps.newId ? deps.newId() : randomUUID();

  const res = await shard.store.provisionIdentity(site.siteId, email, alias, uid);
  if (res.outcome === "site_unavailable") throw new Error("ensureSiteAdmin: site not active on its shard");
  if (res.outcome === "reserved") throw new Error("ensureSiteAdmin: address is held by an email change");
  if (res.state === "deleting") throw new Error("ensureSiteAdmin: account is being deleted");
  if (res.outcome === "created" || res.state === "unverified") await ensureAuthUser(shard, res.authUserId, alias);
  await shard.store.bootstrapAdmin(site.siteId, res.authUserId);
  if (args.sendPasswordSetup) await shard.gotrue.sendRecovery(alias);
  return { authUserId: res.authUserId, created: res.outcome === "created" };
}

export async function siteOwnerMagicLink(
  deps: EnsureAdminDeps,
  args: { shardId: string; siteId: string; email: string; redirectTo: string },
): Promise<string> {
  const email = normalizeEmail(args.email);
  if (!email) throw new Error("siteOwnerMagicLink: invalid email");
  const site = await deps.directory.site(args.siteId);
  if (!site || !site.active || site.shardId !== args.shardId) throw new Error("siteOwnerMagicLink: site not active on this shard");
  let target: URL;
  try {
    target = new URL(args.redirectTo);
  } catch {
    throw new Error("siteOwnerMagicLink: bad redirect");
  }
  if (target.protocol !== "https:" || target.hostname !== site.hostname) throw new Error("siteOwnerMagicLink: redirect is not the site");
  const shard = await deps.directory.shard(site.shardId);
  if (!shard) throw new Error("siteOwnerMagicLink: shard not found");
  const id = await shard.store.identityByEmail(site.siteId, email);
  if (!id || id.state !== "active" || id.role !== "admin" || id.memberStatus !== "active") {
    throw new Error("siteOwnerMagicLink: not an active admin of this site");
  }
  return confirmLink(site.hostname, "magiclink", await shard.gotrue.magicLinkTokenHash(id.alias));
}

export async function ensureSiteCustomer(
  deps: EnsureAdminDeps,
  args: { siteId: string; email: string; adminEmail: string },
): Promise<{ authUserId: string }> {
  const email = normalizeEmail(args.email);
  const adminEmail = normalizeEmail(args.adminEmail);
  if (!email || !adminEmail) throw new Error("ensureSiteCustomer: invalid email");
  if (email === adminEmail) throw new Error("ensureSiteCustomer: the customer cannot be the admin");
  const site = await deps.directory.site(args.siteId);
  if (!site || !site.active) throw new Error("ensureSiteCustomer: site not active");
  const shard = await deps.directory.shard(site.shardId);
  if (!shard) throw new Error("ensureSiteCustomer: shard not found");
  const admin = await shard.store.identityByEmail(site.siteId, adminEmail);
  if (!admin || admin.state !== "active" || admin.role !== "admin" || admin.memberStatus !== "active") {
    throw new Error("ensureSiteCustomer: the actor is not an active admin of this site");
  }
  const alias = deriveAlias(deps.aliasKey(), site.siteId, email);
  const uid = deps.newId ? deps.newId() : randomUUID();
  const res = await shard.store.memberInviteReserve(site.siteId, admin.authUserId, email, alias, uid, "user");
  if (res.outcome === "held" || !res.authUserId) throw new Error("ensureSiteCustomer: the address is held");
  if (res.outcome === "create") await ensureAuthUser(shard, res.authUserId, alias);
  if (!(await shard.store.memberInviteFinish(site.siteId, admin.authUserId, res.authUserId))) {
    throw new Error("ensureSiteCustomer: the customer did not activate");
  }
  const id = await shard.store.identityByEmail(site.siteId, email);
  if (!id || id.state !== "active" || id.role !== "user" || id.memberStatus !== "active") {
    throw new Error("ensureSiteCustomer: not an active customer of this site");
  }
  return { authUserId: res.authUserId };
}

export async function siteCustomerMagicLink(
  deps: EnsureAdminDeps,
  args: { shardId: string; siteId: string; email: string; redirectTo: string },
): Promise<string> {
  const email = normalizeEmail(args.email);
  if (!email) throw new Error("siteCustomerMagicLink: invalid email");
  const site = await deps.directory.site(args.siteId);
  if (!site || !site.active || site.shardId !== args.shardId) throw new Error("siteCustomerMagicLink: site not active on this shard");
  let target: URL;
  try {
    target = new URL(args.redirectTo);
  } catch {
    throw new Error("siteCustomerMagicLink: bad redirect");
  }
  if (target.protocol !== "https:" || target.hostname !== site.hostname) throw new Error("siteCustomerMagicLink: redirect is not the site");
  const shard = await deps.directory.shard(site.shardId);
  if (!shard) throw new Error("siteCustomerMagicLink: shard not found");
  const id = await shard.store.identityByEmail(site.siteId, email);
  if (!id || id.state !== "active" || id.role !== "user" || id.memberStatus !== "active") {
    throw new Error("siteCustomerMagicLink: not an active customer of this site");
  }
  return confirmLink(site.hostname, "magiclink", await shard.gotrue.magicLinkTokenHash(id.alias));
}

export async function deleteSiteAuthUser(deps: EnsureAdminDeps, args: { shardId: string; authUserId: string }): Promise<void> {
  const shard = await deps.directory.shard(args.shardId);
  if (!shard) throw new Error("deleteSiteAuthUser: shard not found");
  await shard.gotrue.deleteUser(args.authUserId);
}
