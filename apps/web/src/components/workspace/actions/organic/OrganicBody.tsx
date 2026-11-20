import type { ReactNode } from "react";
import { Steps } from "../card/blocks/Steps";
import { CopyText } from "../card/blocks/CopyText";
import { MediaTile, WithMedia } from "../card/blocks/MediaTile";
import { SpecTable, type SpecRow } from "../card/blocks/SpecTable";
import { ChangeRows } from "../paid/blocks/ChangeRows";
import { clipText, explainsFirst, type CardCopy } from "../card/cardModel";
import { copyTextOf, isPostCard } from "../card/cardPrimary";
import { deliverableOf, deliverableParts, exactChangeRows, mediaOf, type ActionItem } from "../types";
import { ContextCopy } from "./blocks/ContextCopy";
import { LabeledFields } from "./blocks/LabeledFields";
import { RecipientLine } from "./blocks/RecipientLine";

const ROW = /^\s*([^:\n]{2,32}):\s+(.+)$/;
const LONG_KINDS = new Set(["article", "page_copy", "proof_page"]);

export function specRows(text: string): SpecRow[] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = lines.map((l) => ROW.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ label: m[1]!.trim(), value: m[2]!.trim() }));
  return rows.length >= 2 && rows.length >= lines.length * 0.6 ? rows : null;
}

function contextLabel(a: ActionItem): string | null {
  const r = a.body?.reply_to;
  if (!r?.text && !r?.author) return null;
  const said = r.text ? clipText(r.text, 80) : null;
  return [r.author, said].filter(Boolean).join(": ");
}

export function OrganicBody({ a, copy, edited, mediaOverride }: { a: ActionItem; copy: CardCopy; edited: string | null; mediaOverride?: ReactNode }) {
  const text = edited ?? copyTextOf(a);
  const kind = deliverableOf(a)?.kind ?? null;
  const lead = <Steps lead={copy.lead} points={text ? [] : copy.points} />;
  const exact = exactChangeRows(a).filter((row) => !!row.after);
  const exactTable = exact.length > 0 ? <ChangeRows lead={null} rows={exact} /> : null;
  if (!text) return <><Steps lead={copy.lead} points={copy.points} />{exactTable}</>;
  if (!edited && explainsFirst(a) && copy.lead) return <><CopyText text={copy.lead} lists />{exactTable}</>;
  const parts = edited ? null : deliverableParts(a);
  if (parts && a.action_type !== "reply") return <>{lead}<LabeledFields fields={parts} />{exactTable}</>;
  const label = a.action_type === "reply" ? contextLabel(a) : null;
  if (label) return <><ContextCopy label={label} text={text} />{exactTable}</>;
  const to = a.body?.recipient?.name;
  if (a.action_type === "send_message" && to) return <><RecipientLine to={`To ${to}${a.body?.recipient?.channel ? ` on ${a.body.recipient.channel}` : ""}`} text={text} />{exactTable}</>;
  if (kind === "brief") {
    const rows = specRows(text);
    if (rows) return <>{lead}<SpecTable rows={rows} />{exactTable}</>;
  }
  const media = mediaOf(a);
  const body = <CopyText text={text} kind={kind} code={kind === "code"} maxParagraphs={kind && LONG_KINDS.has(kind) ? 2 : undefined} testId={isPostCard(a) ? "post-text" : undefined} lists={!isPostCard(a)} short={!isPostCard(a) && !mediaOf(a)} />;
  if (mediaOverride || media) return <WithMedia media={mediaOverride ?? <MediaTile url={media!.url} alt={media!.alt} video={media!.kind === "video"} />}><div className="flex min-w-0 flex-col gap-3">{body}{exactTable}</div></WithMedia>;
  return <>{lead}{body}{exactTable}</>;
}
