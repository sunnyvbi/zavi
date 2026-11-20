"use client";

import { useEffect, useState } from "react";
import { Markdown } from "../Markdown";
import type { ChannelPlan } from "@/lib/workspace/channelActionsApi";
import { CardShell } from "./card/CardShell";
import { CardEyebrow } from "./card/CardEyebrow";
import { CardButton } from "./card/CardButton";
import { InfoDialog, TextDialog } from "./card/CardDialogs";
import { StatusLine } from "./card/blocks/StatusLine";
import { clipText, LEAD_MAX } from "./card/cardModel";
import { cardText } from "./card/styles";

function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function firstParagraph(markdown: string): string {
  const prose = markdown.split(/\n{2,}/).map((p) => p.trim()).find((p) => p && !/^#/.test(p) && !/^\s*(?:[-*]|\d+[.)])\s/.test(p));
  return prose ? clipText(prose, LEAD_MAX) : "";
}

export function ChannelPlanBlock({ plan, channelName, writing, onChange }: {
  plan: ChannelPlan;
  channelName: string;
  writing: boolean;
  onChange: (note: string) => Promise<boolean>;
}) {
  const [dialog, setDialog] = useState<null | "about" | "change">(null);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (sent && !writing) setSent(false);
  }, [sent, writing]);
  const changeable = plan.status === "pending" || plan.status === "snoozed";
  const dated = day(plan.proposed_at);
  const title = `Your ${channelName.toLowerCase()} plan`;
  const lead = firstParagraph(plan.content);
  const submit = async (note: string) => {
    const text = note.trim();
    if (!text) return;
    setSending(true);
    const ok = await onChange(text);
    setSending(false);
    if (ok) setSent(true);
  };
  const actions = sent ? (
    <span className="ml-auto"><StatusLine tone="muted">Zavi is writing a new plan with your note.</StatusLine></span>
  ) : changeable ? (
    <span className="ml-auto inline-flex items-center gap-1.5">
      <CardButton aria-haspopup="dialog" disabled={sending} onClick={() => setDialog("change")}>Change plan</CardButton>
    </span>
  ) : null;
  return (
    <div data-testid="channel-plan">
      <CardShell
        id={`plan-${plan.id}`}
        title={title}
        eyebrow={<CardEyebrow kind="Plan" meta={[dated ? `Written ${dated}` : null, "Saved automatically"].filter((m): m is string => !!m)} />}
        actions={actions}
        steps={["Every run drafts from this plan.", "Press Change plan and say what should change.", "Zavi writes a new plan. It replaces this one when the run finishes."]}
        onAbout={() => setDialog("about")}
      >
        {lead && <p data-testid="channel-plan-content" className={cardText.body}>{lead}</p>}
      </CardShell>
      <InfoDialog open={dialog === "about"} title={title} about={<Markdown source={plan.content} disableActionLinks />} onClose={() => setDialog(null)} />
      <TextDialog open={dialog === "change"} heading="Change plan" subtitle="What should change?" initial="" placeholder="e.g. Focus on first-time buyers. Drop the comparison posts." submit="Send" onSubmit={(note) => void submit(note)} onClose={() => setDialog(null)} />
    </div>
  );
}
