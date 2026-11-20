"use client";

import { useState } from "react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { cardButton, cardLink } from "../actions/card/styles";
import { useChannelChatOpener } from "../actions/channelChat";
import type { CheckState } from "../actions/checklist";
import type { XPayload } from "../agent/XAgentDashboard";
import { xChecklistItems, type XCheckFix } from "../agent/xChecklist";

const CHIP: Record<CheckState, { word: string; tone: string }> = {
  fail: { word: "To do", tone: "bg-warnBg text-warn" },
  unknown: { word: "No data yet", tone: "bg-ca-subtle text-ca-dark" },
  pass: { word: "Passing", tone: "bg-ca-success-bg text-ca-success" },
};
const fixButton = cn(cardButton.base, cardButton.secondary);

function Fix({ fix }: { fix: XCheckFix }) {
  const openChat = useChannelChatOpener();
  if (fix.href) {
    return <a href={fix.href} target="_blank" rel="noopener noreferrer" aria-label={fix.title} className={fixButton}>{fix.label}<ArrowUpRight className="size-4" aria-hidden /></a>;
  }
  if (!openChat || !fix.chatDraft) return null;
  const text = fix.chatDraft;
  return <button type="button" aria-label={fix.title} className={fixButton} onClick={() => openChat({ target: "channel", draft: { text, nonce: Date.now() } })}>{fix.label}</button>;
}

export function XProfileChecklist({ checklist }: { checklist: NonNullable<XPayload["checklist"]> }) {
  const [showPassing, setShowPassing] = useState(false);
  const items = xChecklistItems(checklist);
  const passing = items.filter((i) => i.state === "pass").length;
  const todo = items.filter((i) => i.state === "fail").length;
  const total = items.length;
  const share = total > 0 ? Math.round((passing / total) * 100) : 0;
  const shown = showPassing ? items : items.filter((i) => i.state !== "pass");
  return (
    <section aria-labelledby="x-profile-checklist" data-testid="x-profile-checklist">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="x-profile-checklist" className="text-ca-title font-semibold text-ca-xdark">Profile checklist</h2>
        {total > 0 && <p className="text-ca-action text-ca-secondary">{todo} to do · {passing} passing</p>}
      </div>
      <div className="mt-3 overflow-hidden rounded-2xl border border-ca-border bg-ca-bg">
        {total === 0 ? (
          <p className="p-5 text-ca-action text-ca-secondary">Zavi has not checked this profile yet.</p>
        ) : (
          <>
            <div className="p-5">
              <p className="flex items-baseline justify-between gap-3 text-ca-action">
                <span className="font-semibold text-ca-xdark">{passing} of {total} checks pass</span>
                <span className="tabular-nums text-ca-secondary">{share}%</span>
              </p>
              <div role="progressbar" aria-label="Checks passing" aria-valuemin={0} aria-valuemax={total} aria-valuenow={passing} className="mt-3 h-1.5 overflow-hidden rounded-full bg-ca-subtle">
                <span className="block h-full rounded-full bg-ca-success transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${share}%` }} />
              </div>
            </div>
            <ul>
              {shown.map((item) => (
                <li key={item.key} data-testid="x-check" data-state={item.state} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ca-border px-5 py-4">
                  <span className="min-w-0 flex-1 basis-60">
                    <span className="block text-ca-facts font-semibold text-ca-xdark">{item.label}</span>
                    <span className="mt-0.5 block text-ca-action text-ca-secondary">{item.note}</span>
                  </span>
                  <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-medium leading-4", CHIP[item.state].tone)}>
                    <span aria-hidden className="size-1.5 rounded-full bg-current" />
                    {CHIP[item.state].word}
                  </span>
                  <span className="flex w-28 shrink-0 justify-end">{item.fix && <Fix fix={item.fix} />}</span>
                </li>
              ))}
            </ul>
            {passing > 0 && (
              <div className="border-t border-ca-border px-5 py-3">
                <button type="button" aria-expanded={showPassing} onClick={() => setShowPassing((v) => !v)} className={cardLink}>
                  {showPassing ? "Hide passing checks" : `Show ${passing} passing ${passing === 1 ? "check" : "checks"}`}
                  <ChevronDown className={cn("size-4 transition-transform motion-reduce:transition-none", showPassing && "rotate-180")} aria-hidden />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
