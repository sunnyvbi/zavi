
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { RunDetailIsland } from "@/components/workspace/runs/RunDetailIsland";

export const dynamic = "force-dynamic";

export default async function WorkspaceRunDetailPage(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = await props.params;
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect(`/login?next=${encodeURIComponent(`/workspace/runs/${params.id}`)}`);
  }
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) {
    redirect("/start");
  }

  return <RunDetailIsland runId={params.id} />;
}
