
import { promises as dnsPromises } from "node:dns";
import { registrableDomain } from "./custom-domain-validate";

export type DnsProvider = {
  id: string;
  name: string;
  dashboardUrl?: string;
  guideUrl: string;
};

type ProviderEntry = {
  needles: string[];
  provider: DnsProvider;
};

const PROVIDERS: ProviderEntry[] = [
  {
    needles: ["ns.cloudflare.com"],
    provider: {
      id: "cloudflare",
      name: "Cloudflare",
      dashboardUrl: "https://dash.cloudflare.com/",
      guideUrl: "https://developers.cloudflare.com/dns/manage-dns-records/how-to/",
    },
  },
  {
    needles: ["domaincontrol.com"],
    provider: {
      id: "godaddy",
      name: "GoDaddy",
      guideUrl: "https://www.godaddy.com/help/manage-dns-records-680",
    },
  },
  {
    needles: ["registrar-servers.com"],
    provider: {
      id: "namecheap",
      name: "Namecheap",
      dashboardUrl: "https://ap.www.namecheap.com/domains/list/",
      guideUrl:
        "https://www.namecheap.com/support/knowledgebase/article.aspx/319/2237/how-can-i-set-up-an-a-address-record-for-my-domain/",
    },
  },
  {
    needles: ["squarespacedns.com"],
    provider: {
      id: "squarespace",
      name: "Squarespace",
      guideUrl:
        "https://support.squarespace.com/hc/en-us/articles/360002101888-Adding-DNS-records-to-your-domain",
    },
  },
  {
    needles: ["awsdns"],
    provider: {
      id: "route53",
      name: "AWS Route 53",
      dashboardUrl: "https://console.aws.amazon.com/route53/",
      guideUrl:
        "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html",
    },
  },
  {
    needles: ["vercel-dns.com"],
    provider: {
      id: "vercel",
      name: "Vercel",
      dashboardUrl: "https://vercel.com/dashboard/domains",
      guideUrl: "https://vercel.com/docs/domains/managing-dns-records",
    },
  },
  {
    needles: ["ui-dns."],
    provider: {
      id: "ionos",
      name: "IONOS",
      guideUrl: "https://www.ionos.com/help/domains/dns-settings/",
    },
  },
  {
    needles: ["porkbun.com"],
    provider: {
      id: "porkbun",
      name: "Porkbun",
      guideUrl: "https://kb.porkbun.com/article/68-how-to-edit-dns-records",
    },
  },
];

export function providerFromNameservers(nameservers: readonly string[]): DnsProvider | null {
  const hosts = nameservers.map((n) => n.toLowerCase().replace(/\.$/, "").trim()).filter(Boolean);
  if (hosts.length === 0) return null;
  for (const entry of PROVIDERS) {
    if (hosts.some((h) => entry.needles.some((needle) => h.includes(needle)))) {
      return entry.provider;
    }
  }
  return null;
}

type ResolveNs = (host: string) => Promise<string[]>;

const NS_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error("dns_ns_timeout")), ms);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

export async function detectDnsProvider(
  hostname: string,
  deps: { resolveNs?: ResolveNs } = {},
): Promise<DnsProvider | null> {
  const zone = registrableDomain(hostname);
  if (!zone) return null;
  const resolveNs = deps.resolveNs ?? ((h: string) => dnsPromises.resolveNs(h));
  let nameservers: string[];
  try {
    nameservers = await withTimeout(resolveNs(zone), NS_TIMEOUT_MS);
  } catch {
    return null;
  }
  return providerFromNameservers(nameservers ?? []);
}
