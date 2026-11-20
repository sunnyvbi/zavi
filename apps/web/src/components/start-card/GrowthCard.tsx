"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Flag, Loader2, Share2, Swords, Trophy } from "lucide-react";
import type { StartCard, StartCardGoogleEvidence } from "@zavi/shared";
import {
  challengePath,
  checkRows,
  countryPhrase,
  finalReady,
  getLeaderboardRank,
  profileOf,
  resultPath,
  rivalRows,
} from "@/lib/start-card/api";
import { ReportRemoveForm } from "./ReportRemoveForm";

export const NOT_MEASURED = "Not measured right now";

function Pending({ children = "Checking…" }: { children?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-inkMuted">
      <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> {children}
    </span>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-inkMuted">{children}</p>;
}

export function LeaderboardRankLine({ publicId }: { publicId: string }) {
  const [rank, setRank] = useState<{ rank: number; total: number } | null>(null);
  useEffect(() => {
    let live = true;
    getLeaderboardRank(publicId)
      .then((r) => {
        if (live && r.listed) setRank({ rank: r.rank, total: r.total });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [publicId]);
  if (!rank) return null;
  return (
    <p data-testid="leaderboard-rank" className="mt-4 flex items-center gap-2 text-[14px]">
      <Trophy aria-hidden className="h-4 w-4 text-[#027bff]" />
      <b className="tabular-nums">
        #{rank.rank.toLocaleString("en-US")} of {rank.total.toLocaleString("en-US")}
      </b>
      <span className="text-inkMuted">·</span>
      <Link href="/growth" className="font-medium text-[#027bff] underline-offset-2 hover:underline">
        See the leaderboard
      </Link>
    </p>
  );
}

export type GrowthCardProps = {
  card: StartCard | null;
  domain: string;
  readOnly?: boolean;
  openReport?: boolean;
};

export function GrowthCard({ card, domain, readOnly = false, openReport = false }: GrowthCardProps) {
  const [copied, setCopied] = useState<"share" | "challenge" | null>(null);
  const [copyFailed, setCopyFailed] = useState<"share" | "challenge" | false>(false);
  const [reportOpen, setReportOpen] = useState(openReport);

  const failed = card?.status === "failed";
  const rows = checkRows(card).map((r) =>
    failed && r.state === "pending" ? { ...r, state: "unavailable" as const } : r,
  );
  const profile = profileOf(card);
  const rivals = rivalRows(card);
  const ready = finalReady(card);
  const score = ready ? card!.score! : null;
  const diagnosis = ready && card!.parts.diagnosis?.state === "done" ? card!.parts.diagnosis.evidence : null;
  const allDone = ready && card?.status === "done";
  const shareUnlocked = allDone;
  const googleEv =
    card?.parts?.google?.state === "done" ? (card.parts.google.evidence as StartCardGoogleEvidence | null) : null;
  const term = googleEv?.search_term || (failed ? profile?.search_term || card?.search_term : null) || null;
  const broadTerm =
    googleEv?.term_source === "ranked" && googleEv.broad_term && googleEv.broad_position !== undefined
      ? googleEv.broad_term
      : null;
  const country = countryPhrase(profile);
  const publicId = card?.public_id ?? null;
  const pct = score && score.out_of > 0 ? Math.round((score.total / score.out_of) * 100) : 0;
  const unmeasured = score ? rows.filter((r) => r.state === "unavailable").length : 0;

  async function copy(kind: "share" | "challenge") {
    if (!publicId) return;
    const origin = window.location.origin;
    const url = origin + (kind === "share" ? resultPath(publicId) : challengePath(publicId));
    setCopyFailed(false);
    if (kind === "share" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: `${domain} growth score`,
          text: score ? `${domain} scored ${score.total}/${score.out_of} on Zavi's growth check.` : undefined,
          url,
        });
        return;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(kind);
    } catch {
      setCopyFailed(kind);
    }
  }

  return (
    <div
      data-testid="growth-card"
      className="w-full rounded-2xl border border-black/10 bg-white p-4 text-left text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:p-7"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-inkMuted">
        <span>
          Growth check · <b className="font-semibold text-ink">{domain}</b>
        </span>
      </div>

      {}
      <div className="mt-5 flex items-center gap-5">
        <div
          className="grid h-24 w-24 shrink-0 place-items-center rounded-full"
          style={{ background: `conic-gradient(#027bff ${pct}%, #eceef1 0)` }}
          role="img"
          aria-label={score ? `Growth score ${score.total} out of ${score.out_of}` : "Growth score being calculated"}
        >
          <span className="grid h-[76px] w-[76px] place-items-center rounded-full bg-white text-[28px] font-bold tabular-nums">
            {score ? (
              score.total
            ) : failed ? (
              "–"
            ) : (
              <Loader2 aria-hidden className="h-6 w-6 animate-spin text-inkMuted motion-reduce:animate-none" />
            )}
          </span>
        </div>
        <div className="min-w-0">
          <h2 className="text-[20px] font-bold tracking-tight">
            {score
              ? `Your growth score: ${score.total}/${score.out_of}`
              : failed
                ? "We couldn't finish this check"
                : "Scoring your site…"}
          </h2>
          <p className="mt-1 text-[13px] text-inkMuted">
            {score && unmeasured > 0
              ? `Out of ${score.out_of}: ${unmeasured} of 5 checks could not be measured right now. `
              : ""}
            {country ? `Checked from ${country}` : failed ? "Try again later." : "Reading your site…"}
            {country && !readOnly ? " · this link always shows this score" : ""}
          </p>
        </div>
      </div>

      {allDone && publicId && <LeaderboardRankLine publicId={publicId} />}

      {}
      <ul className="mt-5 flex flex-col gap-2.5">
        {rows.map((c) => (
          <li
            key={c.key}
            data-testid={`check-${c.key}`}
            className="grid grid-cols-[1fr_52px] items-center gap-x-3 gap-y-1 text-[14px] sm:grid-cols-[150px_1fr_52px] sm:gap-3"
          >
            <span className="font-medium">{c.label}</span>
            <span className="order-3 col-span-2 sm:order-none sm:col-span-1">
              {c.state === "done" ? (
                <span className="block">
                  <span className="block h-2 overflow-hidden rounded-full bg-[#eceef1]">
                    <span
                      className="block h-full rounded-full bg-[#027bff]"
                      style={{ width: `${Math.max(3, c.max > 0 ? ((c.points ?? 0) / c.max) * 100 : 0)}%` }}
                    />
                  </span>
                  {c.note && <span className="mt-1 block text-[13px] text-inkMuted">{c.note}</span>}
                </span>
              ) : c.state === "unavailable" ? (
                <span className="text-[13px] text-inkMuted">{NOT_MEASURED}</span>
              ) : (
                <Pending />
              )}
            </span>
            <span className="text-right font-semibold tabular-nums">
              {c.state === "done" && c.points != null ? `${c.points}/${c.max}` : "–/20"}
            </span>
          </li>
        ))}
      </ul>

      {}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl bg-[#f6f7f9] p-4">
          <Eyebrow>#1 thing holding you back</Eyebrow>
          {diagnosis ? (
            <>
              <p className="mt-1.5 text-[14px] font-semibold">{diagnosis.constraint.title}</p>
              <p className="mt-1 text-[14px] text-inkMuted">{diagnosis.constraint.why}</p>
            </>
          ) : ready || failed ? (
            <p className="mt-1.5 text-[14px] text-inkMuted">{NOT_MEASURED}</p>
          ) : (
            <div className="mt-2">
              <Pending>Written from your checks when they finish…</Pending>
            </div>
          )}
          {}
          <div className="mt-3 border-t border-black/[0.08] pt-3">
            <Eyebrow>This is what I will do first</Eyebrow>
            {diagnosis ? (
              <>
                <p className="mt-1.5 text-[14px] font-semibold">{diagnosis.action_this_week.title}</p>
                <p className="mt-1 text-[14px] text-inkMuted">{diagnosis.action_this_week.why}</p>
              </>
            ) : ready || failed ? (
              <p className="mt-1.5 text-[14px] text-inkMuted">{NOT_MEASURED}</p>
            ) : (
              <div className="mt-2">
                <Pending />
              </div>
            )}
          </div>
        </div>
        <div className="rounded-xl bg-[#f6f7f9] p-4">
          <Eyebrow>Your competitors</Eyebrow>
          {profile ? (
            rivals.rows.length ? (
              <>
                <ul className="mt-1.5 flex flex-col gap-1 text-[14px]">
                  {rivals.rows.map((r) => (
                    <li key={r.name} className="flex justify-between gap-2">
                      <span className="min-w-0">
                        {r.name}
                        {r.source && (
                          <span className="text-[12px] text-inkMuted">
                            {" "}
                            · source:{" "}
                            {r.sourceUrl ? (
                              <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                                {r.source}
                              </a>
                            ) : (
                              r.source
                            )}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 font-semibold tabular-nums">
                        {r.score ?? <Loader2 aria-label="Scoring" className="inline h-3.5 w-3.5 animate-spin text-inkMuted" />}
                      </span>
                    </li>
                  ))}
                </ul>
                {rivals.you && (
                  <p className="mt-1.5 text-[12px] text-inkMuted">
                    You: {rivals.you}
                    {rivals.usedLabel ? ` on ${rivals.usedLabel}` : ""}.
                  </p>
                )}
              </>
            ) : (
              <p className="mt-1.5 text-[14px] text-inkMuted">We couldn&apos;t find competitors with a source.</p>
            )
          ) : card?.parts?.profile?.state === "unavailable" || failed ? (
            <p className="mt-1.5 text-[14px] text-inkMuted">{NOT_MEASURED}</p>
          ) : (
            <div className="mt-2">
              <Pending>Finding competitors…</Pending>
            </div>
          )}
        </div>
      </div>

      {}
      <p className="mt-4 text-[13px] text-inkMuted">
        We checked:{" "}
        {card?.parts?.google?.state !== "unavailable" && (
          <>
            {term ? (
              broadTerm ? `“${term}” and “${broadTerm}”` : `“${term}”`
            ) : (
              <Loader2 aria-label="Picking your search" className="inline h-3 w-3 animate-spin motion-reduce:animate-none" />
            )}{" "}
            on Google ·{" "}
          </>
        )}
        {card?.parts?.ai?.state !== "unavailable" && "ChatGPT, Gemini, Perplexity, Claude · "}
        Google PageSpeed (your site) · a phone-screen check
      </p>

      {}
      {!readOnly && (
        <div className="mt-5 flex flex-col gap-3 border-t border-black/[0.06] pt-5">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!shareUnlocked}
              onClick={() => void copy("share")}
              className="inline-flex min-h-12 items-center gap-2 rounded-cta border border-black/10 bg-white px-4 text-[14px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Share2 aria-hidden className="h-4 w-4" /> Share my score
            </button>
            <button
              type="button"
              disabled={!shareUnlocked}
              onClick={() => void copy("challenge")}
              className="inline-flex min-h-12 items-center gap-2 rounded-cta border border-black/10 bg-white px-4 text-[14px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Swords aria-hidden className="h-4 w-4" /> Challenge 3 founders
            </button>
          </div>
          <p className="text-[13px] text-inkMuted" aria-live="polite">
            {failed ? (
              "This check couldn't finish, so there is nothing to share yet."
            ) : !allDone ? (
              "Sharing unlocks when all 5 checks are done."
            ) : copyFailed && publicId ? (
              <>
                Couldn&apos;t copy. Your link:{" "}
                <span className="select-all font-medium text-ink">
                  {window.location.origin}
                  {copyFailed === "challenge" ? challengePath(publicId) : resultPath(publicId)}
                </span>
              </>
            ) : copied === "challenge" ? (
              <>
                <Check aria-hidden className="inline h-3.5 w-3.5" /> Challenge link copied. Send it to 3 founders.
              </>
            ) : copied === "share" ? (
              <>
                <Check aria-hidden className="inline h-3.5 w-3.5" /> Link copied.
              </>
            ) : (
              <>
                <Check aria-hidden className="inline h-3.5 w-3.5" /> Sharing unlocked. Your link:{" "}
                {publicId ? `zaviagent.com${resultPath(publicId)}` : ""}
              </>
            )}{" "}
            ·{" "}
            <button
              type="button"
              className="underline"
              aria-expanded={reportOpen}
              onClick={() => setReportOpen((v) => !v)}
              disabled={!publicId}
            >
              <Flag aria-hidden className="inline h-3 w-3" /> Report / remove
            </button>
          </p>
        </div>
      )}
      {readOnly && publicId && (
        <p className="mt-5 border-t border-black/[0.06] pt-4 text-[13px] text-inkMuted">
          <button type="button" className="underline" aria-expanded={reportOpen} onClick={() => setReportOpen((v) => !v)}>
            <Flag aria-hidden className="inline h-3 w-3" /> Report / remove
          </button>
        </p>
      )}
      {reportOpen && publicId && <ReportRemoveForm publicId={publicId} domain={domain} />}
    </div>
  );
}
