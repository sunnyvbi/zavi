
import type { BrokerDeps } from "./broker";
import { createDefaultDirectory } from "./directory";
import { createSiteMailer } from "./mailer";
import type { HookDeps } from "./send-email-hook";
import type { SiteAuthDirectory, SiteMailer } from "./types";

export * from "./types";
export { deleteSiteAuthUser, ensureSiteAdmin, ensureSiteCustomer, siteCustomerMagicLink, siteOwnerMagicLink } from "./admin";
export { resumeDeletions, runDeletion } from "./broker";

let directory: SiteAuthDirectory | null = null;
let mailer: SiteMailer | null = null;

function shared() {
  directory ??= createDefaultDirectory();
  mailer ??= createSiteMailer();
  return { directory, mailer };
}

export function siteAuthDirectory(): SiteAuthDirectory {
  directory ??= createDefaultDirectory();
  return directory;
}

export function aliasKeyFromEnv(): string {
  const k = process.env.SITE_AUTH_ALIAS_KEY ?? "";
  if (k.length < 32) throw new Error("SITE_AUTH_ALIAS_KEY is not configured");
  return k;
}

async function siteTurnstileSecret(siteId: string): Promise<string | null> {
  try {
    const { siteShardRpc } = await import("@/services/tenant-client");
    const { data, error } = await siteShardRpc("site_backend_turnstile_secret", { p_site_id: siteId });
    if (error) return null;
    const v = Array.isArray(data) ? data[0] : data;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

export function defaultBrokerDeps(): BrokerDeps {
  return {
    ...shared(),
    turnstileSecret: siteTurnstileSecret,
    aliasKey: aliasKeyFromEnv,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.warn(m),
  };
}

export function siteAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SITE_AUTH_ALIAS_KEY ?? "").length >= 32 && (env.SITE_GATEWAY_BROKER_SECRET ?? "").trim().length >= 32;
}

export function defaultHookDeps(): HookDeps {
  return { ...shared(), now: () => Date.now(), log: (m) => console.warn(m) };
}
