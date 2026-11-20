"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { ApprovalDecision } from "@/lib/shopify-app-home/client";
import type { AppHomeApproval } from "@/lib/shopify-app-home/types";
import { AppHomeCard, AppHomeCardHeader, ExternalLink } from "./AppHomeCard";

const CHANNEL_MARK: Record<string, { text: string; className: string }> = {
  instagram_organic: { text: "IG", className: "bg-pink-600" },
  meta_ads: { text: "M", className: "bg-blue-600" },
  email_marketing: { text: "@", className: "bg-slate-600" },
};

function ChannelMark({ channel }: { channel: string | null }) {
  const mark = (channel && CHANNEL_MARK[channel]) || { text: "Z", className: "bg-neutral-900" };
  return <span aria-hidden="true" className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white", mark.className)}>{mark.text}</span>;
}

type Props = {
  rows: AppHomeApproval[];
  allApprovalsUrl: string;
  onDecide: (row: AppHomeApproval, decision: ApprovalDecision) => Promise<{ ok: true } | { ok: false; message: string }>;
};

export function ApprovalsCard({ rows, allApprovalsUrl, onDecide }: Props) {
  const [visible, setVisible] = useState(rows);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});

  async function decide(row: AppHomeApproval, decision: ApprovalDecision) {
    if (!row.one_click_approvable) {
      window.open(row.review_url, "_blank", "noopener,noreferrer");
      return;
    }
    setBusy(row.id);
    setFailed((f) => ({ ...f, [row.id]: "" }));
    try {
      const result = await onDecide(row, decision);
      if (result.ok) setVisible((v) => v.filter((r) => r.id !== row.id));
      else setFailed((f) => ({ ...f, [row.id]: result.message }));
    } catch {
      setFailed((f) => ({ ...f, [row.id]: "Could not update this approval. Try again or open Zavi." }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppHomeCard>
      <AppHomeCardHeader
        title="Waiting for your approval"
        className="pb-4"
        aside={visible.length > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[12px] font-medium text-amber-800">{visible.length}</span>}
      />
      {visible.length === 0 ? (
        <p className="border-t border-neutral-200 px-4 py-6 text-center text-[13px] text-neutral-500">Nothing to approve. On a paid plan, Zavi asks here before it posts, sends or spends.</p>
      ) : (
        <ul>
          {visible.map((row) => (
            <li key={row.id} className="flex flex-col gap-3 border-t border-neutral-200 px-4 py-4 sm:flex-row sm:items-start">
              <div className="flex min-w-0 flex-1 gap-3">
                <ChannelMark channel={row.channel} />
                <div className="min-w-0 space-y-1 text-[13px]">
                  <p className="font-semibold text-neutral-900">{row.title}</p>
                  <p className="text-neutral-700">{row.consequence}</p>
                  {failed[row.id] && <p role="alert" className="text-danger">{failed[row.id]}</p>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2 pl-11 sm:pl-0">
                {row.preview_url && <ExternalLink href={row.preview_url} className="text-neutral-900">Preview</ExternalLink>}
                <Button className="h-8 px-3" disabled={busy === row.id} onClick={() => void decide(row, "approve")}>Approve</Button>
                <button type="button" disabled={busy === row.id} onClick={() => void decide(row, "reject")} className="px-2 text-[13px] font-medium text-neutral-900 hover:underline disabled:opacity-50">Reject</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-neutral-200 px-4 py-3">
        <ExternalLink href={allApprovalsUrl}>Edit drafts and see all approvals in Zavi</ExternalLink>
      </div>
    </AppHomeCard>
  );
}
