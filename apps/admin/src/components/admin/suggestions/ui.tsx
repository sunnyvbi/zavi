"use client";

import type { ReactNode } from "react";
import { AlertTriangle, ExternalLink, PlugZap, Settings2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { displayDomain, fmtDelta, fmtRelative, siteHref } from "./workspace/format";
import type { ProfileField, SectionStatus } from "./workspace/types";

export const TONE = {
  good: "bg-emerald-50 text-emerald-700",
  warn: "bg-amber-50 text-amber-700",
  bad: "bg-rose-50 text-rose-700",
  flat: "bg-muted text-muted-foreground",
} as const;

export type Tone = keyof typeof TONE;

export function ToneBadge({
  tone,
  dot = false,
  children,
}: {
  tone: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 whitespace-nowrap border-transparent", TONE[tone])}>
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </Badge>
  );
}

export function TabHeader({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
        {meta && <div className="mt-1 text-xs text-muted-foreground">{meta}</div>}
      </div>
      {action}
    </div>
  );
}

const NOTICE: Record<
  Exclude<SectionStatus, "ready">,
  { icon: typeof AlertTriangle; title: string; className: string }
> = {
  partial: { icon: AlertTriangle, title: "Partial data", className: "border-amber-200 bg-amber-50" },
  not_configured: { icon: Settings2, title: "Not configured yet", className: "bg-muted" },
  not_connected: { icon: PlugZap, title: "No connected source", className: "bg-muted" },
};

export function Notice({ status, detail }: { status: SectionStatus; detail: string | null }) {
  if (status === "ready") return null;
  const notice = NOTICE[status];
  if (!notice) return null;
  const { icon: Icon, title, className } = notice;
  return (
    <Alert className={cn("mb-6", className)}>
      <Icon className="size-4" />
      <AlertTitle>{title}</AlertTitle>
      {detail && <AlertDescription className="text-muted-foreground">{detail}</AlertDescription>}
    </Alert>
  );
}

export function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string | null;
  action?: ReactNode;
}) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed px-6 py-16 text-center">
      <div className="max-w-md">
        <p className="font-semibold text-foreground">{title}</p>
        {detail && <p className="mt-2 text-sm text-muted-foreground">{detail}</p>}
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}

export function Panel({
  title,
  meta,
  action,
  className,
  children,
}: {
  title: string;
  meta?: string | null;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0 border-b px-6 py-4">
        <CardTitle className="text-base">{title}</CardTitle>
        {action ?? (meta ? <p className="text-xs uppercase text-muted-foreground">{meta}</p> : null)}
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

export function Stat({
  label,
  value,
  hint,
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <p className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 truncate text-xl font-semibold text-foreground">{value}</p>
      {hint && <div className="mt-1 flex items-center gap-2 truncate text-xs text-muted-foreground">{hint}</div>}
    </>
  );
  if (!onClick) return <div className="min-w-0 bg-card px-5 py-4">{body}</div>;
  return (
    <button type="button" onClick={onClick} className="min-w-0 bg-card px-5 py-4 text-left hover:bg-muted/60">
      {body}
    </button>
  );
}

export function Delta({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return <ToneBadge tone={(invert ? value <= 0 : value >= 0) ? "good" : "bad"}>{fmtDelta(value)}</ToneBadge>;
}

export function NotRecorded() {
  return <span className="text-sm font-medium text-muted-foreground">Not recorded</span>;
}

export function Provenance({ field }: { field: ProfileField }) {
  if (field.value === null || !field.source) return null;
  const estimated = field.source === "ai_estimated";
  const [badge, ...rest] = estimated && field.note ? field.note.split(" · ") : [null, field.note];
  const parts = [
    estimated ? null : field.source.replace(/_/g, " "),
    ...rest,
    field.observed_at && fmtRelative(field.observed_at),
  ].filter(Boolean);
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {estimated && <ToneBadge tone="warn">{badge ?? "AI-estimated"}</ToneBadge>}
      <span>{parts.join(" · ")}</span>
    </p>
  );
}

export function Field({ field, className }: { field: ProfileField; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-xs font-semibold uppercase text-muted-foreground">{field.label}</p>
      <div className="mt-2">
        {field.value === null ? (
          <NotRecorded />
        ) : (
          <p className="break-words text-sm font-medium text-foreground">{field.value}</p>
        )}
        <Provenance field={field} />
      </div>
    </div>
  );
}

export function SiteLink({ href, className }: { href: string; className?: string }) {
  return (
    <a
      href={siteHref(href)}
      target="_blank"
      rel="noreferrer"
      className={cn("inline-flex min-w-0 items-center gap-1.5 hover:underline", className)}
    >
      <span className="truncate">{displayDomain(href)}</span>
      <ExternalLink className="size-3.5 shrink-0" />
    </a>
  );
}

const BRAND_ICONS: Record<string, { viewBox: string; d: string }> = {
  linkedin: {
    viewBox: "0 0 448 512",
    d: "M100.28 448H7.4V148.9h92.88zM53.79 108.1C24.09 108.1 0 83.5 0 53.8a53.79 53.79 0 0 1 107.58 0c0 29.7-24.1 54.3-53.79 54.3zM447.9 448h-92.68V302.4c0-34.7-.7-79.2-48.29-79.2-48.29 0-55.69 37.7-55.69 76.7V448h-92.78V148.9h89.08v40.8h1.3c12.4-23.5 42.69-48.3 87.88-48.3 94 0 111.28 61.9 111.28 142.3V448z",
  },
  x: {
    viewBox: "0 0 512 512",
    d: "M389.2 48h70.6L305.6 224.2 487 464H345L233.7 318.6 106.5 464H35.8L200.7 275.5 26.8 48H172.4L272.9 180.9 389.2 48zM364.4 421.8h39.1L151.1 88h-42L364.4 421.8z",
  },
  facebook: {
    viewBox: "0 0 320 512",
    d: "M80 299.3V512H196V299.3h86.5l18-97.8H196V166.9c0-51.7 20.3-71.5 72.7-71.5c16.3 0 29.4 .4 37 1.2V7.9C291.4 4 256.4 0 236.2 0C129.3 0 80 50.5 80 159.4v42.1H14v97.8H80z",
  },
  instagram: {
    viewBox: "0 0 448 512",
    d: "M224.1 141c-63.6 0-114.9 51.3-114.9 114.9s51.3 114.9 114.9 114.9S339 319.5 339 255.9 287.7 141 224.1 141zm0 189.6c-41.1 0-74.7-33.5-74.7-74.7s33.5-74.7 74.7-74.7 74.7 33.5 74.7 74.7-33.6 74.7-74.7 74.7zm146.4-194.3c0 14.9-12 26.8-26.8 26.8-14.9 0-26.8-12-26.8-26.8s12-26.8 26.8-26.8 26.8 12 26.8 26.8zm76.1 27.2c-1.7-35.9-9.9-67.7-36.2-93.9-26.2-26.2-58-34.4-93.9-36.2-37-2.1-147.9-2.1-184.9 0-35.8 1.7-67.6 9.9-93.9 36.1s-34.4 58-36.2 93.9c-2.1 37-2.1 147.9 0 184.9 1.7 35.9 9.9 67.7 36.2 93.9s58 34.4 93.9 36.2c37 2.1 147.9 2.1 184.9 0 35.9-1.7 67.7-9.9 93.9-36.2 26.2-26.2 34.4-58 36.2-93.9 2.1-37 2.1-147.8 0-184.8zM398.8 388c-7.8 19.6-22.9 34.7-42.6 42.6-29.5 11.7-99.5 9-132.1 9s-102.7 2.6-132.1-9c-19.6-7.8-34.7-22.9-42.6-42.6-11.7-29.5-9-99.5-9-132.1s-2.6-102.7 9-132.1c7.8-19.6 22.9-34.7 42.6-42.6 29.5-11.7 99.5-9 132.1-9s102.7-2.6 132.1 9c19.6 7.8 34.7 22.9 42.6 42.6 11.7 29.5 9 99.5 9 132.1s2.7 102.7-9 132.1z",
  },
  youtube: {
    viewBox: "0 0 576 512",
    d: "M549.655 124.083c-6.281-23.65-24.787-42.276-48.284-48.597C458.781 64 288 64 288 64S117.22 64 74.629 75.486c-23.497 6.322-42.003 24.947-48.284 48.597-11.412 42.867-11.412 132.305-11.412 132.305s0 89.438 11.412 132.305c6.281 23.65 24.787 41.5 48.284 47.821C117.22 448 288 448 288 448s170.78 0 213.371-11.486c23.497-6.321 42.003-24.171 48.284-47.821 11.412-42.867 11.412-132.305 11.412-132.305s0-89.438-11.412-132.305zm-317.51 213.508V175.185l142.739 81.205-142.739 81.201z",
  },
  tiktok: {
    viewBox: "0 0 448 512",
    d: "M448,209.91a210.06,210.06,0,0,1-122.77-39.25V349.38A162.55,162.55,0,1,1,185,188.31V278.2a74.62,74.62,0,1,0,52.23,71.18V0l88,0a121.18,121.18,0,0,0,1.86,22.17h0A122.18,122.18,0,0,0,381,102.39a121.43,121.43,0,0,0,67,20.14Z",
  },
};

function BrandIcon({ platform, className }: { platform: string; className?: string }) {
  const icon = BRAND_ICONS[platform === "twitter" ? "x" : platform];
  if (!icon) return null;
  return (
    <svg aria-hidden viewBox={icon.viewBox} fill="currentColor" className={className}>
      <path d={icon.d} />
    </svg>
  );
}

export type SocialTile = { platform: string; followers: string | null; url?: string | null };

export function SocialTiles({
  tiles,
  kind = "connected",
}: {
  tiles: SocialTile[];
  kind?: "connected" | "found";
}) {
  const verb = kind === "found" ? "found" : "connected";
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-bold uppercase text-muted-foreground">
        Social profiles · {tiles.length} {verb}
      </p>
      {tiles.length === 0 ? (
        <p className="text-sm text-muted-foreground">No social profiles {verb}.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tiles.map((tile) => {
            if (!BRAND_ICONS[tile.platform === "twitter" ? "x" : tile.platform]) return null;
            const className =
              "flex w-11 flex-col items-center gap-1 rounded-lg border py-1.5 text-foreground";
            const body = (
              <>
                <BrandIcon platform={tile.platform} className="size-4 shrink-0" />
                <span className="sr-only">{tile.platform}</span>
                <span className="w-full truncate text-center text-[10px] font-medium text-muted-foreground">
                  {tile.followers ?? "—"}
                </span>
              </>
            );
            return tile.url ? (
              <a
                key={tile.platform}
                href={siteHref(tile.url)}
                target="_blank"
                rel="noreferrer"
                className={cn(className, "hover:bg-muted")}
              >
                {body}
              </a>
            ) : (
              <div key={tile.platform} className={className} title={tile.followers ?? undefined}>
                {body}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
