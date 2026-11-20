
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";
import { SharedPageViewer } from "@/components/workspace/SharedPageViewer";

export const dynamic = "force-dynamic";

export default async function SharedPagePage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect(`/login?next=${encodeURIComponent(`/pages/${params.id}`)}`);
  }
  return <SharedPageViewer pageId={params.id} />;
}
