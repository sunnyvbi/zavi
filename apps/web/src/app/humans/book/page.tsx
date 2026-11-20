
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import {
  CreatorBookingIsland,
  type BookingTargetInput,
} from "@/components/humans/CreatorBookingIsland";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Book a creator · Human · Zavi" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function targetFrom(sp: Record<string, string | undefined>): BookingTargetInput | null {
  const found: BookingTargetInput[] = [];
  if (sp.package_id && UUID.test(sp.package_id)) found.push({ package_id: sp.package_id });
  if (sp.offer_id && UUID.test(sp.offer_id)) found.push({ offer_id: sp.offer_id });
  if (sp.application_id && UUID.test(sp.application_id)) {
    found.push({ application_id: sp.application_id });
  }
  return found.length === 1 ? found[0] : null;
}

function withTarget(
  path: string,
  target: BookingTargetInput | null,
  briefId: string | null,
): string {
  if (!target) return path;
  const [key, value] = Object.entries(target)[0] as [string, string];
  const params = new URLSearchParams({ [key]: value });
  if (briefId) params.set("brief_id", briefId);
  return `${path}?${params.toString()}`;
}

export default async function CreatorBookPage(
  props: {
    searchParams?: Promise<{
      package_id?: string;
      offer_id?: string;
      application_id?: string;
      brief_id?: string;
    }>;
  }
) {
  const searchParams = await props.searchParams;
  const target = targetFrom(searchParams ?? {});
  const briefId =
    searchParams?.brief_id && UUID.test(searchParams.brief_id) ? searchParams.brief_id : null;
  const here = withTarget("/humans/book", target, briefId);
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) redirect(`/login?next=${encodeURIComponent(here)}`);
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) redirect("/start");
  if (!target) redirect("/humans/jobs");
  return <CreatorBookingIsland target={target} briefId={briefId} />;
}
