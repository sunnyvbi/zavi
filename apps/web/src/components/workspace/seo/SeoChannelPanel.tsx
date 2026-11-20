"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { cx, FOCUS_RING } from "../layout/shared";
import { SeoPerformanceSections } from "./SeoPerformanceSections";
import { SeoChip, SeoSectionLabel } from "./ui";
import type { SeoPerformanceReport } from "./types";

type SeoDashboardPayload = {
  connected?: boolean;
  performance?: SeoPerformanceReport | null;
};

function SearchConsoleBand({
  connected,
  onConnect,
}: {
  connected: boolean;
  onConnect: () => void;
}) {
  if (connected) {
    return (
      <section>
        <SeoSectionLabel right={<SeoChip tone="pass">Connected</SeoChip>}>
          What people searched to get here
        </SeoSectionLabel>
        <p className="text-[13px] leading-[1.5] text-inkMuted">
          Clicks, impressions and average position are on the Analytics tab, where
          the full history lives.
        </p>
      </section>
    );
  }
  return (
    <section>
      <SeoSectionLabel right={<SeoChip tone="locked">Not connected</SeoChip>}>
        What people searched to get here
      </SeoSectionLabel>
      <div className="rounded-xl border border-dashed border-rule bg-white px-3.5 py-3">
        <p className="text-[13px] leading-[1.5] text-inkMuted">
          Clicks, impressions and the queries you already rank for need Search
          Console. Nothing above depends on it. Connecting fills this in on the
          next run.
        </p>
        <button
          type="button"
          onClick={onConnect}
          className={cx(
            "mt-2 text-[13px] font-medium text-ink underline underline-offset-2 hover:text-inkSoft",
            FOCUS_RING,
          )}
        >
          Connect Search Console
        </button>
      </div>
    </section>
  );
}

export function SeoChannelPanel({
  connected,
  lastWorkedLabel,
  onOpenConnectors,
}: {
  connected: boolean;
  lastWorkedLabel: string;
  onOpenConnectors: () => void;
}) {
  const [payload, setPayload] = useState<SeoDashboardPayload | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch("/api/agents/seo-geo/dashboard");
        if (!res.ok) return;
        const body = (await res.json()) as SeoDashboardPayload;
        if (live) setPayload(body);
      } catch {
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const report = payload?.performance ?? null;
  const searchConsoleConnected = payload?.connected ?? connected;

  return (
    <div className="mt-4 flex flex-col gap-5">
      <p className="text-[12px] leading-5 text-inkMuted">Last worked {lastWorkedLabel}</p>
      <SeoPerformanceSections report={report} />
      <SearchConsoleBand
        connected={searchConsoleConnected}
        onConnect={onOpenConnectors}
      />
    </div>
  );
}
