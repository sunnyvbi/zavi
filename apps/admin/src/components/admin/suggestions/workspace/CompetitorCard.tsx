"use client";

import { Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import type { CompetitorRow } from "./types";
import { SiteLink, SocialTiles, ToneBadge, type Tone } from "../ui";
import { fmtPct } from "./format";

const THREAT_TONE: Record<string, Tone> = { high: "bad", medium: "warn", low: "good" };

const SPECS: Array<[string, (row: CompetitorRow) => string | null | undefined]> = [
  ["Audience", (row) => row.audience],
  ["Pricing", (row) => row.pricing],
  ["Est. traffic", (row) => row.est_traffic],
  ["Social", (row) => row.social_summary],
];

function PointList({ title, points, sign, className }: {
  title: string;
  points: string[];
  sign: string;
  className: string;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-3">
      <p className={`text-sm font-semibold ${className}`}>{title}</p>
      {points.length === 0 ? (
        <p className="text-xs text-muted-foreground">The scan recorded none for this competitor.</p>
      ) : (
        <ul className="space-y-2">
          {points.map((point) => (
            <li key={point} className="flex items-start gap-2 text-xs leading-5">
              <span className={`shrink-0 ${className}`}>{sign}</span>
              <span className="min-w-0 flex-1">{point}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CompetitorCard({
  competitor,
  subject,
  onEdit,
  onDrop,
}: {
  competitor: CompetitorRow;
  subject: string;
  onEdit?: () => void;
  onDrop: () => void;
}) {
  const threat = competitor.threat_level?.trim().toLowerCase();
  const overlap = competitor.audience_overlap;
  const hasOverlap = typeof overlap === "number" && Number.isFinite(overlap);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <p className="font-semibold text-foreground">{competitor.name}</p>
              {competitor.website && (
                <SiteLink href={competitor.website} className="text-xs text-muted-foreground" />
              )}
            </div>
            <p className="mt-1 text-xs font-medium uppercase text-muted-foreground">
              {competitor.category ?? competitor.source.replace(/_/g, " ")}
            </p>
          </div>
          {competitor.threat_level && (
            <ToneBadge tone={(threat && THREAT_TONE[threat]) || "warn"} dot>
              <span className="capitalize">{competitor.threat_level}</span>
              {threat && threat in THREAT_TONE ? " threat" : ""}
            </ToneBadge>
          )}
          {onEdit && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={onEdit}
            >
              <Pencil className="size-3.5" />
              Edit
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Ask Zavi to drop ${competitor.name} from the watchlist`}
            onClick={onDrop}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>

        <Separator />

        <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
          <p className="min-w-0 flex-1 text-sm leading-5">
            {competitor.positioning ?? "The scan named this competitor without a positioning summary."}
          </p>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs font-medium uppercase">
              <span className="text-muted-foreground">Audience overlap with {subject}</span>
              {hasOverlap && <span className="font-semibold text-foreground">{fmtPct(overlap, 0)}</span>}
            </div>
            {hasOverlap ? (
              <Progress
                value={Math.max(0, Math.min(1, overlap)) * 100}
                className="h-2 [&>div]:bg-rose-500"
              />
            ) : (
              <p className="text-xs text-muted-foreground">Not measured by this scan.</p>
            )}
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:gap-8">
          <dl className="min-w-0 flex-1 space-y-4">
            {SPECS.map(([label, read]) => (
              <div key={label} className="flex items-start justify-between gap-4">
                <dt className="w-28 shrink-0 text-xs font-medium uppercase text-muted-foreground">{label}</dt>
                <dd className="min-w-0 flex-1 text-right text-xs leading-5">
                  {read(competitor) ?? <span className="text-muted-foreground">Not recorded</span>}
                </dd>
              </div>
            ))}
          </dl>

          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-xs font-medium uppercase text-muted-foreground">Primary channels</p>
            {competitor.channels.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                The scan did not record how they acquire demand.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {competitor.channels.map((channel) => (
                  <Badge key={channel} variant="secondary">
                    {channel}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-6 sm:flex-row sm:gap-4">
          <PointList title="STRENGTHS" points={competitor.strengths} sign="+" className="text-emerald-700" />
          <PointList title="WEAKNESSES" points={competitor.weaknesses} sign="–" className="text-rose-700" />
        </div>

        {(competitor.social_profiles?.length ?? 0) > 0 && (
          <>
            <Separator />
            <SocialTiles tiles={competitor.social_profiles ?? []} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
