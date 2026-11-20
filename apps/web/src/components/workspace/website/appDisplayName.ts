const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const SANDBOX_HOST = /\.e2b\.(app|dev)$/;
const ZAVI_BUILT_HOST = /\.(zaviagent\.com|onrender\.com)$/;
const TENANT_SUFFIX = /^(.+?)-[0-9a-f]{8}(?:-[0-9a-f]{6})?(?:-dev)?$/;

function hostLabel(host: string | null | undefined): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase();
  if (!h) return null;
  if (h.includes("://")) h = h.slice(h.indexOf("://") + 3);
  h = h.split("/")[0].split("?")[0].split("#")[0];
  h = h.split("@").pop() ?? h;
  h = h.replace(/:\d+$/, "");
  if (!h || h === "localhost" || IPV4.test(h) || SANDBOX_HOST.test(h)) return null;
  while (h.startsWith("www.")) h = h.slice(4);
  const label = h.split(".")[0];
  if (!label) return null;
  const scoped = ZAVI_BUILT_HOST.test(h) ? TENANT_SUFFIX.exec(label) : null;
  return scoped ? scoped[1] : label;
}

function titleCase(raw: string): string {
  return raw
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function appDisplayName(
  host: string | null | undefined,
  tenantName?: string | null,
): string | null {
  const name = hostLabel(host) ?? tenantName?.trim();
  if (!name) return null;
  const shown = titleCase(name);
  return shown || null;
}
