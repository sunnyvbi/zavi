"use client";

import { Check, Clock, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { CardApproval, CardTimelineEvent } from "@/lib/workspace/channelActionsApi";
import { SideDrawer } from "../layout/SideDrawer";
import { approverWho, clockTime, shortDay } from "./statusWords";
import type { ActionItem } from "./types";

function eventWords(e: CardTimelineEvent, approval: CardApproval | null | undefined, platformName: string): { who: string; text: string } {
  switch (e.kind) {
    case "proposed": return { who: "Zavi", text: "proposed this" };
    case "approved": {
      const latest = approval && e.at === approval.at ? approval : null;
      const by = e.by ?? latest?.by ?? null;
      const name = by === "teammate" && latest?.by === "teammate" ? latest.name : null;
      return { who: by ? approverWho(by, name) : "Someone", text: "approved it" };
    }
    case "sent": return { who: "Zavi", text: `sent the change to ${platformName}` };
    case "executed": return { who: platformName, text: "took the change" };
    case "failed": return { who: platformName, text: "did not take the change" };
    case "refused": return { who: platformName, text: "refused this change" };
    case "revised": return { who: "Zavi", text: "revised the change" };
  }
}

function EventIcon({ kind }: { kind: CardTimelineEvent["kind"] | "held" | "next" }) {
  const base = "grid size-6 shrink-0 place-items-center rounded-full";
  switch (kind) {
    case "proposed": case "revised": return <span className={cn(base, "bg-creamDeep")}><Sparkles className="size-3.5 text-inkMuted" aria-hidden /></span>;
    case "held": return <span className={cn(base, "bg-warnBg")}><ShieldCheck className="size-3.5 text-warn" aria-hidden /></span>;
    case "approved": return <span className={cn(base, "bg-ink")}><Check className="size-3.5 text-cream" aria-hidden /></span>;
    case "sent": return <span className={cn(base, "bg-creamDeep")}><Send className="size-3.5 text-inkMuted" aria-hidden /></span>;
    case "executed": return <span className={cn(base, "bg-successBg")}><Check className="size-3.5 text-success" aria-hidden /></span>;
    case "failed": case "refused": return <span className={cn(base, "bg-dangerBg")}><X className="size-3.5 text-danger" aria-hidden /></span>;
    case "next": return <span className={cn(base, "border border-dashed border-rule")}><Clock className="size-3.5 text-inkLight" aria-hidden /></span>;
  }
}

export function CardHistoryDrawer({ a, events, platformName, onClose }: { a: ActionItem; events: CardTimelineEvent[]; platformName: string; onClose: () => void }) {
  const rows: Array<{ key: string; kind: Parameters<typeof EventIcon>[0]["kind"]; who: string; text: string; at: string; future?: boolean }> = events.map((e, i) => ({
    key: `${e.kind}-${i}`,
    kind: e.kind,
    ...eventWords(e, a.approval, platformName),
    at: clockTime(e.at),
  }));
  if (a.held?.words.length) {
    const at = rows.findIndex((r) => r.kind === "approved");
    rows.splice(at < 0 ? rows.length : at, 0, { key: "held", kind: "held", who: "Autopilot", text: `held it for you: ${a.held.words.join("; ")}`, at: "" });
  }
  if (a.outcome && !a.outcome.verdict && a.outcome.readout_on) {
    rows.push({ key: "next", kind: "next", who: "Zavi", text: "checks the results of this test", at: `on ${shortDay(a.outcome.readout_on)}`, future: true });
  }
  return (
    <SideDrawer title="History" onClose={onClose}>
      <div data-testid="card-history">
        <p className="text-[16px] font-semibold text-ink">{a.title}</p>
        <ol className="mt-5 space-y-3">
          {rows.map((r, i) => (
            <li key={r.key} data-event={r.kind} className="relative flex gap-3">
              {i < rows.length - 1 && <span className="absolute left-3 top-6 h-[calc(100%-12px)] w-px bg-rule" aria-hidden />}
              <EventIcon kind={r.kind} />
              <p className={cn("min-w-0 flex-1 text-[14px] leading-6", r.future ? "text-inkLight" : "text-inkSoft")}>
                <span className="font-semibold">{r.who}</span> {r.text}
                {r.at && <span className="ml-2 text-[13px] tabular-nums text-inkLight">{r.at}</span>}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </SideDrawer>
  );
}
