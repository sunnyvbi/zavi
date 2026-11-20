
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AccountSecurityPanel } from "@/components/account/AccountSecurityPanel";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect(`/login?next=${encodeURIComponent("/account")}`);
  }
  const user = userData.user;

  const tenant = await fetchActiveTenant(supabase, user.id);
  if (tenant) {
    redirect("/workspace?tab=settings&section=account");
  }

  const email = user.email ?? "-";

  return (
    <AppShell pageTitle="Account" userEmail={email}>
      <div className="mx-auto w-full max-w-[720px]">
        <section id="account" className="mt-1">
          <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">Account</h2>
          <p className="mb-4 text-[16px] text-inkMuted leading-[1.55]">
            Your own sign-in, separate from any workspace. Only you can change it.
          </p>
          <AccountSecurityPanel email={email} />
        </section>
      </div>
    </AppShell>
  );
}
