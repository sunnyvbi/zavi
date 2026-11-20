"use client";

import { useMemo, useState } from "react";
import { KeyRound, Search, Sparkles } from "lucide-react";
import { Markdown } from "@/components/admin/Markdown";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import type { CompanySection, ProfileField, Section, SectionStatus } from "./types";
import {
  Field,
  NotRecorded,
  Provenance,
  SiteLink,
  SocialTiles,
  Stat,
  Notice,
  ToneBadge,
  type SocialTile,
  type Tone,
} from "../ui";
import { fmtRelative } from "./format";
import { FillFieldsDialog, fillableEmptyFields } from "./FillFieldsDialog";
import { ResearchCompanyDialog } from "./ResearchCompanyDialog";

const STATUS: Record<SectionStatus, { label: string; tone: Tone }> = {
  ready: { label: "Ready", tone: "good" },
  partial: { label: "Partial", tone: "warn" },
  not_configured: { label: "Not configured", tone: "flat" },
  not_connected: { label: "Not connected", tone: "flat" },
};

function socialTiles(company: CompanySection): SocialTile[] {
  return (company.social_profiles ?? []).map((row) => ({
    platform: row.platform === "twitter" ? "x" : row.platform,
    followers: row.followers,
    url: row.url,
  }));
}

function unrecorded(fields: ProfileField[]): number {
  return fields.filter((field) => field.value === null).length;
}

function GapNote({ fields }: { fields: ProfileField[] }) {
  const count = unrecorded(fields);
  if (count === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {count} of {fields.length} fields have no recorded source. Zavi will not guess them.
    </p>
  );
}

function Heading({ children, meta, className }: { children: string; meta?: string | null; className?: string }) {
  return (
    <div className={className ?? "mb-4"}>
      <h2 className="text-lg font-semibold text-foreground">{children}</h2>
      {meta && <p className="mt-1 text-xs text-muted-foreground">{meta}</p>}
    </div>
  );
}

function DetailRow({ field }: { field: ProfileField }) {
  const score = field.key === "growth_score" ? Number.parseFloat(field.value ?? "") : NaN;
  return (
    <div className="flex items-start justify-between gap-6">
      <p className="shrink-0 pt-0.5 text-xs font-semibold uppercase text-muted-foreground">{field.label}</p>
      <div className="min-w-0 text-right">
        {field.value === null ? (
          <NotRecorded />
        ) : Number.isFinite(score) ? (
          <div className="flex items-center justify-end gap-2">
            <Progress value={Math.max(0, Math.min(100, score))} className="h-1.5 w-24" />
            <span className="text-sm font-medium text-foreground">{field.value}</span>
          </div>
        ) : (
          <p className="text-sm font-medium text-foreground">{field.value}</p>
        )}
        <Provenance field={field} />
      </div>
    </div>
  );
}

function ProfileCard({ company, status }: { company: CompanySection; status: SectionStatus }) {
  const badge = STATUS[status] ?? { label: status, tone: "flat" as Tone };
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary text-xl font-bold text-primary-foreground">
              {company.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate text-xl font-bold text-foreground">{company.name}</p>
              {company.domain ? (
                <SiteLink href={company.domain} className="text-sm font-medium text-foreground" />
              ) : (
                <p className="text-sm text-muted-foreground">No website recorded</p>
              )}
            </div>
          </div>
          <ToneBadge tone={badge.tone} dot>
            {badge.label}
          </ToneBadge>
        </div>

        <Separator />

        <div className="flex flex-col gap-4">
          {company.profile.map((field) => (
            <DetailRow key={field.key} field={field} />
          ))}
        </div>

        <Separator />

        <SocialTiles tiles={socialTiles(company)} kind="found" />
      </CardContent>
    </Card>
  );
}

export function CompanyTab({
  section,
  tenantId,
  onRefresh,
}: {
  section: Section<CompanySection>;
  tenantId: string;
  onRefresh: () => void;
}) {
  const company = section.data;
  const [researchOpen, setResearchOpen] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);
  const fillable = useMemo(
    () => fillableEmptyFields([...company.icp, ...company.business_model]),
    [company.icp, company.business_model],
  );
  const products = company.facts.filter((fact) => fact.key === "what_we_sell");
  const find = (key: string) => company.icp.find((field) => field.key === key) ?? null;
  const primary = find("primary_icp");
  const buyer = find("buyer");
  const customerValue = find("average_customer_value");
  const rest = company.icp.filter(
    (field) => !["primary_icp", "buyer", "average_customer_value"].includes(field.key),
  );

  return (
    <div className="space-y-8">
      <Notice status={section.status} detail={section.detail} />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <div>
          <div className="mb-4 flex items-start justify-between gap-3">
            <Heading
              className="min-w-0"
              meta={
                section.source_updated_at ? `Last confirmed ${fmtRelative(section.source_updated_at)}` : null
              }
            >
              Company details
            </Heading>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={fillable.length === 0}
                onClick={() => setFillOpen(true)}
              >
                <Sparkles className="size-4" />
                Fill missing fields with AI
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setResearchOpen(true)}>
                <Search className="size-4" />
                Research
              </Button>
            </div>
          </div>
          <ProfileCard company={company} status={section.status} />
        </div>

        <div>
          <Heading>What the company does</Heading>
          <Card>
            <CardContent className="space-y-4 p-5">
              {company.description ? (
                <Markdown>{company.description}</Markdown>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No company brain note exists for this client, so there is nothing describing what they do.
                </p>
              )}

              <Separator />

              <p className="font-semibold text-foreground">Products &amp; services</p>
              {products.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not recorded.</p>
              ) : (
                <ul className="space-y-3">
                  {products.map((fact, index) => {
                    const [head, ...rest] = fact.value.split(/\s+—\s+/);
                    return (
                      <li key={`${fact.key}-${index}`} className="flex items-start gap-2 text-sm">
                        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <p className="min-w-0 flex-1">
                          <span className="font-semibold text-foreground">{head}</span>
                          {rest.length > 0 && (
                            <span className="text-muted-foreground"> — {rest.join(" — ")}</span>
                          )}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div>
        <Heading>Ideal customer profile</Heading>
        <Card>
          <CardContent className="space-y-5 p-5">
            <div className="space-y-3 rounded-xl bg-muted p-6">
              <p className="text-xs font-semibold uppercase text-muted-foreground">
                {primary?.label ?? "Primary ICP"} • used by every agent to judge relevance
              </p>
              {primary?.value ? (
                <p className="font-semibold text-foreground">{primary.value}</p>
              ) : (
                <NotRecorded />
              )}
              {primary && <Provenance field={primary} />}

              <Separator />

              <div className="flex flex-col gap-6 sm:flex-row sm:gap-10">
                {buyer && <Field field={buyer} className="flex-1" />}
                {customerValue && <Field field={customerValue} className="sm:w-56" />}
              </div>
            </div>

            {rest.length > 0 && (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                {rest.map((field) => (
                  <Field key={field.key} field={field} />
                ))}
              </div>
            )}

            <GapNote fields={company.icp} />
          </CardContent>
        </Card>
      </div>

      <div>
        <Heading>Business model</Heading>
        <Card className="overflow-hidden">
          <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
            {company.business_model.map((field) => (
              <Stat
                key={field.key}
                label={field.label}
                value={field.value ?? <span className="text-muted-foreground">Not recorded</span>}
                hint={field.value === null ? "no source records this" : <Provenance field={field} />}
              />
            ))}
          </div>
          {unrecorded(company.business_model) > 0 && (
            <div className="border-t px-5 py-3">
              <GapNote fields={company.business_model} />
            </div>
          )}
        </Card>
      </div>

      <FillFieldsDialog
        tenantId={tenantId}
        fields={fillable}
        open={fillOpen}
        onOpenChange={setFillOpen}
        onSaved={onRefresh}
      />

      <ResearchCompanyDialog
        tenantId={tenantId}
        website={company.domain ?? ""}
        open={researchOpen}
        onOpenChange={setResearchOpen}
        onSaved={onRefresh}
      />
    </div>
  );
}
