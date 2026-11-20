
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { HumanJobDetailIsland } from "@/components/humans/HumanJobDetailIsland";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Job · Human · Zavi" };

export default async function HumanJobPage(
  props: {
    params: Promise<{ orderId: string }>;
    searchParams?: Promise<{ paid?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const here = `/humans/jobs/${encodeURIComponent(params.orderId)}`;
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) redirect(`/login?next=${encodeURIComponent(here)}`);
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) redirect("/start");
  return (
    <HumanJobDetailIsland orderId={params.orderId} justPaid={searchParams?.paid === "1"} />
  );
}
