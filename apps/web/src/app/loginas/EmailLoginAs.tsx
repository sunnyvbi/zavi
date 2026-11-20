"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { cn } from "@/lib/cn";

type TenantMembership = {
  tenant_id: string;
  slug: string;
  display_name: string | null;
  role: string;
};

type LookupResponse = {
  user_id: string;
  email: string | null;
  tenants: TenantMembership[];
};

type LoginAsResponse = {
  access_token: string;
  refresh_token: string;
};

export function EmailLoginAs() {
  const [email, setEmail] = useState("");
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<LookupResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setResult(null);
    setSelected(null);
    setError(null);
    setConfirming(false);
  }

  async function doLookup(e: React.FormEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    setLooking(true);
    reset();
    try {
      const res = await apiFetch(`/api/admin/user-lookup?email=${encodeURIComponent(addr)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const data = body as LookupResponse;
      setResult(data);
      setSelected(data.tenants.length === 1 ? data.tenants[0].tenant_id : null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLooking(false);
    }
  }

  async function doLoginAs() {
    if (!result || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/login-as", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: selected, user_id: result.user_id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const data = body as LoginAsResponse;
      const supabase = createBrowserSupabase();
      const { error: setErr } = await supabase.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      });
      if (setErr) throw new Error(`session install failed: ${setErr.message}`);
      window.location.href = "/workspace";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      setConfirming(false);
    }
  }

  const selectedTenant = result?.tenants.find((t) => t.tenant_id === selected) ?? null;

  return (
    <div>
      <form onSubmit={doLookup} className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="customer@example.com"
          autoComplete="off"
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={looking || !email.trim()}
          className={cn(
            "shrink-0 rounded-cta border px-4 py-2 text-[13px] font-medium transition-colors",
            looking || !email.trim()
              ? "border-slate-200 text-slate-400"
              : "border-slate-900 bg-slate-900 text-white hover:bg-slate-700",
          )}
        >
          {looking ? "Looking…" : "Look up"}
        </button>
      </form>

      {error && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-800">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-baseline justify-between">
            <div className="text-[13px] font-medium text-slate-900">{result.email}</div>
            <div className="font-mono text-[11px] text-slate-400">
              {result.user_id.slice(0, 8)}…
            </div>
          </div>

          {result.tenants.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[13px] text-slate-600">
              This user belongs to no tenant, so there is no workspace to land in.
            </div>
          ) : (
            <>
              <div className="mb-2 text-[11px] uppercase tracking-wider text-slate-500">
                {result.tenants.length === 1
                  ? "Workspace"
                  : "Pick which workspace to land in"}
              </div>
              <div className="space-y-1.5">
                {result.tenants.map((t) => (
                  <label
                    key={t.tenant_id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
                      selected === t.tenant_id
                        ? "border-slate-900 bg-slate-50"
                        : "border-slate-200 hover:border-slate-300",
                    )}
                  >
                    <input
                      type="radio"
                      name="tenant"
                      value={t.tenant_id}
                      checked={selected === t.tenant_id}
                      onChange={() => setSelected(t.tenant_id)}
                      className="accent-slate-900"
                    />
                    <span className="flex-1 text-[13px] font-medium text-slate-900">
                      {t.display_name || t.slug}
                    </span>
                    <span className="font-mono text-[12px] text-slate-500">{t.slug}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                      {t.role}
                    </span>
                  </label>
                ))}
              </div>

              <button
                onClick={() => setConfirming(true)}
                disabled={!selected || busy}
                className={cn(
                  "mt-4 w-full rounded-cta border px-3 py-2 text-[13px] font-medium transition-colors",
                  !selected || busy
                    ? "border-slate-200 text-slate-400"
                    : "border-slate-900 bg-slate-900 text-white hover:bg-slate-700",
                )}
              >
                Login as this user
              </button>
            </>
          )}
        </div>
      )}

      {confirming && result && selectedTenant && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <h2 className="text-[14px] font-semibold text-slate-900">
              Login as {result.email}?
            </h2>
            <p className="mt-2 text-[13px] text-slate-600">
              You will become this user in{" "}
              <span className="font-medium text-slate-900">
                {selectedTenant.display_name || selectedTenant.slug}
              </span>{" "}
              with a full customer session with full write access, acting as them.
              Every action is attributed to the customer and audited to you. To
              return to staff, sign out and sign back in as yourself.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="rounded-cta border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:border-slate-300 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void doLoginAs()}
                disabled={busy}
                className="rounded-cta border border-slate-900 bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {busy ? "Signing in…" : "Yes, login as customer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
