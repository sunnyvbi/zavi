
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { HumanEngagementIsland } from "@/components/humans/HumanEngagementIsland";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Engagement · Human · Zavi" };

export default async function HumanEngagementPage(
  props: {
    params: Promise<{ engagementId: string }>;
  }
) {
  const params = await props.params;
  const here = `/humans/engagements/${encodeURIComponent(params.engagementId)}`;
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) redirect(`/login?next=${encodeURIComponent(here)}`);
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) redirect("/start");
  return (
    <HumanEngagementIsland engagementId={params.engagementId} view="work" />
  );
}
