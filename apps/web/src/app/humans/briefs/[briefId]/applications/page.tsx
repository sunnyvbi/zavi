
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { HumanBriefDetailIsland } from "@/components/humans/HumanBriefDetailIsland";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Brief applications · Human · Zavi" };

export default async function HumanBriefApplicationsPage(
  props: {
    params: Promise<{ briefId: string }>;
  }
) {
  const params = await props.params;
  const here = `/humans/briefs/${encodeURIComponent(params.briefId)}/applications`;
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) redirect(`/login?next=${encodeURIComponent(here)}`);
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) redirect("/start");
  return <HumanBriefDetailIsland briefId={params.briefId} view="applications" />;
}
