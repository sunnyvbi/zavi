
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { FindCreatorsIsland } from "@/components/humans/FindCreatorsIsland";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Find creators · Zavi" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FindCreatorsPage(
  props: {
    searchParams: Promise<{ creator?: string; package?: string; brief_id?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    const brief = typeof searchParams.brief_id === "string" ? searchParams.brief_id : "";
    const here = brief
      ? `/humans/creators?brief_id=${encodeURIComponent(brief)}`
      : "/humans/creators";
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) {
    redirect("/start");
  }
  return (
    <FindCreatorsIsland
      preselectedCreator={searchParams.creator}
      preselectedPackage={searchParams.package}
      briefId={
        searchParams.brief_id && UUID.test(searchParams.brief_id) ? searchParams.brief_id : null
      }
    />
  );
}
