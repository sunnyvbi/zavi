"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Archive, ChevronDown, ExternalLink, Pencil, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ToneBadge } from "./ui";
import {
  CATEGORY_LABEL,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  SOURCE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  formatDay,
  providerLabel,
  suggestionProviders,
  type GrowthSuggestion,
} from "./types";

function Provenance({ suggestion }: { suggestion: GrowthSuggestion }) {
  const [open, setOpen] = useState(false);
  const providers = suggestionProviders(suggestion);
  const evidence = suggestion.source_payload.evidence ?? [];
  if (providers.length === 0 && evidence.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>{SOURCE_LABEL[suggestion.source]}</span>
        {providers.length > 0 && <span aria-hidden>·</span>}
        {providers.map((source) => (
          <Badge key={source} variant="outline" className="font-normal">
            {providerLabel(source)}
          </Badge>
        ))}
        {evidence.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
            aria-expanded={open}
          >
            {evidence.length} evidence
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        )}
      </div>
      {open && (
        <ul className="space-y-1 rounded-md bg-muted/60 px-3 py-2 text-xs">
          {evidence.map((ref, index) => (
            <li key={`${ref.source}-${index}`} className="flex gap-2">
              <span className="shrink-0 font-medium">{providerLabel(ref.source)}</span>
              <span className="min-w-0 text-muted-foreground">
                {ref.label}: {ref.value}
                {ref.observed_at ? ` · ${formatDay(ref.observed_at)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SuggestionCard({
  suggestions,
  busyIds,
  onEdit,
  onArchive,
  onPush,
  onPushAll,
}: {
  suggestions: GrowthSuggestion[];
  busyIds: Set<string>;
  onEdit: (suggestion: GrowthSuggestion) => void;
  onArchive: (suggestion: GrowthSuggestion) => void;
  onPush: (suggestion: GrowthSuggestion) => void;
  onPushAll: (suggestions: GrowthSuggestion[]) => void;
}) {
  const drafts = suggestions.filter((suggestion) => suggestion.status === "draft");
  const pushed = suggestions.length - drafts.length;
  const pushingAll = drafts.some((suggestion) => busyIds.has(suggestion.id));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0 border-b px-4 py-3">
        <CardTitle className="text-sm">
          {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {drafts.length} draft{drafts.length === 1 ? "" : "s"}
          {pushed > 0 ? ` · ${pushed} sent` : ""}
        </p>
      </CardHeader>

      <CardContent className="divide-y p-0">
        {suggestions.map((suggestion, index) => {
          const busy = busyIds.has(suggestion.id);
          const isDraft = suggestion.status === "draft";
          return (
            <div key={suggestion.id} className="flex items-start gap-3 px-4 py-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-xs font-medium">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-bold">{suggestion.title}</h3>
                  {isDraft && (
                    <div className="flex shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={`Edit ${suggestion.title}`}
                        disabled={busy}
                        onClick={() => onEdit(suggestion)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 hover:text-destructive"
                        aria-label={`Archive ${suggestion.title}`}
                        disabled={busy}
                        onClick={() => onArchive(suggestion)}
                      >
                        <Archive className="size-4" />
                      </Button>
                    </div>
                  )}
                </div>

                <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{suggestion.body}</p>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">{CATEGORY_LABEL[suggestion.category]}</Badge>
                  <ToneBadge tone={PRIORITY_TONE[suggestion.priority]}>
                    {PRIORITY_LABEL[suggestion.priority]}
                  </ToneBadge>
                  <ToneBadge tone={STATUS_TONE[suggestion.status]} dot>
                    {STATUS_LABEL[suggestion.status]}
                  </ToneBadge>
                  {suggestion.decision_id && (
                    <Link
                      href={`/decisions/${suggestion.decision_id}`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:underline"
                    >
                      Decision <ExternalLink className="size-3.5" />
                    </Link>
                  )}
                  {isDraft && (
                    <Button size="sm" className="ml-auto h-7" disabled={busy} onClick={() => onPush(suggestion)}>
                      <Send className="size-3.5" />
                      {busy ? "Pushing…" : "Push"}
                    </Button>
                  )}
                </div>

                <Provenance suggestion={suggestion} />

                {suggestion.duplicate && (
                  <p className="flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
                    <AlertTriangle className="size-4 shrink-0" />
                    May duplicate “{suggestion.duplicate.title}” ({STATUS_LABEL[suggestion.duplicate.status as GrowthSuggestion["status"]] ?? suggestion.duplicate.status})
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>

      {drafts.length > 1 && (
        <CardFooter className="justify-end border-t px-4 py-3">
          <Button size="sm" disabled={pushingAll} onClick={() => onPushAll(drafts)}>
            <Send className="size-3.5" />
            {pushingAll ? "Pushing…" : `Push all ${drafts.length} drafts to client`}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
