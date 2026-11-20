"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { getLeaderboardRank, getStartCard, readMyCard, resultPath } from "@/lib/start-card/api";
import { START_CARD_CHECK_KEYS, START_CARD_POINTS_PER_CHECK } from "@zavi/shared";
import { ScoreBar } from "./LeaderboardBits";

type Mine = {
  publicId: string;
  domain: string;
  rank: number;
  total: number;
  score: { total: number; out_of: number };
  constraint: string | null;
};

type State = { kind: "loading" } | { kind: "none" } | { kind: "ranked"; mine: Mine };

async function loadMine(publicId: string): Promise<Mine | null> {
  const [rank, card] = await Promise.all([getLeaderboardRank(publicId), getStartCard(publicId, { cache: "no-store" })]);
  if (!rank.listed || !card?.score) return null;
  const diagnosis = card.parts.diagnosis?.state === "done" ? card.parts.diagnosis.evidence : null;
  return {
    publicId,
    domain: card.domain,
    rank: rank.rank,
    total: rank.total,
    score: { total: card.score.total, out_of: START_CARD_CHECK_KEYS.length * START_CARD_POINTS_PER_CHECK },
    constraint: diagnosis?.constraint.title ?? null,
  };
}

export function YourRank() {
  const [state, setState] = useState<State>({ kind: "none" });

  useEffect(() => {
    const id = readMyCard();
    if (!id) return;
    setState({ kind: "loading" });
    let live = true;
    loadMine(id)
      .then((mine) => live && setState(mine ? { kind: "ranked", mine } : { kind: "none" }))
      .catch(() => live && setState({ kind: "none" }));
    return () => {
      live = false;
    };
  }, []);

  if (state.kind === "none") return null;
  return (
    <div
      data-testid="your-rank"
      className="mx-auto mt-10 flex min-h-[56px] max-w-[860px] flex-wrap items-center gap-x-5 gap-y-2 rounded-block border border-black/[0.08] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(16,18,20,0.04)] [animation:lbRise_500ms_ease-out_both]"
    >
      {state.kind === "loading" ? (
        <span className="inline-flex items-center gap-2 text-[14px] text-[#595959]">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Checking your rank…
        </span>
      ) : (
        <>
          <span className="rounded-full bg-[#e6f2ff] px-2.5 py-1 text-[13px] font-bold text-[#027bff] tabular-nums">
            You · #{state.mine.rank.toLocaleString("en-US")} of {state.mine.total.toLocaleString("en-US")}
          </span>
          <span className="min-w-0 break-all font-semibold">{state.mine.domain}</span>
          <ScoreBar total={state.mine.score.total} outOf={state.mine.score.out_of} delay={150} />
          {state.mine.constraint && (
            <span className="min-w-0 flex-1 text-[14px] text-[#595959]">#1 problem: {state.mine.constraint}</span>
          )}
          <Link href={resultPath(state.mine.publicId)} className="group ml-auto inline-flex min-h-11 items-center gap-1 text-[14px] font-semibold">
            Open my card
            <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
          </Link>
        </>
      )}
    </div>
  );
}

export function RemoveMySite() {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => setId(readMyCard()), []);
  if (id === undefined) return null;
  return (
    <span data-testid="remove-my-site">
      <b className="text-[#0e0f11]">Remove my site:</b> open your site&apos;s result page and use Report / remove (verified by
      an email to your domain).{" "}
      {id ? (
        <Link href={resultPath(id)} className="font-semibold text-[#0e0f11] underline underline-offset-4">
          Open my result
        </Link>
      ) : (
        "Your result link is the one you got when you scanned your site."
      )}
    </span>
  );
}
