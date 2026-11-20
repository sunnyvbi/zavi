"use client";

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CompetitorCard } from "./CompetitorCard";
import { AddCompetitorDialog } from "./AddCompetitorDialog";
import type { CompetitorProfileInput } from "@zavi/shared";
import type { CompetitorRow, CompetitorsSection, Section } from "./types";
import { Empty, Notice, TabHeader } from "../ui";
import { fmtDate, fmtPct } from "./format";

const LABEL_CELL =
  "sticky left-0 z-10 w-48 min-w-[12rem] px-5 py-5 text-left align-top text-xs font-medium uppercase tracking-wide text-muted-foreground";
const VALUE_CELL = "min-w-[240px] px-5 py-5 align-top text-sm leading-6 text-foreground";

function editableProfile(competitor: CompetitorRow): CompetitorProfileInput {
  const threat = competitor.threat_level?.trim().toLowerCase();
  return {
    website: competitor.website ?? "",
    company_name: competitor.name,
    industry: competitor.category ?? "",
    positioning: competitor.positioning ?? "",
    target_audience: competitor.audience ?? "",
    pricing: competitor.pricing ?? "",
    acquisition_channels: competitor.channels,
    threat_level: threat === "low" || threat === "high" ? threat : "medium",
  };
}

function ComparisonTable({ competitors, subject }: { competitors: CompetitorRow[]; subject: string }) {
  const rows: Array<[string, (row: CompetitorRow) => string | null]> = [
    ["Positioning", (row) => row.positioning],
    [
      `Overlap with ${subject}`,
      (row) => (typeof row.audience_overlap === "number" ? fmtPct(row.audience_overlap, 0) : null),
    ],
    ["Audience", (row) => row.audience],
    ["Pricing", (row) => row.pricing],
    ["Est. traffic", (row) => row.est_traffic ?? null],
    ["Primary channels", (row) => row.channels.join(", ") || null],
    ["Strengths", (row) => row.strengths.join("; ") || null],
    ["Weaknesses", (row) => row.weaknesses.join("; ") || null],
    ["Threat", (row) => row.threat_level],
  ];

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted hover:bg-muted">
            <TableHead className={`${LABEL_CELL} h-auto bg-muted py-4`}>Attribute</TableHead>
            {competitors.map((competitor) => (
              <TableHead
                key={competitor.name}
                className="h-auto min-w-[240px] px-5 py-4 align-top text-xs font-semibold uppercase tracking-wide"
              >
                {competitor.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([label, read], index) => {
            const stripe = index % 2 === 1 ? "bg-muted hover:bg-muted" : "bg-card hover:bg-card";
            return (
              <TableRow key={label} className={stripe}>
                <TableHead scope="row" className={`${LABEL_CELL} h-auto ${stripe}`}>
                  {label}
                </TableHead>
                {competitors.map((competitor) => (
                  <TableCell key={competitor.name} className={VALUE_CELL}>
                    {read(competitor) ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function CompetitorTab({
  section,
  tenantId,
  subject = "this client",
  onPrefill,
  onAdded,
}: {
  section: Section<CompetitorsSection>;
  tenantId: string;
  subject?: string;
  onPrefill: (text: string) => void;
  onAdded: () => void;
}) {
  const [view, setView] = useState<"profiles" | "comparison">("profiles");
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<CompetitorRow | null>(null);
  const { competitors, week_bucket } = section.data;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return competitors;
    return competitors.filter((competitor) =>
      [
        competitor.name,
        competitor.category,
        competitor.positioning,
        competitor.audience,
        competitor.pricing,
        ...competitor.channels,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [competitors, query]);

  const header = (
    <TabHeader
      title="Competitors"
      meta={week_bucket && `Weekly scan · week of ${fmtDate(week_bucket)}`}
      action={
        <Button
          variant="ghost"
          className="text-primary"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="size-4" />
          Add competitor
        </Button>
      }
    />
  );

  if (competitors.length === 0) {
    return (
      <div>
        {header}
        <Empty title="No competitor scan for this client" detail={section.detail} />
        <AddCompetitorDialog
          tenantId={tenantId}
          open={addOpen}
          onOpenChange={setAddOpen}
          onAdded={onAdded}
        />
      </div>
    );
  }

  return (
    <div>
      {header}
      <Notice status={section.status} detail={section.detail} />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <Tabs value={view} onValueChange={(next) => setView(next as typeof view)}>
          <TabsList>
            <TabsTrigger value="profiles">Profiles</TabsTrigger>
            <TabsTrigger value="comparison">Comparison</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search competitors"
            aria-label="Search competitors"
            className="pl-9"
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <Empty title="No competitor matches that search" detail={`Nothing in this scan matches “${query}”.`} />
      ) : view === "comparison" ? (
        <ComparisonTable competitors={visible} subject={subject} />
      ) : (
        <div className="flex flex-col gap-5">
          {visible.map((competitor) => (
            <CompetitorCard
              key={competitor.name}
              competitor={competitor}
              subject={subject}
              onEdit={
                !competitor.website || competitor.source !== "human_reviewed_profile"
                  ? () => setEditing(competitor)
                  : undefined
              }
              onDrop={() =>
                onPrefill(
                  `Should we drop ${competitor.name} from the competitor watchlist for ${subject}? Say what the latest scan actually found about them before we decide.`,
                )
              }
            />
          ))}
        </div>
      )}
      <AddCompetitorDialog
        tenantId={tenantId}
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={onAdded}
      />
      {editing && (
        <AddCompetitorDialog
          tenantId={tenantId}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onAdded={onAdded}
          initialProfile={editableProfile(editing)}
          mode="edit"
        />
      )}
    </div>
  );
}
