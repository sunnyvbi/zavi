"use client";
import { useId, useState, type ReactNode } from "react";
import type { CampaignDraft } from "@zavi/shared";
import { AdsSheet, sheetFooterButton } from "./AdsSheet";
import { CampaignPreview, type PreviewRow } from "./CampaignPreview";
import type { NewCampaignState } from "./editorSave";

export type CreateLevel = "campaign" | "group" | "ad";
export type CreateSubmit = { label: string; disabled: boolean; reason: string };
export type CreateFormProps = { formId: string; busy: boolean; state: NewCampaignState; onSubmitState: (s: CreateSubmit) => void; onSave: (body: Record<string, unknown>) => void };

export const httpsLink = (value: string) => /^https:\/\/\S+\.\S+/.test(value.trim());

export function createReason(state: NewCampaignState, noun: string, platform: string, issues: string[]): string {
  if (state === "done") return `Created. Refresh the list to see the new ${noun}.`;
  if (state === "sending") return `Creating the ${noun} in ${platform}. It shows in the list once ${platform} has it.`;
  if (state === "waiting") return "It is waiting in Approvals. Approve it there to create it.";
  return issues[0] ?? "";
}

export function CreateSheet({ slug, title, busy, closed, submit, formId, onClose, children }: {
  slug: string;
  title: string;
  busy: boolean;
  closed: boolean;
  submit: CreateSubmit;
  formId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const reasonId = useId();
  return (
    <AdsSheet
      size="wide"
      titleId={titleId}
      title={title}
      slug={slug}
      busy={busy}
      onClose={onClose}
      cancelLabel={closed ? "Close" : "Cancel"}
      footer={
        <>
          <p id={reasonId} role="status" className="order-first min-w-0 basis-full text-[13px] leading-5 text-inkSoft sm:order-none sm:flex-1 sm:basis-auto">{submit.reason}</p>
          <button type="submit" form={formId} className={`${sheetFooterButton} shrink-0 bg-ink text-cream`} aria-describedby={submit.reason ? reasonId : undefined} disabled={submit.disabled || busy}>
            {busy ? "Saving…" : submit.label}
          </button>
        </>
      }
    >
      <div className="space-y-6">{children}</div>
    </AdsSheet>
  );
}

export function CreateColumns({ slug, card, ad, rows, note, children }: { slug: string; card?: ReactNode; ad?: CampaignDraft["ads"][number]; rows: PreviewRow[]; note: string; children: ReactNode }) {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_336px]">
      <div className="min-w-0">{children}</div>
      <CampaignPreview slug={slug} card={card} ad={ad} rows={rows} note={note} />
    </div>
  );
}

function siteOf(link: string): string | null {
  try { return new URL(link.trim()).hostname.replace(/^www\./, ""); }
  catch { return null; }
}

export function AdCard({ text, headline, link, image, button }: { text: string; headline: string; link: string; image?: string; button?: string }) {
  const [broken, setBroken] = useState("");
  const site = siteOf(link);
  const brand = site ? site.split(".")[0].replace(/^./, (c) => c.toUpperCase()) : "Your business";
  const src = image && httpsLink(image) && broken !== image ? image.trim() : null;
  return (
    <div data-testid="create-preview-ad" className="overflow-hidden rounded-2xl border border-ca-border bg-ca-bg shadow-sm">
      <div className="flex items-center gap-3 p-4">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-ca-xdark text-[14px] font-semibold text-ca-bg">{brand.charAt(0)}</span>
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold leading-5 text-ca-xdark">{brand}</p>
          <p className="text-[12px] leading-4 text-ca-secondary">Sponsored</p>
        </div>
      </div>
      <p className={`break-words px-4 pb-3 text-[14px] leading-5 ${text.trim() ? "text-ca-primary" : "text-ca-secondary"}`}>{text.trim() || "Your ad text shows here."}</p>
      {src && <img src={src} alt="" className="aspect-video w-full object-cover" onError={() => setBroken(image ?? "")} />}
      <div className="flex items-center justify-between gap-3 bg-ca-subtle p-4">
        <div className="min-w-0">
          {site && <p className="truncate text-[12px] uppercase leading-4 text-ca-secondary">{site}</p>}
          <p className={`break-words text-[14px] font-semibold leading-5 ${headline.trim() ? "text-ca-xdark" : "text-ca-secondary"}`}>{headline.trim() || "Your headline"}</p>
        </div>
        {button && <span className="shrink-0 rounded-lg bg-ca-bg px-3 py-1.5 text-[13px] font-semibold leading-5 text-ca-xdark">{button}</span>}
      </div>
    </div>
  );
}
