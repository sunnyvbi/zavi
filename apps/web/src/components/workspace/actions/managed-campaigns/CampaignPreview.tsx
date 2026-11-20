"use client";
import type { ReactNode } from "react";
import type { CampaignDraft } from "@zavi/shared";
import { ChannelMarkIcon } from "../../growth/GrowthChannelLabel";
import { useAdImagePreview } from "../ads/useAdImagePreview";

export type PreviewRow = { label: string; value: string };

function host(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return null; }
}

export function CampaignPreview({ slug, ad, rows, note, card }: { slug?: string; ad?: CampaignDraft["ads"][number]; rows: PreviewRow[]; note: string; card?: ReactNode }) {
  const { src } = useAdImagePreview(ad?.image_url ?? null);
  const site = host(ad?.target_url);
  return <aside aria-label="Live preview" className="min-w-0 space-y-4 lg:sticky lg:top-0 lg:self-start">
    <h3 className="flex items-center gap-2 text-[16px] font-semibold leading-6 text-ca-xdark">{slug && <ChannelMarkIcon slug={slug} compact />}Live preview</h3>
    {card ?? <div className="space-y-4 rounded-2xl border border-ca-border bg-ca-bg p-4 shadow-sm">
      <div aria-hidden className="space-y-2">
        <div className="h-2.5 w-full rounded-full bg-ca-subtle" />
        <div className="h-2.5 w-11/12 rounded-full bg-ca-subtle" />
        <div className="h-2.5 w-3/4 rounded-full bg-ca-subtle" />
      </div>
      <div data-testid="campaign-preview-ad" className="space-y-2 rounded-xl border border-ca-border p-3">
        <p className="text-[12px] leading-4 text-ca-secondary">Sponsored{site ? ` · ${site}` : ""}</p>
        {ad ? <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="break-words text-[14px] font-semibold leading-5 text-ca-xdark">{ad.title}</p>
            <p className="break-words text-[13px] leading-5 text-ca-primary">{ad.body}</p>
          </div>
          {src && <img src={src} alt="" className="size-14 shrink-0 rounded-lg object-cover" />}
        </div> : <div className="space-y-1">
          <p className="text-[14px] font-semibold leading-5 text-ca-secondary">Your ad headline</p>
          <p className="text-[13px] leading-5 text-ca-secondary">You add the ad's words and image after the campaign is saved.</p>
        </div>}
        {site && <p className="text-[12px] leading-4 text-ca-secondary">{site}</p>}
      </div>
    </div>}
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-[14px] leading-5">
      {rows.map((r) => <div key={r.label} className="contents">
        <dt className="text-ca-secondary">{r.label}</dt>
        <dd className="break-words font-medium text-ca-xdark">{r.value}</dd>
      </div>)}
    </dl>
    <p className="text-[12px] leading-[18px] text-ca-secondary">{note}</p>
  </aside>;
}
