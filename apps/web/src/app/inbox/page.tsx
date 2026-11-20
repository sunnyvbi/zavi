
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { MemoryInboxClient } from "@/components/workspace/MemoryInboxClient";

export const dynamic = "force-dynamic";

export default async function MemoryInboxPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect(`/login?next=${encodeURIComponent("/inbox")}`);
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) {
    redirect("/start");
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-display text-[28px] font-semibold tracking-tight text-ink leading-[1.15] md:text-[32px]">
        Memory Inbox
      </h1>
      <p className="mt-3 text-[16px] text-inkMuted leading-[1.55]">
        Everything Zavi captures lands here first. Approve a card to save the fact to your company brain, or ignore
        it. Zavi listens, but only remembers what you bless.
      </p>
      <section className="mt-8">
        <MemoryInboxClient />
      </section>
    </div>
  );
}
