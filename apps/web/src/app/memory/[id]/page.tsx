
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { createServerSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { EditorClient } from "../EditorClient";
import { MEMORY_URL } from "@/lib/workspace/tabUrl";

export const dynamic = "force-dynamic";

type NoteRow = {
  id: string;
  title: string;
  body_markdown: string;
  tags: string[];
  source: string;
  source_ref: string | null;
  slug: string | null;
  updated_at: string;
};

export default async function EditMemoryPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createServerSupabase(await cookies());
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) redirect(`/login?next=/memory/${params.id}`);
  const tenant = await fetchActiveTenant(supabase, userData.user.id);
  if (!tenant) redirect("/start");

  const { data } = await supabase
    .from("memory_note")
    .select("id, title, body_markdown, tags, source, source_ref, slug, updated_at")
    .eq("tenant_id", tenant.id)
    .eq("id", params.id)
    .maybeSingle();
  if (!data) notFound();
  const note = data as NoteRow;

  return (
    <AppShell pageTitle={note.title || "Memory note"} tenantName={tenant.displayName} userEmail={userData.user.email ?? undefined}>
      <div className="mb-6">
        <Link href={MEMORY_URL} className="text-[13px] text-skyMuted hover:underline">
          ← Memory
        </Link>
        <h1 className="font-display font-semibold text-[28px] tracking-tight text-slate-900 mt-2">
          {note.title || "(untitled)"}
        </h1>
        <div className="text-[12px] text-slate-500 font-mono mt-1">
          source: {note.source}
          {note.source_ref ? ` · ${note.source_ref}` : ""} · updated {note.updated_at.slice(0, 19)}
        </div>
      </div>
      <div className="max-w-3xl">
        <EditorClient
          initial={{
            id: note.id,
            title: note.title,
            body_markdown: note.body_markdown,
            tags: note.tags,
            slug: note.slug,
          }}
        />
      </div>
    </AppShell>
  );
}
