"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { BUSINESS_FEE_BPS } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import type { BriefApplicantsResponse } from "@/components/humans/humanPostedBriefs";
import type { CreatorSearchResult } from "@/lib/creator-storefront";
import { CardButton } from "../actions/card/CardButton";
import { cardText } from "../actions/card/styles";
import { firstName, money, useUgcDrawer } from "./hub";
import { useCreatorCards } from "./useCards";

function PaneList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className={cardText.label}>{label}</p>
      <ul className="flex flex-col divide-y divide-ca-border rounded-xl border border-ca-border">{children}</ul>
    </div>
  );
}

const row = "flex flex-col gap-1 px-4 py-3";
const head = "flex items-baseline justify-between gap-3 text-ca-row";
const sub = "text-ca-action text-ca-secondary";

export function ApplicantsPane({ briefId }: { briefId: string }) {
  const drawer = useUgcDrawer();
  const [data, setData] = useState<BriefApplicantsResponse | null>(null);
  useEffect(() => {
    let alive = true;
    void apiFetch(`/api/humans/briefs/${encodeURIComponent(briefId)}/applicants`)
      .then((r) => (r.ok ? (r.json() as Promise<BriefApplicantsResponse>) : null))
      .catch(() => null)
      .then((r) => { if (alive) setData(r); });
    return () => { alive = false; };
  }, [briefId]);
  const applicants = (data?.applicants ?? []).slice(0, 3);
  const cards = useCreatorCards(applicants.map((a) => a.human_member_id));
  if (!data || applicants.length === 0) return null;
  const order = data.order.split(".")[0].trim().toLowerCase();
  return (
    <PaneList label={`Applicants, ${order}`}>
      {applicants.map((a) => {
        const social = cards[a.human_member_id]?.socials[0] ?? null;
        const hireable = a.bookable && Boolean(a.fees) && data.brief.open && (a.status === "applied" || a.status === "shortlisted");
        return (
          <li key={a.application_id} className={row}>
            <div className={head}>
              <span className="font-semibold text-ca-xdark">{a.display_name || "A Zavi creator"}</span>
              {a.fees && <span className="font-medium tabular-nums text-ca-xdark">{money(a.fees.price_cents)}</span>}
            </div>
            {social && (
              <p className={sub}>
                {social.followers !== null && `${social.followers.toLocaleString("en-US")} followers on ${social.platform}, self-reported`}
                {social.url && (
                  <a href={social.url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-0.5 font-semibold text-ca-primary underline underline-offset-4 hover:no-underline">
                    View<ArrowUpRight className="size-3.5" aria-hidden /><span className="sr-only">(opens in a new tab)</span>
                  </a>
                )}
              </p>
            )}
            <div className="mt-1 flex flex-wrap gap-1.5">
              <CardButton onClick={() => drawer.open("thread", { creator: a.human_member_id, brief: briefId })}>Message {firstName(a.display_name || "Creator")}</CardButton>
              {hireable && <CardButton variant="primary" onClick={() => drawer.open("hire", { application: a.application_id, brief: briefId })}>Hire and pay</CardButton>}
            </div>
          </li>
        );
      })}
    </PaneList>
  );
}

export function cheapestVideoPackage<P extends { kind: string; price_cents: number }>(packages: P[]): P | null {
  let best: P | null = null;
  for (const p of packages) if (p.kind === "ugc_video" && (!best || p.price_cents < best.price_cents)) best = p;
  return best;
}

export function BookPane({ creators }: { creators: CreatorSearchResult[] }) {
  const drawer = useUgcDrawer();
  const cards = useCreatorCards(creators.map((c) => c.human_member_id));
  if (creators.length === 0) return null;
  return (
    <PaneList label="Creators you can book now">
      {creators.map((c) => {
        const pkg = cheapestVideoPackage(cards[c.human_member_id]?.packages ?? []);
        return (
          <li key={c.human_member_id} className={row}>
            <div className={head}>
              <span className="font-semibold text-ca-xdark">{c.display_name}</span>
              {c.location.city && <span className={sub}>{c.location.city}</span>}
            </div>
            {pkg ? (
              <>
                <p className="text-ca-row text-ca-xdark">{pkg.title}, <span className="font-semibold">{money(pkg.price_cents)}</span></p>
                <p className={sub}>
                  {pkg.video_length_seconds ? `${pkg.video_length_seconds}s · ` : ""}ad rights {pkg.ad_rights_days} days · in {pkg.delivery_days} days
                </p>
                <p data-testid="book-fee-line" className={sub}>+ {money(pkg.business_total_cents - pkg.price_cents)} Zavi fee ({BUSINESS_FEE_BPS / 100}%)</p>
                <CardButton variant="primary" className="mt-1 self-start" onClick={() => drawer.open("hire", { package: pkg.id })}>
                  Book for {money(pkg.business_total_cents)}
                </CardButton>
              </>
            ) : (
              c.from_price_cents !== null && <p className={sub}>From {money(c.from_price_cents)}</p>
            )}
          </li>
        );
      })}
    </PaneList>
  );
}
