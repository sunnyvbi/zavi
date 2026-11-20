
import Link from "next/link";
import { cookies } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { apiUrl } from "@/lib/api";
import { createServerSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Role = {
  id: string;
  slug: string;
  title: string;
  status: string;
  created_at: string;
  published_at: string | null;
};

async function fetchRoles(accessToken: string | undefined): Promise<Role[]> {
  if (!accessToken) return [];
  try {
    const res = await fetch(apiUrl("/api/roles"), {
      cache: "no-store",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return [];
    return ((await res.json()) as { roles: Role[] }).roles;
  } catch {
    return [];
  }
}

export default async function RolesPage() {
  const supabase = createServerSupabase(await cookies());
  const { data: sess } = await supabase.auth.getSession();
  const accessToken = sess?.session?.access_token;
  const roles = await fetchRoles(accessToken);
  return (
    <AppShell pageTitle="Roles">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Open roles</h1>
        <Link href="/roles/new" className="px-4 py-2 bg-slate-900 text-white rounded-md text-base">
          New role
        </Link>
      </div>
      <ul className="space-y-2">
        {roles.map((r) => (
          <li key={r.id} className="border rounded-md p-4">
            <Link href={`/roles/${r.id}/edit`} className="font-medium">{r.title}</Link>
            <span className="ml-3 text-xs text-slate-500">{r.status}</span>
          </li>
        ))}
        {roles.length === 0 && <p className="text-slate-500">No roles yet. Create one.</p>}
      </ul>
    </AppShell>
  );
}
