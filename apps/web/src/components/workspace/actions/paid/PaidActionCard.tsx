"use client";

import { useState } from "react";
import { ActionCardFrame } from "../card/ActionCardFrame";
import { blockingChip } from "../card/cardKind";
import { effortMeta } from "../card/cardModel";
import { primaryOf, type FamilyWords } from "../card/cardPrimary";
import { channelName } from "../card/family";
import type { ActionBodyProps, ActionItem } from "../types";
import { AdPublishingBlocker } from "../ads/AdPublishingBlocker";
import { PaidAdEdit, ReviewNotes, usePaidAdReview } from "./PaidAdEdit";
import { PaidBody } from "./PaidBody";
import { executedWords, paidKind, paidMeta, paidSecondary, simpleCard } from "./paidSpec";

export function paidWords(
  a: ActionItem,
  manageUrl?: string | null,
  execPartial?: { href: string; label: string } | null,
): FamilyWords {
  const network = channelName(a.channel_slug);
  return { network, manageUrl, execPartial, executed: (x) => executedWords(x, network) };
}

export function PaidActionCard(props: ActionBodyProps) {
  const a = props.action;
  const [editing, setEditing] = useState(false);
  const words = paidWords(a, props.platform?.manageUrl ?? null, props.platform?.execPartial ?? null);
  const primary = primaryOf(a, props.handlers, words);
  const effort = effortMeta(a);
  const saved = usePaidAdReview(a);
  const editable = saved.editable && !!props.handlers.onReviseAd;
  return (
    <ActionCardFrame
      props={props}
      words={words}
      spec={{
        kind: paidKind(a),
        meta: [...paidMeta(a), ...(effort ? [effort] : [])],
        chip: blockingChip(a),
        secondary: editable ? ["edit", ...paidSecondary(a, primary)] : paidSecondary(a, primary),
        inlineStatus: true,
        simple: simpleCard(a),
        onEdit: editable ? { label: saved.editLabel, open: () => setEditing(true) } : null,
        body: (copy, edited) => (
          <div ref={saved.ref} className="flex min-w-0 flex-col gap-3">
            <PaidBody a={saved.shown} copy={copy} edited={edited} />
            <ReviewNotes saved={saved} />
            {editing && editable && saved.review && <PaidAdEdit props={props} review={saved.review} onClose={() => setEditing(false)} />}
            <AdPublishingBlocker action={a} platform={props.platform} connectionBlocker={saved.review?.connection_blocker} />
          </div>
        ),
      }}
    />
  );
}
