
import { asTenantId, type TenantId } from "@/services/tenant-client";

export type LogoPreviewClaim = { id: string; free: boolean };
export type LogoPreviewRow = { id: string; site_id: string; svg: string | null };

export type LogoPreviewStore = {
  claim: (tenant_id: string, site_id: string, description: string) => Promise<LogoPreviewClaim>;
  finish: (tenant_id: string, id: string, made: { svg: string; model: string; cost_usd: number }) => Promise<void>;
  drop: (tenant_id: string, id: string) => Promise<void>;
  freeUsed: (tenant_id: string, site_id: string) => Promise<boolean>;
  get: (tenant_id: string, site_id: string, id: string) => Promise<LogoPreviewRow | null>;
};

const UNIQUE_VIOLATION = "23505";
export const STALE_UNFINISHED_MS = 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cleanPreviewId(raw: unknown): string | null {
  const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return UUID_RE.test(id) ? id : null;
}

export function previewDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export function realLogoPreviewStore(): LogoPreviewStore {
  const tc = async (tid: TenantId) => (await import("@/services/tenant-client")).tenantClient(tid);
  const insert = async (tenant_id: string, site_id: string, description: string, free: boolean) =>
    (await tc(asTenantId(tenant_id)))
      .from("site_logo_previews")
      .insert({ site_id, description, free })
      .select("id, free")
      .single();
  return {
    async claim(tenant_id, site_id, description) {
      const stale = await (await tc(asTenantId(tenant_id)))
        .from("site_logo_previews")
        .delete()
        .eq("site_id", site_id)
        .is("svg", null)
        .lt("created_at", new Date(Date.now() - STALE_UNFINISHED_MS).toISOString());
      if (stale.error) throw new Error(stale.error.message);
      const first = await insert(tenant_id, site_id, description, true);
      if (!first.error && first.data) return first.data as LogoPreviewClaim;
      if (first.error?.code !== UNIQUE_VIOLATION) throw new Error(first.error?.message ?? "logo preview claim failed");
      const paid = await insert(tenant_id, site_id, description, false);
      if (paid.error || !paid.data) throw new Error(paid.error?.message ?? "logo preview claim failed");
      return paid.data as LogoPreviewClaim;
    },
    async finish(tenant_id, id, made) {
      const { data, error } = await (await tc(asTenantId(tenant_id)))
        .from("site_logo_previews")
        .update({ svg: made.svg, model: made.model, cost_usd: made.cost_usd })
        .eq("id", id)
        .select("id");
      if (error) throw new Error(error.message);
      if (!data || data.length !== 1) throw new Error("logo preview row is gone");
    },
    async drop(tenant_id, id) {
      const { error } = await (await tc(asTenantId(tenant_id))).from("site_logo_previews").delete().eq("id", id);
      if (error) throw new Error(error.message);
    },
    async freeUsed(tenant_id, site_id) {
      const { data, error } = await (await tc(asTenantId(tenant_id)))
        .from("site_logo_previews")
        .select("id")
        .eq("site_id", site_id)
        .eq("free", true)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data !== null;
    },
    async get(tenant_id, site_id, id) {
      const { data, error } = await (await tc(asTenantId(tenant_id)))
        .from("site_logo_previews")
        .select("id, site_id, svg")
        .eq("site_id", site_id)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? null) as LogoPreviewRow | null;
    },
  };
}
