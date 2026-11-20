"use client";

import { type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { ActionItem } from "./types";
import { signupPreviewWeeks } from "@/lib/workspace/channelActionsApi";
import { channelMark } from "../channelMark";
import { ChannelActionFrame } from "./ChannelActionFrame";
import { AdsActionFrame } from "./ads/AdsActionFrame";
import { cn } from "@/lib/cn";
import { useAdsPresentation } from "./ads/AdsPresentation";

export function Mark({ slug, fallback: Fallback }: { slug: string; fallback?: LucideIcon }) {
  const m = channelMark(slug);
  if (m.kind === "logo") {
    return (
      <span data-testid="action-mark" aria-hidden className={`inline-flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded ${m.bg}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={m.src} alt="" className={m.fit === "cover" ? "h-full w-full object-cover" : "h-3 w-3 object-contain"} />
      </span>
    );
  }
  const Icon = m.Icon ?? Fallback;
  if (!Icon) return null;
  return (
    <span data-testid="action-mark" aria-hidden className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded ${m.bg}`}>
      <Icon className={`h-3 w-3 ${m.fg}`} />
    </span>
  );
}

export function PaneCaption({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-inkMuted">{children}</p>;
}

export function Pane({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-rule/70 bg-cream p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_-6px_rgb(0_0_0/0.08)] ${className}`}>{children}</div>;
}

export function isLongDeliverable(content: string): boolean {
  return content.split("\n").length > 8 || content.length > 420;
}

export function ClampedPane({ children, testId }: { long: boolean; children: ReactNode; testId?: string }) {
  return <div data-testid={testId}>{children}</div>;
}

export function BlockingPill() {
  return (
    <span
      data-testid="blocking-pill"
      title="Other cards on this channel wait on this"
      className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-px text-[12px] font-semibold text-amber-700"
    >
      Blocking
    </span>
  );
}

function Flags({ a, isNew }: { a: SplitCardItem; isNew?: boolean }) {
  const weeks = signupPreviewWeeks(a);
  const flags: Array<{ text: string; tone: string }> = [];
  if (isNew) flags.push({ text: "New", tone: "text-emerald-600" });
  if (a.redo_of) flags.push({ text: "Rewritten", tone: "text-inkMuted" });
  if (weeks !== null) flags.push({ text: `${weeks} wk old`, tone: "text-inkMuted" });
  return (
    <>
      {flags.map((f) => (
        <span key={f.text} className={`text-[12px] font-medium ${f.tone}`}>
          · {f.text}
        </span>
      ))}
    </>
  );
}

export type SplitCardItem = Pick<ActionItem, "id" | "action_type" | "channel_slug" | "title"> & {
  source: string;
} & Partial<Pick<ActionItem, "run_id" | "blocking" | "redo_of" | "from_signup_preview_at" | "body" | "card_kind" | "exec_status" | "exec_waiting" | "status" | "exec_bucket" | "exec_code" | "approval" | "exec_started_at">>;

export function SplitCard({
  a,
  icon: Icon,
  kind,
  isNew,
  lead,
  why,
  bring,
  below,
  right,
  footer,
  status,
  banner,
  pick,
  approving,
}: {
  approving?: boolean;
  a: SplitCardItem;
  icon?: LucideIcon;
  kind?: string;
  isNew?: boolean;
  lead?: ReactNode;
  why?: ReactNode;
  bring?: { value: string; caption: string } | null;
  below?: ReactNode;
  right: ReactNode | null;
  footer?: ReactNode;
  status?: ReactNode;
  banner?: ReactNode;
  pick?: ReactNode;
}) {
  const ads = useAdsPresentation();
  if (ads) return <AdsActionFrame a={a} kind={kind} isNew={isNew} lead={lead} why={why} bring={bring} below={below} right={right} footer={footer} status={status} banner={banner} approving={approving} />;
  return <ChannelActionFrame a={a} kind={kind} lead={lead} why={why} bring={bring} below={below} right={right} footer={footer} status={status} banner={banner} pick={pick} approving={approving} header={<p className={cn("flex flex-wrap items-center gap-2 text-sm font-semibold text-inkSoft")}>
    <Mark slug={a.channel_slug} fallback={Icon} />
    {a.blocking && <BlockingPill />}
    {kind && <span data-testid="action-kind">{kind}</span>}
    <Flags a={a} isNew={isNew} />
  </p>} />;
}
