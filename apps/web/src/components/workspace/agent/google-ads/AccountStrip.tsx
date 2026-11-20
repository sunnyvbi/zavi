"use client";

import { useState } from "react";
import { ScheduleView } from "../ScheduleView";
import { btn } from "../dashboard-ui";
import { CONNECTOR_ICON } from "../../settings/connectorLogos";
import type { GadsPayload } from "./types";
import { NextChevron } from "@/components/ui/NextChevron";

export function GoogleMark({ className = "h-5 w-5" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={CONNECTOR_ICON.google_ads} alt="" aria-hidden className={className} />;
}

export function AccountStrip({ d }: { d: GadsPayload }) {
  const [open, setOpen] = useState(false);
  const name = d.account?.name;
  const n = d.account?.campaign_count;
  return (
    <div className="rounded-2xl border border-rule bg-creamDeep p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-rule bg-cream">
            <GoogleMark />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-ink">
              Google Ads{name ? ` · ${name}` : ""}
            </p>
            <p className="text-[16px] text-inkMuted">
              {n === null || n === undefined ? "Campaigns could not be read" : `${n} ${n === 1 ? "campaign" : "campaigns"}`} · Zavi proposes budget, keyword and status changes for you to approve.
            </p>
          </div>
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`${btn.primary} shrink-0`}>
          {open ? "Close" : <>Set up <NextChevron /></>}
        </button>
      </div>
      {open && (
        <div className="mt-4 rounded-xl border border-rule bg-cream p-3">
          <ScheduleView slug="google_ads" />
        </div>
      )}
    </div>
  );
}
