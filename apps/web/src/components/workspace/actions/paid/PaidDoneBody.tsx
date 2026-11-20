"use client";

import type { CardCopy } from "../card/cardModel";
import type { ActionItem } from "../types";
import { PaidBody } from "./PaidBody";
import { ReviewNotes, usePaidAdReview } from "./PaidAdEdit";

export function PaidDoneBody({ a, copy }: { a: ActionItem; copy: CardCopy }) {
  const saved = usePaidAdReview(a);
  return (
    <div ref={saved.ref} className="flex min-w-0 flex-col gap-3">
      <PaidBody a={saved.shown} copy={copy} edited={null} disclose />
      <ReviewNotes saved={saved} />
    </div>
  );
}
