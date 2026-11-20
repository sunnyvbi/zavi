
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { apiUrl } from "@/lib/api";
import { fetchMyRole, isMember } from "@/lib/members";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { ForkButton } from "./ForkButton";
import { forkableTemplates } from "./templates";

export const dynamic = "force-dynamic";

type AgentRow = {
  slug: string;
  name: string;
  custom?: boolean;
  description: string;
  metadata_praxis: {
    model: string;
    cost_class: string;
    sla_class?: string;
    tools?: string[];
  };
};

async function fetchAgents(accessToken: string | undefined): Promise<AgentRow[]> {
  if (!accessToken) return [];
  try {
    const res = await fetch(apiUrl("/api/agents"), {
      cache: "no-store",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return [];
    const { agents } = (await res.json()) as { agents: AgentRow[] };
    return forkableTemplates(agents);
  } catch {
    return [];
  }
}

export default async function NewAgentPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect("/login?next=/agents/new");
  }
  const { data: sess } = await supabase.auth.getSession();
  const [agents, tenant] = await Promise.all([
    fetchAgents(sess?.session?.access_token),
    fetchActiveTenant(supabase, userData.user.id),
  ]);
  if (tenant) {
    const role = await fetchMyRole(supabase, tenant.id);
    if (isMember(role)) redirect("/workspace");
  }

  return (
    <AppShell pageTitle="New agent" tenantName={tenant?.displayName} userEmail={userData.user.email ?? undefined}>
      <section className="mb-6">
        <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-skyMuted mb-2">Templates</div>
        <h1 className="font-display font-semibold text-[34px] md:text-[40px] tracking-tight text-slate-900 leading-[1.05]">
          Fork a template
        </h1>
        <p className="text-[16px] text-slate-600 mt-3 max-w-2xl leading-[1.6]">
          Each template is production-tested on a live operating company. Fork into your tenant, then tune the prompt
          and tools to match your ops. Your forked copy is private and versioned.
        </p>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {agents.map((a) => (
          <div
            key={a.slug}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-slate-300 transition-colors"
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="font-mono text-[13px] font-semibold text-slate-900">{a.slug}</div>
              <span className="text-[11px] font-mono uppercase tracking-[0.14em] text-slate-500">
                {a.metadata_praxis.cost_class}
              </span>
            </div>
            <div className="text-[16px] font-semibold text-slate-900 mb-1.5">{a.name}</div>
            <p className="text-[13px] text-slate-600 leading-[1.55] mb-4 line-clamp-3">{a.description}</p>
            <div className="flex items-center gap-2 mb-4 text-[11px] font-mono text-slate-500">
              {}
              {a.metadata_praxis.tools && a.metadata_praxis.tools.length > 0 && (
                <span>{a.metadata_praxis.tools.length} tools</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <ForkButton slug={a.slug} />
              <Link
                href={`/agents/${a.slug}`}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:border-slate-300 transition-colors"
              >
                View
              </Link>
            </div>
          </div>
        ))}
        {agents.length === 0 && (
          <div className="col-span-2 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-[16px] text-slate-600 text-center">
            No templates available yet. Finish onboarding to load the day-1 fleet, or check back in a moment.
          </div>
        )}
      </div>
    </AppShell>
  );
}
