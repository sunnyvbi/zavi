"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserAdminSupabase } from "@/lib/supabase-admin";
import { adminApiFetch } from "@/lib/api-admin";
import { ADMIN_DENIAL_KEY } from "@/components/admin/AdminGate";

function staffDenialMessage(status: number, code?: string, message?: string): string {
  if (code === "not_staff") {
    return "This account is not a Zavi admin. Customer accounts sign in at zaviagent.com/login.";
  }
  if (code === "staff_check_unavailable") {
    return "Could not verify admin access right now (transient). Try again.";
  }
  return message ?? `Admin access denied (HTTP ${status}).`;
}

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const msg = window.sessionStorage.getItem(ADMIN_DENIAL_KEY);
      if (msg) {
        window.sessionStorage.removeItem(ADMIN_DENIAL_KEY);
        setError(msg);
      }
    } catch {
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const sb = createBrowserAdminSupabase();
      const { error: e1 } = await sb.auth.signInWithPassword({ email, password });
      if (e1) throw new Error(e1.message);

      let probe: Response;
      try {
        probe = await adminApiFetch("/api/admin/whoami");
      } catch {
        await sb.auth.signOut({ scope: "local" });
        throw new Error("Could not reach the admin API. Try again.");
      }
      if (!probe.ok) {
        const body = (await probe.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        await sb.auth.signOut({ scope: "local" });
        throw new Error(staffDenialMessage(probe.status, body.error?.code, body.error?.message));
      }

      router.push("/");
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-start justify-center pt-32">
      <div className="w-full max-w-md px-6">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700 mb-2">
          Zavi · admin dashboard
        </div>
        <h1 className="font-display font-semibold text-3xl text-slate-900 mb-1">Sign in</h1>
        <p className="text-sm text-slate-600 mb-6 leading-[1.6]">
          Internal Zavi admins only. Customer accounts sign in at{" "}
          <a href="https://www.zaviagent.com/login" className="underline">zaviagent.com/login</a>.
        </p>

        <form
          onSubmit={submit}
          className="rounded-xl border border-slate-200 bg-white shadow-sm p-5 space-y-3"
        >
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="staff-email">
              Email
            </label>
            <input
              id="staff-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ravi@upcar.ai"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="staff-pw">
              Password
            </label>
            <input
              id="staff-pw"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
            />
          </div>
          {error && <p className="text-sm text-rose-700">{error}</p>}
          <button
            type="submit"
            disabled={busy || !email || !password}
            className="w-full inline-flex items-center justify-center rounded-lg bg-slate-900 text-white px-4 py-2.5 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
