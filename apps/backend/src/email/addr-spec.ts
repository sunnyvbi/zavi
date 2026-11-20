
export type AddrSpec = {
  address: string;
  local: string;
  domain: string;
};

const MAX_ADDRESS = 320;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 255;

export function canonicalizeDomain(raw: string): string | null {
  let d = String(raw ?? "").trim().toLowerCase();
  if (!d) return null;

  while (d.endsWith(".")) d = d.slice(0, -1);
  if (!d) return null;

  if (/[/?#@\\[\]:\s]/.test(d)) return null;

  try {
    const u = new URL(`http://${d}`);
    if (u.hostname !== u.host || u.pathname !== "/" || u.username || u.search || u.hash) {
      return null;
    }
    d = u.hostname;
  } catch {
    return null;
  }
  if (d.length > MAX_DOMAIN) return null;

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;

  return d;
}

export function parseAddrSpec(raw: string | null | undefined): AddrSpec | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > MAX_ADDRESS) return null;

  if (/[\s<>(),;:"\\[\]]/.test(s)) return null;

  const parts = s.split("@");
  if (parts.length !== 2) return null;

  const local = parts[0].toLowerCase();
  if (!local || local.length > MAX_LOCAL) return null;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) return null;

  const domain = canonicalizeDomain(parts[1]);
  if (!domain) return null;

  return { address: `${local}@${domain}`, local, domain };
}

export function domainCoveredBy(child: string, parent: string): boolean {
  const c = canonicalizeDomain(child);
  const p = canonicalizeDomain(parent);
  if (!c || !p) return false;
  return c === p || c.endsWith(`.${p}`);
}
