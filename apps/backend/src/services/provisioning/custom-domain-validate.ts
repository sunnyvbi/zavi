
import net from "node:net";

export type CustomDomainType = "subdomain" | "apex";

export type CustomDomainValidation =
  | { ok: true; hostname: string; domain_type: CustomDomainType }
  | { ok: false; reason: string };

export const RESERVED_SUFFIXES = ["zaviagent.com", "onrender.com", "render.com"] as const;

const MULTI_LABEL_SUFFIXES = new Set([
  "ac.uk", "co.uk", "gov.uk", "ltd.uk", "me.uk", "net.uk", "org.uk", "plc.uk", "sch.uk",
  "com.au", "edu.au", "gov.au", "id.au", "net.au", "org.au",
  "co.nz", "net.nz", "org.nz",
  "co.za", "net.za", "org.za", "web.za",
  "ac.in", "co.in", "edu.in", "firm.in", "gen.in", "gov.in", "ind.in", "net.in", "org.in",
  "com.br", "net.br", "org.br",
  "com.mx", "net.mx", "org.mx",
  "ac.jp", "co.jp", "go.jp", "ne.jp", "or.jp",
  "co.kr", "ne.kr", "or.kr",
  "com.cn", "gov.cn", "net.cn", "org.cn",
  "com.hk", "com.sg", "com.tw", "com.my", "com.ph", "com.vn", "com.pk", "com.bd",
  "co.id", "co.th", "co.il", "co.ke", "co.ma",
  "com.ar", "com.co", "com.pe", "com.uy", "com.ve", "com.ec",
  "com.tr", "com.ua", "com.ru", "com.pl", "com.es", "com.pt", "com.gr", "com.cy",
  "com.eg", "com.sa", "com.ng", "com.gh",
]);

export function classifyDomainType(labels: readonly string[]): CustomDomainType {
  if (labels.length <= 2) return "apex";
  if (labels.length === 3 && MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join("."))) {
    return "apex";
  }
  return "subdomain";
}

export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  if (MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join("."))) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

export function validateCustomDomainHostname(raw: unknown): CustomDomainValidation {
  if (typeof raw !== "string") return { ok: false, reason: "Enter a domain." };
  let input = raw.trim().toLowerCase();
  if (!input) return { ok: false, reason: "Enter a domain." };

  input = input.replace(/^[a-z]+:\/\//, "").split("/")[0].split("?")[0].replace(/\.$/, "");
  if (!input) return { ok: false, reason: "Enter a domain." };

  if (/[\s\\@:]/.test(input)) {
    return { ok: false, reason: "That doesn't look like a valid domain." };
  }

  let host: string;
  try {
    host = new URL(`https://${input}`).hostname;
  } catch {
    return { ok: false, reason: "That doesn't look like a valid domain." };
  }

  if (host.startsWith("[") && host.endsWith("]")) {
    return { ok: false, reason: "Enter a domain name, not an IP address." };
  }
  if (net.isIP(host)) {
    return { ok: false, reason: "Enter a domain name, not an IP address." };
  }
  if (host.length > 253) return { ok: false, reason: "That domain is too long." };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return { ok: false, reason: "That domain isn't publicly reachable." };
  }

  const labels = host.split(".");
  if (labels.length < 2) {
    return { ok: false, reason: "Enter a full domain like yourcompany.com." };
  }
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) {
      return { ok: false, reason: "That doesn't look like a valid domain." };
    }
    if (!/^[a-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
      return { ok: false, reason: "That doesn't look like a valid domain." };
    }
  }
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld)) {
    return { ok: false, reason: "That doesn't look like a valid domain." };
  }

  for (const suffix of RESERVED_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return { ok: false, reason: "That domain belongs to the platform — use a domain you own." };
    }
  }

  return { ok: true, hostname: host, domain_type: classifyDomainType(labels) };
}
