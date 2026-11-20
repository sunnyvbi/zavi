
import Link from "next/link";
import { cookies } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { apiUrl } from "@/lib/api";
import { createServerSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type App = {
  id: string;
  candidate_email: string | null;
  candidate_name: string | null;
  status: string;
  rank_score: number | null;
  operator_decision: string | null;
  created_at: string;
};

async function fetchApps(accessToken: string | undefined): Promise<App[]> {
  if (!accessToken) return [];
  try {
    const res = await fetch(apiUrl("/api/applications"), {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return [];
    return ((await res.json()) as { applications: App[] }).applications;
  } catch {
    return [];
  }
}

export default async function ApplicationsPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: sess } = await supabase.auth.getSession();
  const accessToken = sess?.session?.access_token;
  const apps = await fetchApps(accessToken);
  return (
    <AppShell pageTitle="Applications">
      <h1 className="text-2xl font-semibold mb-4">Applications</h1>
      <table className="w-full text-base">
        <thead className="text-left text-slate-500 border-b">
          <tr><th className="py-2">Candidate</th><th>Status</th><th>Score</th><th>Decision</th></tr>
        </thead>
        <tbody>
          {apps.map((a) => (
            <tr key={a.id} className="border-b hover:bg-slate-50">
              <td className="py-2"><Link href={`/applications/${a.id}`}>{a.candidate_name ?? a.candidate_email ?? "(unknown)"}</Link></td>
              <td>{a.status}</td>
              <td>{a.rank_score?.toFixed(2) ?? "-"}</td>
              <td>{a.operator_decision ?? "pending"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {apps.length === 0 && <p className="text-slate-500">No applications yet.</p>}
    </AppShell>
  );
}
