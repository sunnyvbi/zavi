import https from "node:https";
import net from "node:net";
import { promises as dns } from "node:dns";
import type { LookupFunction } from "node:net";
import { isPrivateIp } from "@/services/onboarding/enrichment/url-guard";
import { getSetting, setTenantSetting } from "@/services/settings";
import { getCompanyFacts } from "@/services/company/facts";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { builderFromPage, isSiteBuilder, type SiteBuilder } from "./site-builder-markers";

export const SITE_BUILDER_SETTING = "site_builder_detected" as const;
const FRESH_MS = 30 * 24 * 3600 * 1000;
const RETRY_UNKNOWN_MS = 24 * 3600 * 1000;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

type Stored = { builder: SiteBuilder | null; checked_at: string | null };

export type SiteBuilderDeps = {
  now: () => number;
  readStored: (tenantId: string) => Promise<Stored>;
  writeStored: (tenantId: string, v: Stored) => Promise<void>;
  zaviHosts: (tenantId: string) => Promise<string[]>;
  website: (tenantId: string) => Promise<string | null>;
  fetchPage: (url: string, signal: AbortSignal) => Promise<{ html: string; headers: Record<string, string> }>;
  deadlineMs?: number;
};

export async function siteBuilderFor(tenantId: string, deps: SiteBuilderDeps = liveDeps): Promise<SiteBuilder> {
  let stored: Stored = { builder: null, checked_at: null };
  try {
    stored = await deps.readStored(tenantId);
  } catch {
  }
  const at = stored.checked_at ? Date.parse(stored.checked_at) : NaN;
  if (isSiteBuilder(stored.builder) && Number.isFinite(at)) {
    const ttl = stored.builder === "unknown" ? RETRY_UNKNOWN_MS : FRESH_MS;
    if (deps.now() - at < ttl) return stored.builder;
  }
  const builder = await detect(tenantId, deps);
  try {
    await deps.writeStored(tenantId, { builder, checked_at: new Date(deps.now()).toISOString() });
  } catch {
  }
  return builder;
}

async function detect(tenantId: string, deps: SiteBuilderDeps): Promise<SiteBuilder> {
  try {
    const site = await deps.website(tenantId);
    if (!site) return "unknown";
    const url = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
    url.protocol = "https:";
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const zavi = (await deps.zaviHosts(tenantId)).map((h) => h.toLowerCase().replace(/^www\./, ""));
    if (zavi.includes(host)) return "zavi";
    const page = await withDeadline(deps.deadlineMs ?? TIMEOUT_MS, (signal) => deps.fetchPage(url.toString(), signal));
    return builderFromPage(page.html, page.headers);
  } catch {
    return "unknown";
  }
}

export function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error("site check deadline"));
    }, ms);
  });
  return Promise.race([work(ctl.signal), expired]).finally(() => clearTimeout(timer));
}

export function pinnedLookup(resolve: typeof dns.lookup = dns.lookup): LookupFunction {
  return ((hostname: string, options: unknown, cb: (...a: unknown[]) => void) => {
    const callback = typeof options === "function" ? (options as typeof cb) : cb;
    const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    const done = (addrs: Array<{ address: string; family: number }>) => {
      const bad = addrs.find((a) => isPrivateIp(a.address));
      if (!addrs.length || bad) {
        callback(Object.assign(new Error(`blocked address for ${hostname}`), { code: "ESSRFBLOCKED" }));
        return;
      }
      if (wantsAll) callback(null, addrs);
      else callback(null, addrs[0].address, addrs[0].family);
    };
    if (net.isIP(hostname)) {
      done([{ address: hostname, family: net.isIP(hostname) }]);
      return;
    }
    resolve(hostname, { all: true }).then(done, (e: unknown) => callback(e));
  }) as LookupFunction;
}

export function pinnedGet(
  urlStr: string,
  signal?: AbortSignal,
  lookup: LookupFunction = pinnedLookup(),
  hop = 0,
): Promise<{ html: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    if (url.protocol !== "https:") return reject(new Error("https only"));
    if (signal?.aborted) return reject(new Error("aborted"));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isPrivateIp(host)) return reject(new Error(`blocked address for ${host}`));
    const req = https.get(
      url,
      { lookup, signal, timeout: TIMEOUT_MS, headers: { "user-agent": "zavi-site-check/1.0", accept: "text/html" } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (hop >= MAX_REDIRECTS) return reject(new Error("too many redirects"));
          const next = new URL(res.headers.location, url);
          next.protocol = "https:";
          return pinnedGet(next.toString(), signal, lookup, hop + 1).then(resolve, reject);
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers[k] = v;
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const finish = () => resolve({ html: Buffer.concat(chunks).toString("utf8"), headers });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

const liveDeps: SiteBuilderDeps = {
  now: () => Date.now(),
  readStored: async (tenantId) => {
    const v = (await getSetting(SITE_BUILDER_SETTING, tenantId)) as Partial<Stored> | null;
    return { builder: isSiteBuilder(v?.builder) ? v!.builder! : null, checked_at: typeof v?.checked_at === "string" ? v.checked_at : null };
  },
  writeStored: (tenantId, v) => setTenantSetting(tenantId, SITE_BUILDER_SETTING, v, "system:site-builder"),
  website: async (tenantId) => (await getCompanyFacts(tenantId)).website ?? null,
  zaviHosts: async (tenantId) => {
    const client = tenantClient(asTenantId(tenantId));
    const [{ data: rows }, { data: custom }] = await Promise.all([
      client.from("tenant_resources").select("resource_kind, external_ref").in("resource_kind", ["hosting", "domain"]),
      client.from("tenant_custom_domains").select("hostname").eq("status", "verified"),
    ]);
    const hosts: string[] = [];
    for (const r of (rows ?? []) as Array<{ resource_kind: string; external_ref: Record<string, unknown> | null }>) {
      const ref = r.external_ref ?? {};
      if (r.resource_kind === "domain" && ref.status === "live" && typeof ref.hostname === "string") hosts.push(ref.hostname);
      if (r.resource_kind === "hosting" && typeof ref.url === "string") {
        try {
          hosts.push(new URL(ref.url).hostname);
        } catch {
        }
      }
    }
    for (const c of (custom ?? []) as Array<{ hostname?: string }>) if (c.hostname) hosts.push(c.hostname);
    return hosts;
  },
  fetchPage: (url, signal) => pinnedGet(url, signal),
};
