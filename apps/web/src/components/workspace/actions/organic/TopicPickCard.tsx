"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import type { ActionBodyProps } from "../types";
import { TopicPickCost, topicPickOf, type PickTopic } from "../TopicPick";
import { CardShell } from "../card/CardShell";
import { CardEyebrow } from "../card/CardEyebrow";
import { CardButton } from "../card/CardButton";
import { InfoDialog, TextDialog } from "../card/CardDialogs";
import { StatusLine } from "../card/blocks/StatusLine";
import { clipText, cardCopyOf, POINT_MAX } from "../card/cardModel";
import { Panels, type Panel } from "../ActionFooter";
import { useCardFlow } from "../card/useCardFlow";
import { useCardRunner } from "../card/useCardRunner";
import { useMoveToHistory } from "../card/useMoveToHistory";

function research(t: PickTopic): string {
  return [
    t.why,
    t.searches.length ? `What people search: ${t.searches.map((q) => `“${q}”`).join(", ")}` : null,
    t.ranks.length ? `Who shows up today: ${t.ranks.map((r) => r.site).join(", ")}` : null,
    t.your_site ? `Your site: ${t.your_site}` : null,
    t.have.length ? `What Zavi already has: ${t.have.map((h) => h.text).join("; ")}` : null,
    t.fill.length ? `You would fill: ${t.fill.join("; ")}` : "You would fill: nothing. Zavi has every fact it needs.",
  ].filter(Boolean).join("\n\n");
}

export function TopicPickCard({ action: a, handlers, busy, redoing }: ActionBodyProps) {
  const topics = topicPickOf(a) ?? [];
  const copy = cardCopyOf(a);
  const [pick, setPick] = useState(0);
  const [dialog, setDialog] = useState<null | "about" | "ask">(null);
  const [writing, setWriting] = useState(false);
  const { flow, send } = useCardFlow();
  const [panel, setPanel] = useState<Panel>(null);
  const runner = useCardRunner({ a, handlers, primary: null, send, onSteps: () => undefined });
  useMoveToHistory({ id: a.id, slug: a.channel_slug, title: copy.title, active: flow.s === "resolved" && flow.moving === true && !!runner.leave, history: !(flow.s === "resolved" && flow.away), onGone: () => runner.leave?.() });
  const topic = topics[Math.min(pick, topics.length - 1)];
  const write = handlers.onWriteProofPage;
  const working = writing || redoing === "working";
  const actions = flow.s === "resolved" ? (
    <span className="ml-auto inline-flex items-center gap-1.5 text-ca-action font-medium">
      <span role="status" className="text-ca-secondary">{flow.label}</span>
      {flow.undo && <CardButton variant="ghost" onClick={() => void runner.undo()}>Undo</CardButton>}
    </span>
  ) : (
    <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1.5">
      {handlers.onOpenChat && <CardButton aria-haspopup="dialog" onClick={() => setDialog("ask")}>Ask Zavi</CardButton>}
      <CardButton disabled={busy || working} onClick={() => setPanel("reject")}>Reject</CardButton>
      {write && (
        <CardButton variant="primary" data-primary disabled={busy || working} onClick={() => {
          setWriting(true);
          void Promise.resolve(write(a, pick)).then((ok) => { if (ok === false) setWriting(false); });
        }}>Write this page</CardButton>
      )}
    </span>
  );
  return (
    <>
      <CardShell
        id={a.id}
        title={copy.title}
        eyebrow={<CardEyebrow kind="Create" meta={[`${topics.length} pages to choose from`]} />}
        actions={actions}
        steps={["Pick a page.", "Press Write this page.", "Zavi writes it and puts it here for you to review."]}
        onClose={flow.s === "idle" ? runner.close : undefined}
        onAbout={() => setDialog("about")}
      >
        <div role="radiogroup" aria-label="Pick your next page" className="flex flex-col gap-2">
          {topics.map((t, i) => (
            <button
              key={`${i}-${t.title}`}
              type="button"
              role="radio"
              aria-checked={pick === i}
              aria-label={t.title}
              onClick={() => setPick(i)}
              className={cn("flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors duration-ca-press ease-ca-standard focus-visible:shadow-ca-focus focus-visible:outline-none", pick === i ? "border-ca-primary bg-ca-subtle" : "border-ca-strong bg-ca-bg hover:bg-ca-hover")}
            >
              <span className={cn("mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border-2", pick === i ? "border-ca-primary" : "border-ca-strong")}>
                {pick === i && <span className="size-2 rounded-full bg-ca-primary" />}
              </span>
              <span className="min-w-0">
                <span className="text-ca-row font-semibold text-ca-xdark">{t.title}</span>
                {i === 0 && <span className="ml-2 rounded-full bg-ca-success-bg px-2 text-ca-eyebrow font-medium text-ca-success">Best bet</span>}
                {t.why && <span className="mt-0.5 block text-ca-action text-ca-secondary">{clipText(t.why, POINT_MAX)}</span>}
              </span>
            </button>
          ))}
        </div>
        <TopicPickCost />
        <Panels a={a} handlers={runner.panelHandlers} busy={busy} panel={panel} setPanel={setPanel} />
        {working && <StatusLine tone="muted">Zavi is writing this page. It replaces this card in a few minutes.</StatusLine>}
      </CardShell>
      <InfoDialog open={dialog === "about"} title={topic?.title ?? copy.fullTitle} about={topic ? research(topic) : copy.about} onClose={() => setDialog(null)} />
      <TextDialog open={dialog === "ask"} heading="Ask Zavi" subtitle={copy.title} initial="" placeholder="Your question" submit="Send" onSubmit={(q) => handlers.onOpenChat?.(a, q)} onClose={() => setDialog(null)} />
    </>
  );
}
