
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { HumanBriefsIsland } from "@/components/humans/HumanBriefsIsland";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Human · Zavi" };

export default async function HumanHomePage() {
  if (!CREATOR_MARKETPLACE_ENABLED) notFound();
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect(`/login?next=${encodeURIComponent("/humans")}`);
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) {
    redirect("/start");
  }
  return <HumanBriefsIsland />;
}
