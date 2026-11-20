"use client";

import { useCallback, useState } from "react";
import { Check, Lock } from "lucide-react";
import { MetaPanel, YoutubePanel, downloadLibraryVideo, type LibraryAsset } from "@/components/humans/CreatorLibraryIsland";
import type { CreatorSearchResult } from "@/lib/creator-storefront";
import { pushWorkspaceLocation, readWorkspaceLocation } from "../navigation/workspaceRoutes";
import { useChannelChatOpener } from "../actions/channelChat";
import { CardShell } from "../actions/card/CardShell";
import { CardEyebrow } from "../actions/card/CardEyebrow";
import { CardButton } from "../actions/card/CardButton";
import { ClosedRow } from "../actions/card/ClosedRow";
import { InfoDialog } from "../actions/card/CardDialogs";
import { StatusLine } from "../actions/card/blocks/StatusLine";
import { SpecTable } from "../actions/card/blocks/SpecTable";
import { MediaTile, WithMedia } from "../actions/card/blocks/MediaTile";
import { LabeledFields } from "../actions/organic/blocks/LabeledFields";
import { Steps } from "../actions/card/blocks/Steps";
import { clipText, howItWorks, LEAD_MAX } from "../actions/card/cardModel";
import { creatorCardChatDraft, type CardButton as CreatorButton, type CardTarget, type CreatorCard } from "./creatorCards";
import { ApplicantsPane, BookPane } from "./creatorPanes";
import { useUgcDrawer } from "./hub";
import { channelHref } from "./channelHref";

const FOOTNOTE_MAX = 120;

function Media({ media }: { media: NonNullable<CreatorCard["media"]> }) {
  const badge = media.watermarked ? (
    <span className="pointer-events-none absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-ca-eyebrow font-semibold text-white">
      <Lock className="size-3" aria-hidden />
      Preview
    </span>
  ) : null;
  if (media.url) return <MediaTile url={media.url} alt={media.label} video overlay={badge} />;
  return (
    <span className="flex aspect-ad-feed w-ca-media shrink-0 items-center justify-center rounded-lg bg-ca-subtle p-3 text-center text-ca-action text-ca-secondary">
      {media.waiting ? "The video appears here once it arrives." : media.label}
    </span>
  );
}

function aboutOf(card: CreatorCard): string {
  const note = card.pane?.note && card.pane.note.length > FOOTNOTE_MAX ? card.pane.note : null;
  const preview = card.preview ? [["Brief", card.preview.title], ["Angle", card.preview.angle], ["Hook", card.preview.hook]].filter(([, v]) => !!v).map(([l, v]) => `${l}: ${v}`) : [];
  return [card.lead, ...card.why, ...preview, note].filter(Boolean).join("\n\n");
}

export function CreatorActionCard({ slug, card, asset, bookable, settled, onHide, onUndo, onChanged }: {
  slug: string;
  card: CreatorCard;
  asset: LibraryAsset | null;
  bookable: CreatorSearchResult[];
  settled: string | null;
  onHide: (label: string) => void;
  onUndo: () => void;
  onChanged: () => void;
}) {
  const drawer = useUgcDrawer();
  const openChat = useChannelChatOpener();
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<{ tone: "muted" | "error"; text: string } | null>(null);
  const [pushing, setPushing] = useState<"meta" | "youtube" | null>(null);
  const [about, setAbout] = useState(false);

  const go = useCallback(async (t: CardTarget, label: string) => {
    setLine(null);
    switch (t.kind) {
      case "drawer":
        drawer.open(t.name, t.params ?? {});
        return;
      case "channel":
        pushWorkspaceLocation(channelHref(readWorkspaceLocation(), t.slug, { ...(t.drawer ? { drawer: t.drawer } : {}), ...(t.params ?? {}) }));
        return;
      case "push":
        setPushing(t.push);
        return;
      case "download": {
        setBusy(true);
        const error = await downloadLibraryVideo(t.assetId);
        setBusy(false);
        setLine(error ? { tone: "error", text: error } : { tone: "muted", text: "Download started." });
        return;
      }
      case "hide":
        onHide(label);
        return;
    }
  }, [drawer, onHide]);

  if (settled === "Closed") return <ClosedRow title={card.title} onUndo={onUndo} />;

  const pane = card.pane;
  const muted = new Set(pane?.muted ?? []);
  const rows = (pane?.rows ?? []).map(([label, value]) => ({ label, value, muted: muted.has(value) }));
  const footnote = pane?.note && pane.note.length <= FOOTNOTE_MAX ? pane.note : null;
  const fields = card.preview ? [
    { label: "Brief", content: card.preview.title },
    ...(card.preview.angle ? [{ label: "Angle", content: card.preview.angle }] : []),
    ...(card.preview.hook ? [{ label: "Hook", content: card.preview.hook }] : []),
  ] : [];
  const hasBody = rows.length > 0 || fields.length > 0 || !!card.media || !!card.applicantsOf || card.bookPane;
  const facts = (
    <div className="flex flex-col gap-3">
      {fields.length > 0 && <LabeledFields fields={fields} />}
      <SpecTable rows={rows} footnote={footnote} />
    </div>
  );
  const button = (b: CreatorButton, primary: boolean) => (
    <CardButton key={b.label} variant={primary ? "primary" : "secondary"} disabled={busy} data-primary={primary || undefined} onClick={() => void go(b.target, b.label)}>
      {b.icon === "check" && <Check className="size-4" aria-hidden />}
      {b.label}
    </CardButton>
  );
  const actions = settled ? (
    <span className="ml-auto inline-flex items-center gap-1.5 text-ca-action font-medium">
      <span role="status" className="text-ca-secondary">{settled}</span>
      <CardButton variant="ghost" onClick={onUndo}>Undo</CardButton>
    </span>
  ) : (
    <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1.5">
      {(card.secondary ?? []).map((b) => button(b, false))}
      {card.dismiss && <CardButton onClick={() => onHide(card.dismiss === "Reject" ? "Rejected" : "Not now")}>{card.dismiss}</CardButton>}
      {openChat && <CardButton onClick={() => openChat({ target: "channel", draft: { text: creatorCardChatDraft(slug, card), nonce: Date.now() } })}>Ask Zavi</CardButton>}
      {button(card.primary, true)}
    </span>
  );
  return (
    <>
      <CardShell
        id={card.id}
        title={card.title}
        eyebrow={<CardEyebrow kind={card.kind} meta={[]} />}
        actions={actions}
        steps={howItWorks([], card.primary.label)}
        onClose={settled ? undefined : () => onHide("Closed")}
        onAbout={() => setAbout(true)}
      >
        {!hasBody && <Steps lead={clipText(card.lead, LEAD_MAX)} points={[]} />}
        {card.media ? <WithMedia media={<Media media={card.media} />}>{facts}</WithMedia> : (rows.length > 0 || fields.length > 0) && facts}
        {card.applicantsOf && <ApplicantsPane briefId={card.applicantsOf} />}
        {card.bookPane && <BookPane creators={bookable} />}
        {line && <StatusLine tone={line.tone}>{line.text}</StatusLine>}
        {pushing && asset && (
          <div className="border-t border-ca-border pt-3">
            {pushing === "meta" ? <MetaPanel asset={asset} onCreated={onChanged} /> : <YoutubePanel asset={asset} onChanged={onChanged} />}
          </div>
        )}
      </CardShell>
      <InfoDialog open={about} title={card.title} about={aboutOf(card)} onClose={() => setAbout(false)} />
    </>
  );
}
