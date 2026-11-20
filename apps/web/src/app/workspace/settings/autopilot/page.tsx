
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { AutopilotWaiverPanel } from "@/components/workspace/settings/AutopilotWaiverPanel";

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsAutopilotPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect(
      `/login?next=${encodeURIComponent("/workspace/settings/autopilot")}`,
    );
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) {
    redirect("/start");
  }

  return (
    <div className="workspace-shell min-h-screen bg-cream text-ink">
    <div className="mx-auto max-w-3xl px-4 py-10 mt-[var(--service-banner-h,0px)] sm:px-6">
      <h1 className="font-display text-[28px] font-semibold tracking-tight text-ink leading-[1.15] md:text-[32px]">
        Autopilot waivers
      </h1>
      <p className="mt-3 text-[16px] text-inkMuted leading-[1.55]">
        Let Zavi run an action without asking you, for a limited time and within a daily
        spend cap. Waivers end on their own and never go beyond 7 days or $100 a day.
      </p>

      <section className="mt-8">
        <AutopilotWaiverPanel />
      </section>
    </div>
    </div>
  );
}
