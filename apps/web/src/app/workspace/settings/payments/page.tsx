
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { PaymentsPanel } from "@/components/workspace/settings/PaymentsPanel";

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPaymentsPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect(`/login?next=${encodeURIComponent("/workspace/settings/payments")}`);
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) {
    redirect("/start");
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 mt-[var(--service-banner-h,0px)]">
      <h1 className="font-display text-[28px] font-semibold tracking-tight text-ink leading-[1.15] md:text-[32px]">
        Payments
      </h1>
      <p className="mt-3 text-[16px] text-inkMuted leading-[1.55]">
        Set up how your workspace gets paid. Choose a money model and connect a Stripe payout
        account so you can collect from your customers.
      </p>

      <section className="mt-8">
        <PaymentsPanel />
      </section>
    </div>
  );
}
