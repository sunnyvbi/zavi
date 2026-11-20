import { DOGFOOD_SLUGS, alertRecipient } from "@/services/tenants/new-tenant-alert";

type Tenant = { slug: string; display_name: string | null; kind: string | null };
export type AppRequestDeps = {
  insertRequest: (tenant_id: string, app_slug: string, user_id: string) => Promise<{ inserted: boolean }>;
  tenant: (tenant_id: string) => Promise<Tenant | null>;
  founderEmail: (user_id: string) => Promise<string | null>;
  countTenants: (app_slug: string) => Promise<number>;
  sgSend: (to: string, subject: string, html: string, text: string) => Promise<void>;
  now: () => Date;
};

export function renderAppRequestEmail(a: { app: string; company: string; tenant_id: string; email: string | null; at: Date; count: number }) {
  const subject = `App request: ${a.app} from ${a.company}`;
  const lines = [
    `App: ${a.app}`,
    `Company: ${a.company} (${a.tenant_id})`,
    `Requested by: ${a.email ?? "unknown"}`,
    `Time: ${a.at.toISOString()}`,
    `Tenants that asked for this app: ${a.count}`,
  ];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return { subject, text: lines.join("\n"), html: `<p>${lines.map(esc).join("<br>")}</p>` };
}

export async function recordAppRequest(
  a: { tenant_id: string; user_id: string; app_slug: string; app_name: string },
  d: AppRequestDeps,
): Promise<{ requested: true; emailed: boolean }> {
  const { inserted } = await d.insertRequest(a.tenant_id, a.app_slug, a.user_id);
  if (!inserted) return { requested: true, emailed: false };
  try {
    const t = await d.tenant(a.tenant_id);
    if (!t || t.kind === "test" || DOGFOOD_SLUGS.has(t.slug)) return { requested: true, emailed: false };
    const [email, count] = await Promise.all([d.founderEmail(a.user_id), d.countTenants(a.app_slug)]);
    const m = renderAppRequestEmail({ app: a.app_name, company: t.display_name ?? t.slug, tenant_id: a.tenant_id, email, at: d.now(), count });
    await d.sgSend(alertRecipient(), m.subject, m.html, m.text);
    return { requested: true, emailed: true };
  } catch {
    return { requested: true, emailed: false };
  }
}

export async function defaultAppRequestDeps(): Promise<AppRequestDeps> {
  const [{ serviceClient }, { sgSend }] = await Promise.all([
    import("@/services/supabase"),
    import("../../email/sendAuthEmail"),
  ]);
  const sb = serviceClient();
  return {
    insertRequest: async (tenant_id, app_slug, user_id) => {
      const { data, error } = await sb
        .from("connector_app_requests")
        .upsert({ tenant_id, app_slug, requested_by: user_id }, { onConflict: "tenant_id,app_slug", ignoreDuplicates: true })
        .select("app_slug");
      if (error) throw new Error(error.message);
      return { inserted: (data ?? []).length > 0 };
    },
    tenant: async (id) =>
      (await sb.from("tenants").select("slug, display_name, kind").eq("id", id).maybeSingle()).data as Tenant | null,
    founderEmail: async (uid) => (await sb.auth.admin.getUserById(uid)).data.user?.email ?? null,
    countTenants: async (slug) =>
      (
        await sb
          .from("connector_app_requests")
          .select("tenant_id, tenants!inner(kind, slug)", { count: "exact", head: true })
          .eq("app_slug", slug)
          .neq("tenants.kind", "test")
          .not("tenants.slug", "in", `(${[...DOGFOOD_SLUGS].join(",")})`)
      ).count ?? 0,
    sgSend: async (to, subject, html, text) => { await sgSend(to, subject, html, text); },
    now: () => new Date(),
  };
}
