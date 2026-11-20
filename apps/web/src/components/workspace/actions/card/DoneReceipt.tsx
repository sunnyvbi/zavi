"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { receiptLinkLabel } from "@zavi/shared";
import type { ActionItem } from "../types";
import { CardHistoryDrawer } from "../CardHistoryDrawer";
import { outcomeLine } from "../statusWords";

export function DoneReceipt({ a, platformName }: { a: ActionItem; platformName: string }) {
  const [history, setHistory] = useState(false);
  const receipt = a.exec_receipt ?? null;
  const timeline = a.timeline?.length ? a.timeline : null;
  if (!receipt && !a.outcome && !timeline) return null;
  return (
    <div className="flex flex-col gap-1 text-ca-action text-ca-secondary">
      {a.outcome && <p data-testid="exec-outcome" data-verdict={a.outcome.verdict ?? "pending"}>{outcomeLine(a.outcome)}</p>}
      {(receipt || timeline) && (
        <p className="flex flex-wrap items-center gap-x-2">
          {receipt && <span data-testid="exec-receipt">{receipt.line}</span>}
          {receipt?.url && (
            <a href={receipt.url} target="_blank" rel="noopener noreferrer" data-testid="exec-receipt-link" className="inline-flex items-center gap-1 font-medium text-ca-xdark underline underline-offset-2">
              {receiptLinkLabel(receipt.url)}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
          {timeline && (
            <button type="button" data-testid="exec-history" onClick={() => setHistory(true)} className="font-semibold text-ca-xdark underline underline-offset-2">History</button>
          )}
        </p>
      )}
      {history && timeline && <CardHistoryDrawer a={a} events={timeline} platformName={platformName} onClose={() => setHistory(false)} />}
    </div>
  );
}
