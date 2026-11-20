
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { EmailCampaignCard } from "@/components/email/EmailCampaignCard";
import { CompanyDeepLink } from "@/components/workspace/CompanyDeepLink";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EmailCardPage(props: { params: Promise<{ rail: string; id: string }>; searchParams?: Promise<{ company?: string | string[] }> }) {
  const params = await props.params;
  const wanted = (await props.searchParams)?.company;
  const company = typeof wanted === "string" && UUID.test(wanted) ? wanted : null;
  if ((params.rail !== "channel_actions" && params.rail !== "decisions") || !UUID.test(params.id)) notFound();
  const rail = params.rail === "decisions" ? "decisions" : "channel_actions";
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    const here = `/workspace/email-cards/${params.rail}/${params.id}${company ? `?company=${company}` : ""}`;
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) redirect("/start");
  if (company && company !== tenant.id) {
    return (
      <main className="workspace-shell flex min-h-screen items-center justify-center bg-cream text-[14px] text-inkSoft">
        <CompanyDeepLink holder />
      </main>
    );
  }

  return (
    <div className="workspace-shell min-h-screen bg-cream text-ink">
      <div className="mx-auto max-w-3xl px-4 py-8 mt-[var(--service-banner-h,0px)] md:px-6">
        <Link href="/workspace?tab=channels&channel=email_marketing" className="inline-flex items-center gap-1 rounded-sm text-[14px] text-inkMuted underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30">
          <ChevronLeft aria-hidden className="h-4 w-4" />
          Back to Email campaigns
        </Link>
        <h1 className="mt-3 font-display text-[22px] font-semibold text-ink">Email campaign</h1>
        <div className="mt-4">
          <EmailCampaignCard rail={rail} id={params.id} />
        </div>
      </div>
    </div>
  );
}
