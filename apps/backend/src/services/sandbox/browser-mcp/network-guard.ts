
import { promises as dns } from "node:dns";
import net from "node:net";
import { isPrivateIp } from "@/services/onboarding/enrichment/url-guard";

export type HostLookup = (host: string) => Promise<string[]>;

const defaultLookup: HostLookup = async (host) => {
  const addrs = await dns.lookup(host, { all: true });
  return addrs.map((a) => a.address);
};

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export type GuardVerdict = { allowed: true } | { allowed: false; reason: string };

export async function checkBrowserRequestUrl(
  rawUrl: string,
  lookup: HostLookup = defaultLookup,
  cache?: Map<string, GuardVerdict>,
): Promise<GuardVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "unparseable_url" };
  }
  if (url.protocol === "data:" || url.protocol === "blob:" || url.href === "about:blank") {
    return { allowed: true };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: `scheme_blocked:${url.protocol}` };
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase().replace(/\.$/, "");
  if (!host) return { allowed: false, reason: "no_host" };
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { allowed: false, reason: "private_hostname" };
  }
  if (net.isIP(host)) {
    return isPrivateIp(host) ? { allowed: false, reason: "private_address" } : { allowed: true };
  }
  const hit = cache?.get(host);
  if (hit) return hit;
  let verdict: GuardVerdict;
  try {
    const addrs = await lookup(host);
    if (addrs.length === 0) verdict = { allowed: false, reason: "dns_empty" };
    else if (addrs.some((a) => isPrivateIp(a))) verdict = { allowed: false, reason: "resolves_private" };
    else verdict = { allowed: true };
  } catch {
    verdict = { allowed: false, reason: "dns_failed" };
  }
  cache?.set(host, verdict);
  return verdict;
}

export interface GuardRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export interface GuardContext {
  route(url: string, handler: (route: GuardRoute) => Promise<void> | void): Promise<void>;
}

export async function installNetworkGuard(
  context: GuardContext,
  opts: { lookup?: HostLookup; onBlock?: (url: string, reason: string) => void } = {},
): Promise<void> {
  const cache = new Map<string, GuardVerdict>();
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    let verdict: GuardVerdict;
    try {
      verdict = await checkBrowserRequestUrl(url, opts.lookup, cache);
    } catch {
      verdict = { allowed: false, reason: "guard_error" };
    }
    if (verdict.allowed) {
      await route.continue();
      return;
    }
    opts.onBlock?.(url, verdict.reason);
    await route.abort("blockedbyclient");
  });
}
