
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { EditorClient } from "../EditorClient";
import { MEMORY_URL } from "@/lib/workspace/tabUrl";

export const dynamic = "force-dynamic";

export default async function NewMemoryPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) redirect("/login?next=/memory/new");
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) redirect("/start");

  return (
    <AppShell pageTitle="New memory note" tenantName={tenant.displayName} userEmail={userData.user.email ?? undefined}>
      <div className="mb-6">
        <Link href={MEMORY_URL} className="text-[13px] text-skyMuted hover:underline">
          ← Memory
        </Link>
        <h1 className="font-display font-semibold text-[28px] tracking-tight text-slate-900 mt-2">
          New note
        </h1>
      </div>
      <div className="max-w-3xl">
        <EditorClient initial={{ id: null, title: "", body_markdown: "", tags: [], slug: null }} />
      </div>
    </AppShell>
  );
}
