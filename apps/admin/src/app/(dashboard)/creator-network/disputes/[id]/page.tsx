"use client";

import { useCallback, useEffect, useState } from "react";
import { mediationResultMessage, payPartCheck } from "@/lib/creator-mediation";
import { useParams } from "next/navigation";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type OrderMoney = {
  order_id: string;
  tenant_id: string;
  source: string;
  status: string;
  closed_reason: string | null;
  currency: string;
  price_cents: number;
  business_fee_cents: number;
  creator_fee_cents: number;
  business_total_cents: number;
  creator_payout_cents: number;
  payout_amount_cents: number | null;
  payout_status: string;
  payout_ready_at: string | null;
  due_at: string | null;
  accepted_at: string | null;
  closed_at: string | null;
  created_at: string;
  livemode: boolean;
};

type Detail = {
  dispute: {
    dispute_id: string;
    kind: string;
    opened_by: string;
    reason: string;
    status: string;
    outcome: string | null;
    resolution_note: string | null;
    resolved_at: string | null;
    created_at: string;
  };
  money_frozen: boolean;
  tenant_id: string;
  tenant_name: string | null;
  order: OrderMoney;
  creator: {
    human_member_id: string;
    display_name: string;
    slug: string | null;
    city: string | null;
    country_code: string | null;
    payout_country_supported: boolean;
    missed_deadline_count: number;
    needs_staff_review: boolean;
  };
  brief: {
    package_snapshot: Record<string, unknown> | null;
    brief_snapshot: Record<string, unknown> | null;
  };
  submissions: Array<{
    version: number;
    position: number;
    kind: string;
    storage_path: string;
    mime_type: string | null;
    bytes: number | null;
    note: string | null;
    created_at: string;
    signed_url: string | null;
  }>;
  thread: Array<{ sender_kind: string; body: string; created_at: string }>;
  ledger: Array<{
    kind: string;
    cause: string;
    amount_cents: number;
    currency: string;
    actor_kind: string;
    livemode: boolean;
    created_at: string;
  }>;
  pay_part_limits: { max_creator_amount_cents: number; max_refund_amount_cents: number; max_total_cents?: number };
};

function money(cents: number, currency = "usd"): string {
  return `${currency.toUpperCase()} ${(cents / 100).toFixed(2)}`;
}

function centsFromDollars(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export default function CreatorDisputeDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const [creatorShare, setCreatorShare] = useState("");
  const [refundShare, setRefundShare] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await adminApiFetch(`/api/admin/creator-disputes/${id}`);
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setD(r as Detail);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    if (id) void load();
  }, [id, load]);

  async function resolve(
    outcome: "pay_full" | "pay_part" | "refund",
    amounts?: { creator_amount_cents: number; refund_amount_cents: number },
  ) {
    setBusy(true);
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/creator-disputes/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          outcome,
          ...(amounts ?? {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setDone(mediationResultMessage(outcome, r));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const cShare = centsFromDollars(creatorShare);
  const rShare = centsFromDollars(refundShare);
  const split = d ? payPartCheck(cShare, rShare, d.pay_part_limits) : null;
  const payPartReady = split?.ready === true;

  if (error && !d) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      </div>
    );
  }
  if (!d) return <div className="max-w-5xl mx-auto p-6 text-sm text-slate-500">Loading…</div>;

  const decided = d.dispute.status !== "open";

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-5">
      <div>
        <Link href="/creator-network" className="text-xs text-slate-500 hover:underline">
          Creator mediation
        </Link>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">
          {d.creator.display_name} · {d.tenant_name ?? d.tenant_id}
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          {decided
            ? `Decided: ${String(d.dispute.outcome).replace(/_/g, " ")}. The money has moved and the job is ${d.order.status.replace(/_/g, " ")}.`
            : "Money is frozen while this is open. Nothing is paid out and nothing is refunded until you decide."}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}
      {done && (
        <div
          role="status"
          className={
            done.tone === "warn"
              ? "rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
              : "rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
          }
        >
          {done.text}
        </div>
      )}

      {}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">What was asked</h2>
        <p className="text-sm text-slate-700 mt-2 whitespace-pre-wrap">{d.dispute.reason}</p>
        <div className="text-xs text-slate-500 mt-2">
          Raised by the {d.dispute.opened_by === "tenant" ? "business" : "creator"} on{" "}
          {new Date(d.dispute.created_at).toLocaleString()} ·{" "}
          {d.dispute.kind.replace(/_/g, " ")}
        </div>
      </section>

      {}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">Money on this job</h2>
        <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3 text-sm">
          <Stat label="Creator's price" value={money(d.order.price_cents, d.order.currency)} />
          <Stat
            label="Zavi fee, business side"
            value={money(d.order.business_fee_cents, d.order.currency)}
          />
          <Stat
            label="Business paid"
            value={money(d.order.business_total_cents, d.order.currency)}
          />
          <Stat
            label="Zavi fee, creator side"
            value={money(d.order.creator_fee_cents, d.order.currency)}
          />
          <Stat
            label="Creator's full payout"
            value={money(d.order.creator_payout_cents, d.order.currency)}
          />
          <Stat label="Payout state" value={d.order.payout_status.replace(/_/g, " ")} />
        </dl>
        <div className="text-xs text-slate-500 mt-3">
          Order {d.order.order_id} · {d.order.source} · due{" "}
          {d.order.due_at ? new Date(d.order.due_at).toLocaleString() : "not set"} ·{" "}
          {d.order.livemode ? "live" : "test mode"}
          {!d.creator.payout_country_supported && (
            <> · this creator&apos;s country is outside Stripe&apos;s payout reach</>
          )}
          {d.creator.needs_staff_review && (
            <> · {d.creator.missed_deadline_count} missed deadlines on this account</>
          )}
        </div>

        <h3 className="text-xs uppercase tracking-wide text-slate-500 mt-4">Ledger</h3>
        {d.ledger.length === 0 ? (
          <p className="text-sm text-slate-500 mt-1">No money has moved on this job yet.</p>
        ) : (
          <table className="w-full text-sm mt-2">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="text-left py-1">When</th>
                <th className="text-left py-1">What</th>
                <th className="text-left py-1">Why</th>
                <th className="text-right py-1">Amount</th>
              </tr>
            </thead>
            <tbody>
              {d.ledger.map((l, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1 text-slate-500">
                    {new Date(l.created_at).toLocaleString()}
                  </td>
                  <td className="py-1 text-slate-900">{l.kind.replace(/_/g, " ")}</td>
                  <td className="py-1 text-slate-600">{l.cause.replace(/_/g, " ")}</td>
                  <td className="py-1 text-right text-slate-900">
                    {money(l.amount_cents, l.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">What was promised</h2>
        <Json label="Package agreed at booking" value={d.brief.package_snapshot} />
        <Json label="Brief as the business last saved it" value={d.brief.brief_snapshot} />
      </section>

      {}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">
          What was delivered ({d.submissions.length}{" "}
          {d.submissions.length === 1 ? "file" : "files"})
        </h2>
        {d.submissions.length === 0 ? (
          <p className="text-sm text-slate-500 mt-2">Nothing has been submitted on this job.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {d.submissions.map((s) => (
              <li
                key={`${s.version}-${s.position}`}
                className="flex items-center justify-between gap-3 border-t border-slate-100 pt-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="text-slate-900">
                    Version {s.version} · {s.kind.replace(/_/g, " ")}
                  </div>
                  {s.note && <div className="text-slate-600">{s.note}</div>}
                  <div className="text-xs text-slate-500">
                    {new Date(s.created_at).toLocaleString()}
                    {s.bytes != null && <> · {(s.bytes / 1_000_000).toFixed(1)} MB</>}
                  </div>
                </div>
                {s.signed_url ? (
                  <a
                    href={s.signed_url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs shrink-0"
                  >
                    Open
                  </a>
                ) : (
                  <span className="text-xs text-slate-400 shrink-0">link unavailable</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">The whole thread</h2>
        {d.thread.length === 0 ? (
          <p className="text-sm text-slate-500 mt-2">This job has no thread.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {d.thread.map((m, i) => (
              <li key={i} className="border-t border-slate-100 pt-2 text-sm">
                <div className="text-xs text-slate-500">
                  {m.sender_kind === "tenant" ? "Business" : m.sender_kind === "creator" ? "Creator" : m.sender_kind}{" "}
                  · {new Date(m.created_at).toLocaleString()}
                </div>
                <p className="text-slate-800 whitespace-pre-wrap">{m.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {}
      {!decided && (
        <section className="rounded-xl border border-slate-300 bg-slate-50 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Decide</h2>
          <p className="text-sm text-slate-600 mt-1">
            One decision, and the money moves. There is no undo.
          </p>

          <label className="block mt-3 text-xs uppercase tracking-wide text-slate-500">
            Note for both sides (optional)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm"
            placeholder="What you decided and why."
          />

          <div className="flex flex-wrap gap-2 mt-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void resolve("pay_full")}
              className="rounded-md bg-emerald-700 text-white text-sm px-3 py-2 disabled:opacity-50"
            >
              Pay the creator in full ({money(d.order.creator_payout_cents, d.order.currency)})
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void resolve("refund")}
              className="rounded-md bg-rose-700 text-white text-sm px-3 py-2 disabled:opacity-50"
            >
              Refund the business in full ({money(d.order.business_total_cents, d.order.currency)})
            </button>
          </div>

          <div className="mt-4 rounded-md border border-slate-300 bg-white p-3">
            <div className="text-sm font-medium text-slate-900">Pay part</div>
            <p className="text-xs text-slate-600 mt-1">
              Both numbers are required. Zavi does not work out the split for you.
            </p>
            <div className="grid md:grid-cols-2 gap-3 mt-2">
              <div>
                <label className="block text-xs text-slate-600">
                  Creator keeps (max{" "}
                  {money(d.pay_part_limits.max_creator_amount_cents, d.order.currency)})
                </label>
                <input
                  value={creatorShare}
                  onChange={(e) => setCreatorShare(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600">
                  Business gets back (max{" "}
                  {money(d.pay_part_limits.max_refund_amount_cents, d.order.currency)})
                </label>
                <input
                  value={refundShare}
                  onChange={(e) => setRefundShare(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={busy || !payPartReady}
              onClick={() =>
                void resolve("pay_part", {
                  creator_amount_cents: cShare as number,
                  refund_amount_cents: rShare as number,
                })
              }
              className="mt-3 rounded-md bg-slate-900 text-white text-sm px-3 py-2 disabled:opacity-50"
            >
              Pay part
            </button>
            {split?.total && (
              <p className={split.over ? "text-xs text-rose-700 mt-2" : "text-xs text-slate-500 mt-2"}>{split.total}</p>
            )}
            {!payPartReady && !split?.over && (creatorShare.trim() !== "" || refundShare.trim() !== "") && (
              <p className="text-xs text-slate-500 mt-2">
                Enter both amounts, each above zero and within the maximum shown.
              </p>
            )}
          </div>
        </section>
      )}

      {decided && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Decision</h2>
          <p className="text-sm text-slate-700 mt-1">
            {String(d.dispute.outcome).replace(/_/g, " ")} on{" "}
            {d.dispute.resolved_at ? new Date(d.dispute.resolved_at).toLocaleString() : "unknown"}.
          </p>
          {d.dispute.resolution_note && (
            <p className="text-sm text-slate-600 mt-1 whitespace-pre-wrap">
              {d.dispute.resolution_note}
            </p>
          )}
        </section>
      )}

      <div>
        <Link
          href={`/creator-network/creators/${d.creator.human_member_id}`}
          className="text-sm text-slate-600 hover:underline"
        >
          Open this creator&apos;s account
        </Link>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-4 text-sm text-slate-500 hover:underline"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-slate-900">{value}</dd>
    </div>
  );
}

function Json({ label, value }: { label: string; value: Record<string, unknown> | null }) {
  if (!value) return null;
  return (
    <div className="mt-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <pre className="mt-1 rounded-md bg-slate-50 border border-slate-200 p-2 text-xs text-slate-800 overflow-x-auto">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
