"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  bookingTarget,
  formatUsd,
  laneLabel,
  locationLabel,
  type CreatorSearchResponse,
  type CreatorSearchResult,
} from "@/lib/creator-storefront";
import { useHumanResource } from "./useHumanResource";
import { HumanSectionShell } from "./HumanSectionShell";
import { HumanSectionTabs } from "./HumanSectionTabs";
import {
  HumanEmpty,
  HumanError,
  HumanNotBuilt,
  HumanSessionExpired,
  HumanSkeleton,
} from "./HumanStates";

type Filters = {
  order: string;
  lane: string;
  platform: string;
  niches: string;
  maxPriceUsd: string;
  maxDeliveryDays: string;
  city: string;
  country: string;
};

const EMPTY: Filters = {
  order: "newest",
  lane: "",
  platform: "",
  niches: "",
  maxPriceUsd: "",
  maxDeliveryDays: "",
  city: "",
  country: "",
};

const PLATFORMS = ["tiktok", "instagram", "youtube", "x", "other"];

function buildPath(f: Filters): string {
  const q = new URLSearchParams();
  q.set("order", f.order);
  if (f.lane) q.set("lane", f.lane);
  if (f.platform) q.set("platform", f.platform);
  const niches = f.niches
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (niches.length > 0) q.set("niches", niches.join(","));
  const price = Number(f.maxPriceUsd);
  if (f.maxPriceUsd.trim() !== "" && Number.isFinite(price) && price > 0) {
    q.set("max_price_cents", String(Math.round(price * 100)));
  }
  const days = Number(f.maxDeliveryDays);
  if (f.maxDeliveryDays.trim() !== "" && Number.isInteger(days) && days > 0) {
    q.set("max_delivery_days", String(days));
  }
  if (f.city.trim()) q.set("city", f.city.trim());
  if (f.country.trim()) q.set("country_code", f.country.trim().toUpperCase());
  return `/api/humans/creators/search?${q.toString()}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[14px] text-inkMuted">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-ink/40";

export function CreatorListSummary({
  count,
  orderLabel,
  neutralityNote,
}: {
  count: number;
  orderLabel: string;
  neutralityNote: string;
}) {
  return (
    <>
      <p className="text-[13px] text-inkMuted">
        {count === 0
          ? "No creator matches these filters yet."
          : `${count} creator${count === 1 ? "" : "s"} so far, you are seeing every one that matches.`}{" "}
        Order: {orderLabel}.
      </p>
      <p className="mt-1 text-[13px] text-inkMuted">{neutralityNote}</p>
    </>
  );
}

export function CreatorRow({
  c,
  briefId,
  selfReportedLabel,
}: {
  c: CreatorSearchResult;
  briefId: string | null;
  selfReportedLabel: string;
}) {
  const place = locationLabel(c.location);
  return (
    <li className="rounded-xl border border-ink/12 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-display text-[14px] font-semibold text-ink">{c.display_name}</p>
        {c.from_price_cents !== null ? (
          <p className="text-[13px] text-inkMuted">
            from {formatUsd(c.from_price_cents)}
            {c.from_price_business_total_cents !== null ? (
              <> ({formatUsd(c.from_price_business_total_cents)} with the Zavi fee)</>
            ) : null}
          </p>
        ) : null}
      </div>

      <p className="mt-1.5 text-[13px] text-inkMuted">
        {[place, c.lanes.map(laneLabel).filter(Boolean).join(" and "), c.platforms.join(", ")]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {c.niches.length > 0 ? (
        <p className="mt-1.5 text-[13px] text-inkMuted">{c.niches.join(", ")}</p>
      ) : null}

      {c.handles.length > 0 ? (
        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-inkMuted">
          {c.handles.map((h) => (
            <li key={`${h.platform}:${h.handle}`}>
              {h.url ? (
                <a href={h.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                  {h.platform} @{h.handle}
                </a>
              ) : (
                <span>
                  {h.platform} @{h.handle}
                </span>
              )}
              {h.followers !== null ? <> · {h.followers.toLocaleString("en-US")} followers</> : null}
            </li>
          ))}
          <li className="text-[12px]">({selfReportedLabel})</li>
        </ul>
      ) : c.self_reported_audience.length > 0 ? (
        <p className="mt-1.5 text-[13px] text-inkMuted">
          {c.self_reported_audience.map((a) => `${a.value} ${a.label}`).join(" · ")}{" "}
          <span>({selfReportedLabel})</span>
        </p>
      ) : null}

      <div className="mt-3">
        {c.bookable ? (
          c.packages.length > 0 ? (
            <ul className="space-y-1.5">
              {c.packages.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px] text-ink">
                    {p.title} · {formatUsd(p.pricing.price_cents)} · {p.delivery_days} days
                  </span>
                  <a
                    href={bookingTarget(p.id, briefId)}
                    className="inline-flex items-center rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-cream hover:bg-ink/90"
                  >
                    Book
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-inkMuted">No packages yet.</p>
          )
        ) : (
          <p className="rounded-lg border border-ink/12 bg-ink/[0.04] px-3 py-2 text-[12px] text-inkMuted">
            {c.not_bookable_message ?? "Cannot be booked yet."}
          </p>
        )}
      </div>
    </li>
  );
}

export function FindCreatorsIsland({
  preselectedCreator,
  preselectedPackage,
  briefId = null,
}: {
  preselectedCreator?: string;
  preselectedPackage?: string;
  briefId?: string | null;
}) {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const path = useMemo(() => buildPath(applied), [applied]);
  const state = useHumanResource<CreatorSearchResponse>(path);

  const set = (k: keyof Filters, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const data = state.data;
  const creators = data?.creators ?? [];
  const orderApplied = data?.order_applied ?? applied.order;
  const orderLabel =
    data?.order_options?.find((o) => o.value === orderApplied)?.label ?? orderApplied;

  return (
    <HumanSectionShell
      title="Find creators"
      lede="Every approved creator on Zavi who matches your filters, with their accounts, packages and prices."
    >
      <HumanSectionTabs active="/humans/creators" />
      {preselectedCreator && preselectedPackage ? (
        <div className="mb-6 rounded-xl border border-ink/15 bg-white px-4 py-3.5">
          <p className="text-[13px] font-medium text-ink">
            Ready to book {preselectedCreator}
          </p>
          <p className="mt-1 text-[13px] leading-[1.5] text-inkMuted">
            Your workspace is set up and the package you picked is saved. Nothing has been
            charged yet.
          </p>
          <Link
            href={`/humans/book?package_id=${encodeURIComponent(preselectedPackage)}${
              briefId ? `&brief_id=${encodeURIComponent(briefId)}` : ""
            }`}
            className="mt-3 inline-flex items-center rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-cream hover:bg-ink/90"
          >
            Review and book
          </Link>
        </div>
      ) : null}

      <form
        className="grid gap-3 rounded-xl border border-ink/12 bg-white/60 p-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
        }}
      >
        <Field label="What you need">
          <select
            className={inputClass}
            value={draft.lane}
            onChange={(e) => set("lane", e.target.value)}
          >
            <option value="">Any</option>
            <option value="ugc_video">Videos for your ads</option>
          </select>
        </Field>

        <Field label="Platform">
          <select
            className={inputClass}
            value={draft.platform}
            onChange={(e) => set("platform", e.target.value)}
          >
            <option value="">Any</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Niches (comma separated)">
          <input
            className={inputClass}
            value={draft.niches}
            onChange={(e) => set("niches", e.target.value)}
            placeholder="beauty, fitness"
          />
        </Field>

        <Field label="Most you want to pay (USD)">
          <input
            className={inputClass}
            inputMode="decimal"
            value={draft.maxPriceUsd}
            onChange={(e) => set("maxPriceUsd", e.target.value)}
            placeholder="250"
          />
        </Field>

        <Field label="Days to deliver, at most">
          <input
            className={inputClass}
            inputMode="numeric"
            value={draft.maxDeliveryDays}
            onChange={(e) => set("maxDeliveryDays", e.target.value)}
            placeholder="7"
          />
        </Field>

        <Field label="City">
          <input
            className={inputClass}
            value={draft.city}
            onChange={(e) => set("city", e.target.value)}
            placeholder="Nashville"
          />
        </Field>

        <Field label="Country (2 letters)">
          <input
            className={inputClass}
            maxLength={2}
            value={draft.country}
            onChange={(e) => set("country", e.target.value)}
            placeholder="US"
          />
        </Field>

        <Field label="Order">
          <select
            className={inputClass}
            value={draft.order}
            onChange={(e) => set("order", e.target.value)}
          >
            {}
            <option value="newest">Newest first</option>
            <option value="a_to_z">A to Z</option>
          </select>
        </Field>

        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
          <button
            type="submit"
            className="rounded-full border border-transparent bg-ink px-4 py-2 text-[13px] font-medium text-cream hover:bg-ink/90"
          >
            Apply filters
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(EMPTY);
              setApplied(EMPTY);
            }}
            className="rounded-full border border-ink/15 px-4 py-2 text-[13px] text-ink hover:bg-ink/[0.04]"
          >
            Clear
          </button>
        </div>
      </form>

      <div className="mt-6">
        {state.sessionExpired ? (
          <HumanSessionExpired next="/humans/creators" />
        ) : state.notBuilt ? (
          <HumanNotBuilt what="Find creators" />
        ) : state.error ? (
          <HumanError message={state.error} onRetry={state.reload} />
        ) : state.loading ? (
          <HumanSkeleton rows={3} />
        ) : (
          <>
            {}
            <CreatorListSummary
              count={creators.length}
              orderLabel={orderLabel}
              neutralityNote={
                data?.neutrality_note ??
                "Zavi does not rank creators and does not pick one for you."
              }
            />

            {creators.length === 0 ? (
              <div className="mt-4">
                <HumanEmpty
                  title="Nobody matches those filters yet"
                  body="The creator network is new and small. Widen the niches or the price, or post a brief and let creators apply to you."
                />
              </div>
            ) : (
              <ul className="mt-4 space-y-3">
                {creators.map((c) => (
                  <CreatorRow
                    key={c.human_member_id || c.slug}
                    c={c}
                    briefId={briefId}
                    selfReportedLabel={data?.self_reported_label ?? "Self-reported, not checked by Zavi"}
                  />
                ))}
              </ul>
            )}

            {data?.self_reported_note ? (
              <p className="mt-4 text-[12px] text-inkMuted">{data.self_reported_note}</p>
            ) : null}
          </>
        )}
      </div>
    </HumanSectionShell>
  );
}
