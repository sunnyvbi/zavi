"use client";

import { CreditGrantPanel } from "@/components/admin/CreditGrantPanel";

export default function AdminCreditGrantsPage() {
  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Credit grants</h1>
        <p className="text-sm text-slate-500 mt-1">
          Issue promo/comp credits to a tenant. Money path — every grant is capped, audited, idempotent, and revocable.
        </p>
      </div>
      <CreditGrantPanel />
    </div>
  );
}
