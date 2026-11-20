
import { cookies } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { apiUrl } from "@/lib/api";
import { createServerSupabase } from "@/lib/supabase";
import { DecideButtons } from "./DecideButtons";

export const dynamic = "force-dynamic";

type Application = {
  id: string;
  candidate_email: string | null;
  candidate_name: string | null;
  status: string;
  rank_score: number | null;
  operator_decision: string | null;
  resume_text: string | null;
  scorecard: unknown;
};

type Message = {
  id: string;
  role: string;
  content: string;
};

type AppDetail = {
  application: Application;
  messages: Message[];
};

async function fetchApp(id: string, accessToken: string | undefined): Promise<AppDetail | null> {
  if (!accessToken) return null;
  try {
    const res = await fetch(apiUrl(`/api/applications/${id}`), {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as AppDetail;
  } catch {
    return null;
  }
}

export default async function AppDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createServerSupabase(await cookies());
  const { data: sess } = await supabase.auth.getSession();
  const accessToken = sess?.session?.access_token;
  const out = await fetchApp(params.id, accessToken);
  if (!out) return <AppShell pageTitle="Not found"><p>Not found.</p></AppShell>;
  const { application: a, messages } = out;

  return (
    <AppShell pageTitle={a.candidate_name ?? a.candidate_email ?? "Application"}>
      <h1 className="text-2xl font-semibold mb-2">{a.candidate_name ?? a.candidate_email}</h1>
      <p className="text-base text-slate-500 mb-4">
        Score: {a.rank_score?.toFixed(2) ?? "-"} · Status: {a.status}
      </p>

      <DecideButtons
        applicationId={a.id}
        initial={a.operator_decision}
        finalized={a.status === "completed"}
      />

      <h3 className="font-medium mt-6 mb-2">Resume excerpt</h3>
      <pre className="bg-slate-50 p-3 rounded-md text-xs overflow-x-auto whitespace-pre-wrap">{a.resume_text?.slice(0, 4000) ?? ""}</pre>

      <h3 className="font-medium mt-6 mb-2">Conversation</h3>
      <div className="space-y-2">
        {messages.map((m) => (
          <div key={m.id} className={`p-3 rounded-md ${m.role === "agent" ? "bg-slate-100" : "bg-blue-50"}`}>
            <div className="text-xs text-slate-500 mb-1">{m.role}</div>
            <div className="text-base whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
      </div>

      {a.scorecard != null && (
        <>
          <h3 className="font-medium mt-6 mb-2">Scorecard</h3>
          <pre className="bg-slate-50 p-3 rounded-md text-xs overflow-x-auto">{JSON.stringify(a.scorecard, null, 2)}</pre>
        </>
      )}
    </AppShell>
  );
}
