"use client";

import { useMemo } from "react";
import { MessageSquareText, Percent, Sparkles, SquareArrowOutUpRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { DeltaTile as Tile } from "../metrics/DeltaTile";
import { ANSWER_WORD, geoHeadline, geoVisibilityModel, sharePercent } from "./visibilityModel";

const TH = "border-b border-ca-border px-3 py-3 text-ca-action font-semibold text-ca-xdark";
const TD = "border-b border-ca-border px-3 py-3 text-ca-action";
const title = "text-base font-semibold leading-6 text-ca-xdark";
const frame = "mt-3 overflow-x-auto rounded-2xl border border-ca-border bg-ca-bg shadow-ca-sm";

export function GeoVisibility({ payload }: { payload: unknown }) {
  const model = useMemo(() => geoVisibilityModel(payload), [payload]);
  if (!model) return null;
  const m = model.measured;
  const headline = geoHeadline(model);
  return (
    <div data-testid="geo-visibility" className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        {headline && <p data-testid="geo-headline" className="rounded-2xl bg-ca-subtle px-4 py-3 text-ca-action font-medium text-ca-xdark">{headline}</p>}
        <ul className="grid grid-cols-1 gap-4 [@container(min-width:32rem)]:grid-cols-2 [@container(min-width:56rem)]:grid-cols-4">
          <Tile icon={MessageSquareText} label="Mentions" value={m ? `${m.promptsMentioned} of ${m.promptsAsked} prompts` : "–"} delta={m?.deltas.mentions.delta ?? null} since={m ? `mention rate ${m.deltas.mentions.since}` : ""} note={m?.deltas.mentions.note} unit=" pts" signed />
          <Tile icon={SquareArrowOutUpRight} label="Citations" value={m ? m.citations.toLocaleString("en-US") : "–"} delta={m?.deltas.citations.delta ?? null} since={m ? `citation rate ${m.deltas.citations.since}` : ""} note={m?.deltas.citations.note} unit=" pts" signed />
          <Tile icon={Percent} label="Share of voice" value={m && m.share !== null ? sharePercent(m.share) : "–"} delta={m?.deltas.share.delta ?? null} since={m?.deltas.share.since ?? ""} note={m?.deltas.share.note} unit=" pts" signed />
          <Tile icon={Sparkles} label="Prompts tracked" value={model.promptsTracked.toLocaleString("en-US")} delta={null} since="" />
        </ul>
      </div>
      {m && m.prompts.length > 0 && (
        <section aria-labelledby="geo-prompts-grid">
          <h2 id="geo-prompts-grid" className={title}>Prompts</h2>
          <div className={frame}>
            <table className="w-full border-collapse">
              <thead className="bg-ca-subtle">
                <tr>
                  <th scope="col" className={cn(TH, "text-left")}>Prompt</th>
                  {m.engines.map((e) => <th key={e.id} scope="col" className={cn(TH, "text-right")}>{e.label}</th>)}
                </tr>
              </thead>
              <tbody className="[&>tr:last-child>*]:border-b-0">
                {m.prompts.map((p) => (
                  <tr key={p.id} data-testid="geo-prompt-row">
                    <th scope="row" className={cn(TD, "min-w-[14rem] text-left font-medium text-ca-xdark")}>{p.text}</th>
                    {p.cells.map((state, i) => <td key={m.engines[i].id} className={cn(TD, "whitespace-nowrap text-right text-ca-secondary")}>{ANSWER_WORD[state]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {m && (m.voices.length > 0 || m.voiceNote) && (
        <section aria-labelledby="geo-share-of-voice">
          <h2 id="geo-share-of-voice" className={title}>Share of voice</h2>
          {m.voices.length === 0 ? (
            <p className="mt-3 rounded-2xl border border-ca-border bg-ca-bg p-5 text-ca-action text-ca-secondary">{m.voiceNote}</p>
          ) : (
            <div className={frame}>
              <table className="w-full border-collapse">
                <thead className="bg-ca-subtle">
                  <tr>
                    <th scope="col" className={cn(TH, "text-left")}>Brand</th>
                    <th scope="col" className={cn(TH, "text-right")}>Share of mentions</th>
                  </tr>
                </thead>
                <tbody className="[&>tr:last-child>*]:border-b-0">
                  {m.voices.map((voice) => (
                    <tr key={voice.name} data-testid="geo-voice-row">
                      <th scope="row" className={cn(TD, "text-left font-medium text-ca-xdark")}>{voice.name}</th>
                      <td className={cn(TD, "text-right tabular-nums text-ca-secondary")}>{sharePercent(voice.share)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
