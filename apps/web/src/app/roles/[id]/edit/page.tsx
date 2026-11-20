
import { cookies } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { apiUrl } from "@/lib/api";
import { createServerSupabase } from "@/lib/supabase";
import { QuestionEditor } from "./QuestionEditor";

export const dynamic = "force-dynamic";

type Q = { id: string; prompt: string; must_ask: boolean; allow_followup: boolean };

type Role = {
  id: string;
  slug: string;
  title: string;
  status: string;
  approved_questions: Q[];
  draft_questions: Q[];
};

async function fetchRole(id: string, accessToken: string | undefined): Promise<Role | null> {
  if (!accessToken) return null;
  try {
    const res = await fetch(apiUrl(`/api/roles/${id}`), {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()).role as Role;
  } catch {
    return null;
  }
}

export default async function EditRolePage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createServerSupabase(await cookies());
  const { data: sess } = await supabase.auth.getSession();
  const accessToken = sess?.session?.access_token;
  const role = await fetchRole(params.id, accessToken);
  if (!role) return <AppShell pageTitle="Not found"><p>Not found.</p></AppShell>;

  return (
    <AppShell pageTitle={role.title}>
      <h1 className="text-2xl font-semibold mb-4">{role.title}</h1>
      <p className="text-base text-slate-500 mb-6">Status: {role.status}</p>
      <QuestionEditor
        roleId={role.id}
        approvedQuestions={role.approved_questions}
        draftQuestions={role.draft_questions}
        publicSlug={role.slug}
      />
    </AppShell>
  );
}
