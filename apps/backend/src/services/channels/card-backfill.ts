import { cardPresentation, SITE_KINDS, type CardPresentation } from "./card-presentation";
import type { SiteBuilder } from "./site-builder-markers";
import { CARD_INTENTS, type CardIntent } from "@/agents/lib/channel-recipe-step";

export type BackfillRow = {
  id: string;
  tenant_id: string;
  channel_slug: string;
  action_type: string;
  exec_class: string | null;
  body: unknown;
};

export function backfillPresentation(row: BackfillRow, siteBuilder: SiteBuilder): CardPresentation {
  const body = (row.body && typeof row.body === "object" ? row.body : {}) as {
    step?: {
      body?: unknown;
      deliverable?: { kind?: unknown; content?: unknown } | null;
      how_to?: unknown;
      target?: { kind?: unknown } | null;
      intent?: unknown;
      owner?: unknown;
    };
    link?: unknown;
    exact_change?: { rows?: Array<{ item: string; before: string; after: string }> } | null;
  };
  const kind = body.step?.deliverable?.kind;
  return cardPresentation({
    channelSlug: row.channel_slug,
    action_type: row.action_type,
    executable: typeof row.exec_class === "string" && row.exec_class.length > 0,
    deliverableKind: typeof kind === "string" ? kind : null,
    hasContent: typeof body.step?.deliverable?.content === "string" && body.step.deliverable.content.trim().length > 0,
    deliverableContent: typeof body.step?.deliverable?.content === "string" ? body.step.deliverable.content : null,
    stepBody: typeof body.step?.body === "string" ? body.step.body : null,
    link: typeof body.link === "string" && body.link ? body.link : null,
    rows: body.exact_change?.rows ?? null,
    siteBuilder,
    structuredSteps: Array.isArray(body.step?.how_to)
      ? body.step.how_to.filter((x): x is string => typeof x === "string")
      : null,
    targetKind: typeof body.step?.target?.kind === "string" ? body.step.target.kind : null,
    stepIntent: (CARD_INTENTS as readonly string[]).includes(body.step?.intent as string)
      ? (body.step!.intent as CardIntent)
      : null,
    stepOwner: body.step?.owner === "founder" || body.step?.owner === "developer" ? body.step.owner : null,
  });
}

export function needsSiteBuilder(row: BackfillRow): boolean {
  const p = backfillPresentation(row, "unknown");
  const kind = (row.body as { step?: { deliverable?: { kind?: unknown } } } | null)?.step?.deliverable?.kind;
  return kind === "code" || (p.card_kind === "copy_to_site" && typeof kind === "string" && SITE_KINDS.has(kind));
}
