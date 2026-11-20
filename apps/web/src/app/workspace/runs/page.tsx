
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { RunsIsland } from "@/components/workspace/runs/RunsIsland";

export const dynamic = "force-dynamic";

export default async function WorkspaceRunsPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect(`/login?next=${encodeURIComponent("/workspace/runs")}`);
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) {
    redirect("/start");
  }

  return <RunsIsland />;
}
