
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { HumanJobsIsland } from "@/components/humans/HumanJobsIsland";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Jobs · Human · Zavi" };

export default async function HumanJobsPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect(`/login?next=${encodeURIComponent("/humans/jobs")}`);
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) {
    redirect("/start");
  }
  return <HumanJobsIsland />;
}
