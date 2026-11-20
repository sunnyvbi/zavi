
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { PlaybooksClient } from "@/components/workspace/PlaybooksClient";

export const dynamic = "force-dynamic";

export default async function PlaybooksPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect(`/login?next=${encodeURIComponent("/playbooks")}`);
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) {
    redirect("/start");
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-display text-[28px] font-semibold tracking-tight text-ink leading-[1.15] md:text-[32px]">
        Playbooks
      </h1>
      <p className="mt-3 text-[16px] text-inkMuted leading-[1.55]">
        One-click jobs your AI team runs end-to-end. Launch one, and the agents do the work and bring you a decision to
        approve. Nothing happens to your data, ads, or customers until you say so.
      </p>
      <section className="mt-8">
        <PlaybooksClient />
      </section>
    </div>
  );
}
