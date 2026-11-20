"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Grant = {
  tenant_id: string;
  tenant: string;
  amount: number;
  grant_key: string | null;
  revoked: boolean;
  created_at: string;
};
type ListResp = { grants: Grant[]; per_grant_cap: number; unlimited_tenant_ids?: string[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function CreditGrantPanel({
  tenantId: fixedTenantId,
  onGranted,
}: {
  tenantId?: string;
  onGranted?: () => void;
}) {
  const scoped = Boolean(fixedTenantId);
  const [data, setData] = useState<ListResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tenantIdInput, setTenantIdInput] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [unlimitedReason, setUnlimitedReason] = useState("");
  const [unlimitedConfirm, setUnlimitedConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await adminApiFetch("/api/admin/credit-grants");
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setData(r as ListResp);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const targetTenantId = (fixedTenantId ?? tenantIdInput).trim();
  const amountNum = Number(amount);
  const cap = data?.per_grant_cap ?? 100000;
  const amountOk = Number.isInteger(amountNum) && amountNum > 0 && amountNum <= cap;
  const canSubmit =
    !busy &&
    UUID_RE.test(targetTenantId) &&
    amountOk &&
    reason.trim().length >= 3 &&
    confirm.trim().toUpperCase() === "GRANT";

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setFlash(null);
    setError(null);
    try {
      const grant_key = crypto.randomUUID();
      const res = await adminApiFetch("/api/admin/credit-grant", {
        method: "POST",
        body: JSON.stringify({ tenant_id: targetTenantId, amount: amountNum, reason: reason.trim(), grant_key }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setFlash(r.granted ? `Granted ${amountNum.toLocaleString()} credits.` : "No change (idempotent replay).");
      setAmount("");
      setReason("");
      setConfirm("");
      await load();
      onGranted?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isUnlimited = (data?.unlimited_tenant_ids ?? []).includes(targetTenantId);
  const canToggleUnlimited =
    !busy &&
    UUID_RE.test(targetTenantId) &&
    unlimitedReason.trim().length >= 3 &&
    (isUnlimited || unlimitedConfirm.trim().toUpperCase() === "UNLIMITED");

  async function toggleUnlimited() {
    if (!canToggleUnlimited) return;
    const next = !isUnlimited;
    setBusy(true);
    setFlash(null);
    setError(null);
    try {
      const res = await adminApiFetch("/api/admin/credit-unlimited", {
        method: "POST",
        body: JSON.stringify({ tenant_id: targetTenantId, unlimited: next, reason: unlimitedReason.trim() }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setFlash(
        r.changed
          ? next
            ? "Unlimited credits ON — this tenant will never be blocked for balance."
            : "Unlimited credits OFF — the normal credit wall is back."
          : "No change (already in that state).",
      );
      setUnlimitedReason("");
      setUnlimitedConfirm("");
      await load();
      onGranted?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(grant_key: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await adminApiFetch("/api/admin/credit-grant/revoke", {
        method: "POST",
        body: JSON.stringify({ grant_key }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setFlash(r.revoked ? "Grant revoked." : "Nothing to revoke.");
      await load();
      onGranted?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const grants = (data?.grants ?? []).filter((g) => !scoped || g.tenant_id === fixedTenantId);

  return (
    <div>
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}
      {flash && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">{flash}</div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 mb-6 max-w-xl">
        <div className="grid gap-3">
          {!scoped && (
            <label className="text-sm text-slate-600">
              Tenant id (UUID)
              <input
                value={tenantIdInput}
                onChange={(e) => setTenantIdInput(e.target.value)}
                placeholder="73db45ff-457e-4541-bc8f-bdb625390204"
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-sm"
              />
            </label>
          )}
          <label className="text-sm text-slate-600">
            Amount (credits, ≤ {cap.toLocaleString()})
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-sm"
            />
          </label>
          <label className="text-sm text-slate-600">
            Reason (audited)
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. launch comp, support goodwill, pilot"
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
            />
          </label>
          <label className="text-sm text-slate-600">
            Type <span className="font-mono font-semibold text-rose-700">GRANT</span> to confirm
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-sm"
            />
          </label>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className={
              "mt-1 rounded-md px-3 py-2 text-sm font-medium " +
              (canSubmit ? "bg-slate-900 text-white hover:bg-slate-800" : "bg-slate-200 text-slate-400 cursor-not-allowed")
            }
          >
            {busy ? "Working…" : "Issue credits"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 mb-6 max-w-xl">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-slate-800">Unlimited credits</h2>
          {UUID_RE.test(targetTenantId) && (
            <span
              className={
                "rounded-full px-2 py-0.5 text-xs font-medium " +
                (isUnlimited ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600")
              }
            >
              {isUnlimited ? "ON — no credit wall" : "OFF — normal wall"}
            </span>
          )}
        </div>
        <p className="text-sm text-slate-600 mb-3">
          Exempts this tenant from the credit wall entirely — runs are never rejected for balance,
          with no cap and no re-granting. Usage is still metered and shows in the ledger, and the
          balance may read negative. This removes a spend guard: everything the tenant runs lands
          on our bill.
        </p>
        <div className="grid gap-3">
          <label className="text-sm text-slate-600">
            Reason (audited)
            <input
              value={unlimitedReason}
              onChange={(e) => setUnlimitedReason(e.target.value)}
              placeholder={isUnlimited ? "e.g. comp period ended" : "e.g. design partner, unmetered pilot"}
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
            />
          </label>
          {!isUnlimited && (
            <label className="text-sm text-slate-600">
              Type <span className="font-mono font-semibold text-amber-700">UNLIMITED</span> to confirm
              <input
                value={unlimitedConfirm}
                onChange={(e) => setUnlimitedConfirm(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-sm"
              />
            </label>
          )}
          <button
            type="button"
            disabled={!canToggleUnlimited}
            onClick={toggleUnlimited}
            className={
              "mt-1 rounded-md px-3 py-2 text-sm font-medium " +
              (canToggleUnlimited
                ? isUnlimited
                  ? "bg-slate-900 text-white hover:bg-slate-800"
                  : "bg-amber-600 text-white hover:bg-amber-700"
                : "bg-slate-200 text-slate-400 cursor-not-allowed")
            }
          >
            {busy ? "Working…" : isUnlimited ? "Turn off unlimited" : "Give unlimited credits"}
          </button>
        </div>
      </div>

      <h2 className="text-sm font-semibold text-slate-800 mb-2">
        {scoped ? "Grants to this tenant" : "Recent grants"}
      </h2>
      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : grants.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500 text-center">
          No grants yet.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">When</th>
                {!scoped && <th className="text-left px-3 py-2.5">Tenant</th>}
                <th className="text-right px-3 py-2.5">Amount</th>
                <th className="text-left px-3 py-2.5">Key</th>
                <th className="text-right px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g, i) => (
                <tr key={`${g.grant_key}::${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">{new Date(g.created_at).toLocaleString()}</td>
                  {!scoped && (
                    <td className="px-3 py-2 text-slate-700">
                      <Link href={`/tenants/${g.tenant_id}`} className="hover:underline">
                        {g.tenant}
                      </Link>
                    </td>
                  )}
                  <td className={"px-3 py-2 text-right font-mono " + (g.amount < 0 ? "text-rose-700" : "text-emerald-700")}>
                    {g.amount > 0 ? "+" : ""}
                    {g.amount.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-400 text-xs">{(g.grant_key ?? "—").slice(0, 12)}</td>
                  <td className="px-3 py-2 text-right">
                    {g.amount > 0 && !g.revoked && g.grant_key && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => revoke(g.grant_key as string)}
                        className="text-sm text-rose-700 hover:underline disabled:text-slate-300"
                      >
                        revoke
                      </button>
                    )}
                    {g.revoked && <span className="text-xs text-slate-400">revoked</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
