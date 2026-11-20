"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Pkg = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  price_cents: number;
  currency: string;
  delivery_days: number;
  active: boolean;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
};

type Detail = {
  member: {
    id: string;
    display_name: string;
    discipline: string;
    vetting_state: string;
    rejected_reason: string | null;
    bio?: string | null;
    created_at: string;
  };
  handles: Array<{ platform: string; handle: string }>;
  pii: { legal_name: string | null; email: string | null } | null;
  collisions: Array<{ field: string; value: string; collides_with: Array<{ display_name: string }> }>;
  creator: {
    human_member_id: string;
    slug: string | null;
    lanes: string[];
    city: string | null;
    country_code: string | null;
    payout_country_supported: boolean;
    intro_video_path: string | null;
    sample_video_paths: string[];
    self_reported_audience: { label: string; verified: boolean; metrics: Record<string, unknown> };
    packages: Pkg[];
    is_18_plus: boolean | null;
    payout_account: {
      exists: boolean;
      livemode: boolean | null;
      country: string | null;
      details_submitted: boolean;
      payouts_enabled: boolean;
      disabled_reason: string | null;
    };
    marks: {
      missed_deadline_count: number;
      needs_staff_review: boolean;
      threshold: number;
      derived_from: string;
    };
  };
};

type Cascade = {
  storefront_hidden: boolean;
  applications_withdrawn: number;
  offers_withdrawn: number;
  pending_orders_cancelled: Array<{ order_id: string; status: string }>;
  pending_orders_failed: Array<{ order_id: string; code: string; message: string }>;
  in_progress_untouched: Array<{ order_id: string; status: string }>;
};

function money(cents: number, currency = "usd"): string {
  return `${currency.toUpperCase()} ${(cents / 100).toFixed(2)}`;
}

export default function CreatorAccountPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [cascade, setCascade] = useState<Cascade | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await adminApiFetch(`/api/admin/creators/${id}`);
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

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/creators/${id}/remove`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setCascade(r.cascade as Cascade);
      setReason("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

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

  const c = d.creator;
  const removed = d.member.vetting_state === "rejected";

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-5">
      <div>
        <Link href="/creator-network" className="text-xs text-slate-500 hover:underline">
          Creator mediation
        </Link>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">
          {d.member.display_name}
        </h1>
        <div className="flex items-center gap-2 flex-wrap mt-2 text-xs">
          <span className="rounded bg-slate-100 text-slate-700 px-2 py-0.5">
            {d.member.vetting_state.replace(/_/g, " ")}
          </span>
          {c.slug && (
            <span className="rounded bg-slate-100 text-slate-700 px-2 py-0.5">
              zaviagent.com/creators/{c.slug}
            </span>
          )}
          {c.marks.needs_staff_review && (
            <span className="rounded bg-rose-100 text-rose-900 px-2 py-0.5">
              needs staff review
            </span>
          )}
          {!c.payout_country_supported && (
            <span className="rounded bg-amber-100 text-amber-900 px-2 py-0.5">
              cannot be booked: payout country not supported
            </span>
          )}
        </div>
        {removed && d.member.rejected_reason && (
          <p className="text-sm text-slate-700 mt-2">
            Removed. Reason given: {d.member.rejected_reason}
          </p>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">Missed deadlines</h2>
        <p className="text-2xl text-slate-900 mt-1">
          {c.marks.missed_deadline_count}{" "}
          <span className="text-sm text-slate-500">
            of {c.marks.threshold} before the account is surfaced for review
          </span>
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Counted from real no-show job outcomes, never entered by hand. A mark lands when a job has
          no draft three days after its due date.
        </p>
        {c.marks.needs_staff_review && (
          <p className="text-sm text-rose-800 mt-2">
            This account has reached the threshold. Look at the jobs before deciding anything.
          </p>
        )}
      </section>

      {}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">Signup</h2>
        <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3 text-sm">
          <Stat label="Lanes" value={c.lanes.length ? c.lanes.map(laneLabel).join(", ") : "none set"} />
          <Stat label="Location" value={[c.city, c.country_code].filter(Boolean).join(", ") || "not set"} />
          <Stat
            label="18 or over"
            value={c.is_18_plus === null ? "not on file" : c.is_18_plus ? "yes" : "no"}
          />
          <Stat label="Handles" value={d.handles.map((h) => `${h.platform} @${h.handle}`).join(", ") || "none"} />
          <Stat label="Email" value={d.pii?.email ?? "not on file"} />
          <Stat label="Joined" value={new Date(d.member.created_at).toLocaleDateString()} />
        </dl>
        {d.member.bio && <p className="text-sm text-slate-700 mt-3 whitespace-pre-wrap">{d.member.bio}</p>}

        <h3 className="text-xs uppercase tracking-wide text-slate-500 mt-4">Intro and samples</h3>
        <ul className="text-sm text-slate-700 mt-1 space-y-1">
          <li>Intro video: {c.intro_video_path ?? "not uploaded"}</li>
          {c.sample_video_paths.length === 0 ? (
            <li>Samples: none uploaded</li>
          ) : (
            c.sample_video_paths.map((p) => <li key={p}>Sample: {p}</li>)
          )}
        </ul>
      </section>

      {}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">Audience numbers</h2>
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-2 inline-block">
          {c.self_reported_audience.label}
        </p>
        {Object.keys(c.self_reported_audience.metrics).length === 0 ? (
          <p className="text-sm text-slate-500 mt-2">No numbers given.</p>
        ) : (
          <ul className="text-sm text-slate-800 mt-2 space-y-1">
            {Object.entries(c.self_reported_audience.metrics).map(([k, v]) => (
              <li key={k}>
                {k.replace(/_/g, " ")}: {String(v)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">Packages</h2>
        {c.packages.length === 0 ? (
          <p className="text-sm text-slate-500 mt-2">No packages set up.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {c.packages.map((p) => (
              <li key={p.id} className="border-t border-slate-100 pt-2 text-sm">
                <div className="text-slate-900">
                  {p.title} · {money(p.price_cents, p.currency)} · {p.delivery_days} days
                  {!p.active && <span className="text-slate-500"> (inactive)</span>}
                </div>
                {p.kind === "ugc_video" && (
                  <div className="text-xs text-slate-600">
                    {`${p.video_count} video(s), ${p.video_length_seconds}s, ad rights ${p.ad_rights_days} days`}
                  </div>
                )}
                {p.description && <div className="text-xs text-slate-600 mt-1">{p.description}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">Payouts</h2>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-sm">
          <Stat label="Country reachable" value={c.payout_country_supported ? "yes" : "no"} />
          <Stat label="Stripe set up" value={c.payout_account.exists ? "yes" : "not yet"} />
          <Stat label="Details submitted" value={c.payout_account.details_submitted ? "yes" : "no"} />
          <Stat label="Payouts enabled" value={c.payout_account.payouts_enabled ? "yes" : "no"} />
        </dl>
        {c.payout_account.disabled_reason && (
          <p className="text-sm text-amber-900 mt-2">Stripe says: {c.payout_account.disabled_reason}</p>
        )}
        <p className="text-xs text-slate-500 mt-2">
          Zavi never stores bank or tax details, so there is nothing more to show here. Stripe holds
          them.
        </p>
      </section>

      {}
      {d.collisions.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">Possible duplicate account</h2>
          <ul className="text-sm text-amber-900 mt-2 space-y-1">
            {d.collisions.map((col, i) => (
              <li key={i}>
                {col.field.replace(/_/g, " ")} {col.value} also on{" "}
                {col.collides_with.map((o) => o.display_name).join(", ")}
              </li>
            ))}
          </ul>
        </section>
      )}

      {}
      {!removed && (
        <section className="rounded-xl border border-rose-300 bg-rose-50 p-4">
          <h2 className="text-sm font-semibold text-rose-900">Remove this creator</h2>
          <p className="text-sm text-rose-900 mt-1">
            Removing takes the storefront down, withdraws their open applications and open offers,
            and cancels requests they have not accepted yet so those card holds drop. Jobs already
            in progress carry on and pay out normally. The reason you write is shown to the creator.
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Why this account is being removed."
            className="mt-3 w-full rounded-md border border-rose-300 p-2 text-sm"
          />
          <button
            type="button"
            disabled={busy || reason.trim().length === 0}
            onClick={() => void remove()}
            className="mt-2 rounded-md bg-rose-700 text-white text-sm px-3 py-2 disabled:opacity-50"
          >
            Remove creator
          </button>
          {reason.trim().length === 0 && (
            <p className="text-xs text-rose-800 mt-2">A reason is required.</p>
          )}
        </section>
      )}

      {cascade && (
        <section className="rounded-xl border border-slate-300 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">What removal did</h2>
          <ul className="text-sm text-slate-800 mt-2 space-y-1">
            <li>Storefront taken down and new bookings blocked.</li>
            <li>{cascade.applications_withdrawn} open application(s) withdrawn.</li>
            <li>{cascade.offers_withdrawn} open custom offer(s) withdrawn.</li>
            <li>
              {cascade.pending_orders_cancelled.length} not-yet-accepted request(s) cancelled, their
              card holds released.
            </li>
            <li>
              {cascade.in_progress_untouched.length} job(s) in progress left running. They finish and
              pay out normally.
            </li>
          </ul>
          {cascade.pending_orders_failed.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-medium">These need a person:</div>
              <ul className="mt-1 space-y-1">
                {cascade.pending_orders_failed.map((f) => (
                  <li key={f.order_id}>
                    Order {f.order_id}: {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function laneLabel(lane: string): string {
  if (lane === "ugc_video") return "videos for brands' ads";
  return lane;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-slate-900 break-words">{value}</dd>
    </div>
  );
}
