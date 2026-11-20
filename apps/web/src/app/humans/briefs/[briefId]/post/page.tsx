
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { HumanBriefPostIsland } from "@/components/humans/HumanBriefPostIsland";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Post a brief · Human · Zavi" };

export default async function HumanBriefPostPage(
  props: {
    params: Promise<{ briefId: string }>;
  }
) {
  const params = await props.params;
  const here = `/humans/briefs/${encodeURIComponent(params.briefId)}/post`;
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) redirect(`/login?next=${encodeURIComponent(here)}`);
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) redirect("/start");
  return <HumanBriefPostIsland briefId={params.briefId} />;
}
