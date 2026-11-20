
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { fetchMyRole, isMember } from "@/lib/members";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { EditorIsland } from "./EditorIsland";
import { workspaceAgentHref } from "@/lib/workspace/tabUrl";

export const dynamic = "force-dynamic";

export default async function AgentEditPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect(`/login?next=/agents/${encodeURIComponent(params.slug)}/edit`);
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) {
    redirect("/start");
  }
  const role = await fetchMyRole(supabase, tenant.id);
  if (isMember(role)) {
    redirect(workspaceAgentHref(params.slug));
  }
  const { data: versions } = await supabase
    .from("tenant_agents")
    .select("version, status, body_markdown, frontmatter, parent_version, created_at")
    .eq("tenant_id", tenant.id)
    .eq("slug", params.slug)
    .order("version", { ascending: false });

  const latest = versions && versions.length > 0 ? versions[0] : null;

  return (
    <AppShell pageTitle={`Edit · ${params.slug}`} tenantName={tenant.displayName} userEmail={userData.user.email ?? undefined}>
      <section className="mb-6">
        <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-skyMuted mb-2">Edit agent</div>
        <h1 className="font-display font-semibold text-[34px] md:text-[40px] tracking-tight text-slate-900 leading-[1.05]">
          {params.slug}
        </h1>
        <div className="mt-3">
          <Link href="/agents" className="text-[13px] text-skyMuted hover:underline">
            ← back to fleet
          </Link>
        </div>
      </section>

      {!latest ? (
        <NotForkedYet slug={params.slug} />
      ) : (
        <EditorIsland
          slug={params.slug}
          initialBody={latest.body_markdown as string}
          initialFrontmatter={(latest.frontmatter ?? {}) as Record<string, unknown>}
          versions={(versions ?? []).map((v) => ({
            version: v.version as number,
            status: v.status as "draft" | "active" | "retired",
            created_at: v.created_at as string,
          }))}
        />
      )}
    </AppShell>
  );
}

function NotForkedYet({ slug }: { slug: string }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="text-[13px] font-semibold text-amber-900 mb-1">Not forked yet</div>
      <p className="text-[13px] text-amber-800 leading-[1.6] mb-3">
        This template hasn't been forked into your tenant yet. Fork it from{" "}
        <Link href="/agents/new" className="underline font-medium">
          /agents/new
        </Link>{" "}
        first, then come back to edit. The forked copy lives at{" "}
        <code className="font-mono text-[12px] bg-amber-100 px-1.5 py-0.5">tenant_agents.{slug}</code>.
      </p>
    </div>
  );
}
