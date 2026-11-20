import { apiJson } from "../../lib/api";

export type TenantMembership = {
  tenant_id: string;
  slug: string;
  display_name: string;
  role: string;
  website?: string | null;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

export async function fetchMyTenants(): Promise<{ tenants: TenantMembership[] }> {
  const res = await apiJson<{ tenants: TenantMembership[] }>("/api/v1/tenants/mine", { timeoutMs: 20_000 });
  return {
    tenants: res.tenants.map((t) => ({
      ...t,
      display_name: decodeEntities(t.display_name),
    })),
  };
}

export function switchTenant(tenantId: string): Promise<unknown> {
  return apiJson<unknown>("/api/v1/tenants/switch", {
    method: "POST",
    body: JSON.stringify({ tenant_id: tenantId }),
    timeoutMs: 20_000,
  });
}
