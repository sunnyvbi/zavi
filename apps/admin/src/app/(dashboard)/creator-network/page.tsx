"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type OrderMoney = {
  order_id: string;
  status: string;
  source: string;
  currency: string;
  price_cents: number;
  business_total_cents: number;
  creator_payout_cents: number;
  payout_status: string;
  due_at: string | null;
  livemode: boolean;
};

type CreatorSummary = {
  human_member_id: string;
  display_name: string;
  slug: string | null;
  city: string | null;
  country_code: string | null;
  payout_country_supported: boolean;
  missed_deadline_count: number;
  needs_staff_review: boolean;
};

type QueueItem = {
  dispute_id: string;
  kind: string;
  opened_by: string;
  reason: string;
  created_at: string;
  money_frozen: boolean;
  tenant_id: string;
  tenant_name: string | null;
  order: OrderMoney;
  creator: CreatorSummary;
};

export function money(cents: number, currency = "usd"): string {
  return `${currency.toUpperCase()} ${(cents / 100).toFixed(2)}`;
}

export default function CreatorNetworkQueuePage() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [order, setOrder] = useState<string>("oldest first");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/creator-disputes");
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setItems((r.items ?? []) as QueueItem[]);
          setOrder(String(r.order ?? "oldest first"));
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">
          Creator mediation
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Open creator disputes, {order}. While a dispute is open the job&apos;s money is frozen:
          nothing is paid out and nothing is refunded until a decision is made. Open a dispute to
          see the brief, every submission, the whole thread and the money ledger before deciding.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {!items ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No open disputes. Nothing is waiting on Zavi.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((it) => (
            <div
              key={it.dispute_id}
              className="rounded-xl border border-slate-200 bg-white p-4 hover:border-sky-300"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/creator-network/disputes/${it.dispute_id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {it.creator.display_name}
                    </Link>
                    <span className="text-slate-400">·</span>
                    <span className="text-sm text-slate-600">{it.tenant_name ?? it.tenant_id}</span>
                    <span className="rounded bg-amber-100 text-amber-900 px-2 py-0.5 text-xs">
                      money frozen
                    </span>
                    {it.creator.needs_staff_review && (
                      <span className="rounded bg-rose-100 text-rose-900 px-2 py-0.5 text-xs">
                        {it.creator.missed_deadline_count} missed deadlines
                      </span>
                    )}
                    {!it.creator.payout_country_supported && (
                      <span className="rounded bg-slate-100 text-slate-700 px-2 py-0.5 text-xs">
                        payout country not supported
                      </span>
                    )}
                    {!it.order.livemode && (
                      <span className="rounded bg-slate-100 text-slate-600 px-2 py-0.5 text-xs">
                        test mode
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-700 mt-2 line-clamp-2">{it.reason}</p>
                  <div className="text-xs text-slate-500 mt-2">
                    Opened by the {it.opened_by === "tenant" ? "business" : "creator"} on{" "}
                    {new Date(it.created_at).toLocaleString()} · {it.kind.replace("_", " ")} · order
                    is {it.order.status.replace(/_/g, " ")}
                  </div>
                </div>
                <div className="text-right text-sm shrink-0">
                  <div className="text-slate-900">
                    Business paid {money(it.order.business_total_cents, it.order.currency)}
                  </div>
                  <div className="text-slate-600">
                    Creator would keep {money(it.order.creator_payout_cents, it.order.currency)}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    payout {it.order.payout_status.replace(/_/g, " ")}
                  </div>
                  <Link
                    href={`/creator-network/disputes/${it.dispute_id}`}
                    className="inline-block mt-2 rounded-md bg-slate-900 text-white text-xs px-3 py-1.5"
                  >
                    Review
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
