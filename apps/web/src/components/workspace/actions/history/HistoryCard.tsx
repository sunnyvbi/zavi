"use client";

import { useEffect, useState } from "react";
import { readHistoryCard } from "@/lib/workspace/channelActionsApi";
import { cardCopyOf } from "../card/cardModel";
import { channelFamily } from "../card/family";
import { OrganicBody } from "../organic/OrganicBody";
import { PaidBody } from "../paid/PaidBody";
import type { ActionItem } from "../types";

export function HistoryCard({ id }: { id: string }) {
  const [state, setState] = useState<{ card: ActionItem | null; loading: boolean }>({ card: null, loading: true });
  useEffect(() => {
    let live = true;
    readHistoryCard(id)
      .then((card) => { if (live) setState({ card, loading: false }); })
      .catch(() => { if (live) setState({ card: null, loading: false }); });
    return () => { live = false; };
  }, [id]);
  if (state.loading) return <div role="status" aria-label="Loading the card" className="h-28 animate-pulse rounded-2xl bg-creamDeep motion-reduce:animate-none" />;
  const a = state.card;
  if (!a) return null;
  const copy = cardCopyOf(a);
  return <section aria-label="What Zavi did" data-testid="history-card" className="flex min-w-0 flex-col gap-3 rounded-2xl border border-ca-border bg-ca-bg p-4">
    {channelFamily(a.channel_slug) === "paid" ? <PaidBody a={a} copy={copy} edited={null} disclose /> : <OrganicBody a={a} copy={copy} edited={null} />}
  </section>;
}
