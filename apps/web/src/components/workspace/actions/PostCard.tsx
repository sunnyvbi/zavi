"use client";

import { isPostImagePath } from "./usePostImageSource";
import { useState, type ReactNode } from "react";
import { REDDIT_ORGANIC_SLUG } from "@/lib/agentRegistry";
import { cn } from "@/lib/cn";
import type { LucideIcon } from "lucide-react";
import { PostVideo } from "./PostVideo";
import { PostPhotoFields } from "./PostPhotoFields";
import { PostPhoto } from "./PostPhoto";
import { usePostDraft } from "./usePostDraft";
import { usePostPhoto } from "./usePostPhoto";
import { PostEditDialog } from "./PostEditDialog";
import { useChannelSurface } from "./ChannelSurface";
import { PostPreview } from "./PostPreview";
import { PostFooter } from "./PostFooter";
import { StatusBanner } from "./StatusBanner";
import { usePostEditing } from "./usePostEditing";
import { HowTo } from "./HowTo";
import { PartTabs } from "./PartTabs";
import { BlanksFill, useBlankFills } from "./BlanksFill";
import { cardTag } from "./registry";
import { ClampedPane, PaneCaption, SplitCard, isLongDeliverable } from "./SplitCard";
import { CONFIRM_RE, actionText, cardEvidence, copyAllParts, deliverableOf, deliverableParts, partPostContent, postContent, type ActionBodyProps } from "./types";

export function PostCard({
  action: a,
  platform,
  handlers,
  busy,
  isNew,
  icon,
  media,
  above,
  onSave,
  canSnooze,
  canRedo,
  publishLabel,
  manualPost,
}: ActionBodyProps & {
  icon: LucideIcon;
  onSave?: (text: string) => Promise<void>;
  canSnooze?: boolean;
  canRedo?: boolean;
  publishLabel?: string;
  manualPost?: boolean;
  media?: ReactNode;
  above?: ReactNode;
}) {
  const parts = a.body?.step?.deliverable?.kind === "thread" || (a.edited_body?.text?.trim() && !a.edited_body.variants) || (Array.isArray(a.body?.thread) && a.body.thread.length) ? null : deliverableParts(a);
  const [selected, setSelected] = useState(0);
  const sel = parts ? Math.min(selected, parts.length - 1) : 0;
  const seed = (i: number) => (parts ? a.edited_body?.variants?.[i] ?? partPostContent(a, parts[i].content) : postContent(a));
  const [drafts, setDrafts] = useState<Record<number, { text: string; thread: string[] | null }>>({});
  const current = drafts[sel] ?? seed(sel);
  const text = current.text;
  const thread = current.thread;
  const setText = (t: string) => setDrafts((all) => ({ ...all, [sel]: { ...(all[sel] ?? seed(sel)), text: t } }));
  const setThread = (th: string[] | null) => setDrafts((all) => ({ ...all, [sel]: { ...(all[sel] ?? seed(sel)), thread: th } }));
  const surface = useChannelSurface();
  const draft = usePostDraft(a, !!surface && !onSave);
  const photo = usePostPhoto(a.edited_body);
  const save = draft.persisted ? async () => {
    const saved = await draft.save({ text, thread, variant_index: parts && a.run_id !== null && !a.staged_draft_id ? sel : undefined, image_path: photo.value.image_path ?? (a.body?.media?.url && isPostImagePath(a.body.media.url) ? a.body.media.url : undefined), size: photo.value.size, headline: photo.value.headline });
    if (saved) photo.change(saved);
  } : onSave;
  const { editing, saving, error: saveError, toggle, cancel } = usePostEditing(text, save);
  const [checkpoint, setCheckpoint] = useState(current);
  const openEditor = () => { if (!editing) { setCheckpoint(current); photo.begin(a.action_type === "image_post" && !!a.body?.media?.url, platform?.postImageSizes?.[0].value); } void toggle(); };
  const cancelEditor = () => { if (!saving && !photo.busy) { photo.cancel(); setDrafts((all) => ({ ...all, [sel]: checkpoint })); cancel(); } };

  const name = platform?.name ?? "the platform";
  const limit = platform?.charLimit;
  const measure = (s: string) => (platform?.measure ? platform.measure(s) : s.length);
  const fills = useBlankFills([text, ...(thread ?? [])], null, a.channel_slug);
  const outText = fills.fill(text);
  const outThread = thread ? thread.map(fills.fill) : null;
  const texts = [outText, ...(outThread ?? [])];
  const length = measure(outText);
  const overLimit = limit !== undefined && texts.some((p) => measure(p) > limit);
  const needsConfirm = texts.some((p) => CONFIRM_RE.test(p));
  const threadReason = outThread?.some(part => !part.trim())
    ? "Write something in every post of the thread before posting."
    : platform?.maxThreadPosts && texts.length > platform.maxThreadPosts
      ? `Zavi supports up to ${platform.maxThreadPosts} posts per ${name} thread. Remove the extra parts before posting.`
      : null;
  const textReason = !outText.trim()
    ? "Write something before posting."
    : threadReason
    ? threadReason
    : fills.left > 0
    ? `Fill the ${fills.left} ${fills.left === 1 ? "blank" : "blanks"} above before posting.`
    : needsConfirm
    ? "This draft has a fact marked [CONFIRM: …] that Zavi could not verify. Edit it to the real figure, or remove it, before posting."
    : overLimit
      ? `This is over ${name}'s ${limit}-character limit. Shorten it before posting.`
      : null;
  const editReason = !outText.trim() ? "Write something before posting." : threadReason ?? (overLimit ? `This is over ${name}'s ${limit}-character limit. Shorten it before posting.` : null);
  const mediaReason = photo.value.rendered_image_path && thread?.length ? "Image posts cannot be published as a thread. Remove the extra parts before posting." : null;
  const redditManual = !!platform?.directPublishOnly && !handlers.onPublish && a.channel_slug === REDDIT_ORGANIC_SLUG;
  const [connectError, setConnectError] = useState<string | null>(null);
  const footerHandlers: typeof handlers = redditManual
    ? {
        ...handlers,
        onPublish: async () => {
          setConnectError(null);
          try {
            const { startRailConnect } = await import("@/app/connectors/connectStrategies");
            await startRailConnect("reddit", "reddit_social");
          } catch {
            setConnectError("Couldn't start connecting Reddit. Try again from Settings.");
          }
          return false;
        },
      }
    : handlers;
  const notConnected = !!platform?.directPublishOnly && !footerHandlers.onPublish;
  const blockedReason = mediaReason ?? (notConnected
    ? `Connect ${name} in Settings → Integrations to post.`
    : platform?.publishBlocked?.(a, outText) ?? textReason);
  const composerHref = platform?.composerUrl ? platform.composerUrl(outText, a) : null;
  const rationale = deliverableOf(a) ? actionText(a) : null;
  const account = platform?.account;

  const isReply = a.action_type === "reply";
  const photoSource = (!editing && photo.value.rendered_image_path) || photo.value.image_path || a.body?.media?.url;
  const previewMedia = a.action_type === "image_post" && photoSource && ((surface && editing) || isPostImagePath(photoSource) || photo.value.image_path || photo.value.rendered_image_path || photo.value.headline || photo.value.size) ? <PostPhoto source={photoSource} headline={photo.value.headline} size={photo.value.size} rendered={!editing && !!photo.value.rendered_image_path} /> : a.action_type === "video_post" && a.body?.media?.url && /^[a-f0-9-]{36}\/[a-f0-9-]{36}\.mp4$/.test(a.body.media.url) ? <PostVideo source={a.body.media.url} /> : media;
  const preview = (
    <PostPreview channelSlug={a.channel_slug} account={account} proposedAt={a.proposed_at} media={previewMedia} edited={!!a.edited_body} posted={a.exec_status === "executed"}>
      {editing && !surface ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Edit post"
          rows={Math.min(14, Math.max(4, text.split("\n").length + 1))}
          className="w-full min-w-0 resize-y rounded-lg border border-rule bg-cream px-3 py-2 text-sm leading-relaxed text-ink"
        />
      ) : (
        <p data-testid="post-text" className="whitespace-pre-wrap text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">
          {text}
        </p>
      )}
      {limit !== undefined && (editing || overLimit) && (
        <p className={cn("mt-1 text-right text-xs tabular-nums", overLimit ? "text-red-500" : "text-inkMuted")}>
          {length} / {limit}
        </p>
      )}
      {thread && (
        <ol data-testid="post-thread" className="mt-3 space-y-2 border-l-2 border-rule pl-3">
          {thread.map((part, i) => (
            <li key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">
              {editing && !surface ? (
                <textarea
                  value={part}
                  onChange={(e) => setThread(thread.map((p, j) => (j === i ? e.target.value : p)))}
                  aria-label={`Edit part ${i + 2}`}
                  rows={Math.min(14, Math.max(2, part.split("\n").length + 1))}
                  className="w-full min-w-0 resize-y rounded-lg border border-rule bg-cream px-3 py-2 text-sm leading-relaxed text-ink"
                />
              ) : (
                part
              )}
            </li>
          ))}
        </ol>
      )}
    </PostPreview>
  );

  const whyBlock = rationale ? (
    <div data-testid="post-why">
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-inkSoft [overflow-wrap:anywhere]">{rationale}</p>
    </div>
  ) : null;

  const rightPane = (
        <div className="space-y-4">
          {above && (
            <div>
              <PaneCaption>Replying to</PaneCaption>
              {above}
            </div>
          )}
          <div>
            <PaneCaption>{a.channel_slug === "blog" ? "Article preview" : isReply ? "Reply preview" : a.action_type === "video_post" ? "Video preview" : "Feed preview"}</PaneCaption>
            {}
            {parts ? (
              <PartTabs labels={parts.map((p) => p.label)} selected={sel} onSelect={setSelected} copyText={texts.join("\n\n")} copyDisabled={fills.left > 0}>
                <ClampedPane key={sel} long={!editing && isLongDeliverable(texts.join("\n\n"))} testId="post-preview">
                  {preview}
                </ClampedPane>
              </PartTabs>
            ) : (
              <ClampedPane long={!editing && isLongDeliverable(texts.join("\n\n"))} testId="post-preview">
                {preview}
              </ClampedPane>
            )}
          </div>
          <BlanksFill fills={fills} />
          {saveError && <p role="alert" className="text-sm text-danger">{saveError}</p>}
          {saving && <p role="status" className="text-sm text-inkMuted">Saving draft…</p>}
        </div>
  );

  return (<>
    {surface && editing && <PostEditDialog heading={a.channel_slug === "blog" ? "Edit the article" : isReply ? "Edit the reply" : a.action_type === "video_post" ? "Edit the video" : "Edit the post"} contentLabel={a.channel_slug === "blog" ? "Article" : isReply ? "Reply" : media ? "Caption" : "Post text"} title={a.title} text={text} thread={thread} limit={limit} measure={measure} saving={saving || photo.busy || draft.loading} error={saveError || draft.error} persisted={!!onSave || draft.persisted} invalidReason={onSave ? editReason : null} photoFields={a.action_type === "image_post" ? <PostPhotoFields value={photo.value} original={a.body?.media?.url} disabled={saving || photo.busy} sizes={platform?.postImageSizes} onChange={photo.change} onBusy={photo.setBusy} /> : undefined} onText={setText} onThread={setThread} onSave={() => void toggle()} onCancel={cancelEditor} onReset={() => { photo.reset(); setDrafts((all) => ({ ...all, [sel]: parts ? partPostContent(a, parts[sel].content) : postContent({ ...a, edited_body: null }) })); }} />}
    <SplitCard
      a={a}
      icon={platform?.icon ?? icon}
      kind={cardTag(a, isReply ? "Reply" : "Post")}
      isNew={isNew}
      why={whyBlock}
      below={a.how_to?.length ? <HowTo a={a} /> : undefined}
      bring={cardEvidence(a).estimate[0] ?? null}
      right={rightPane}
      banner={a.exec_status === "executed" ? <StatusBanner a={a} platformName={name} execCopy={platform?.execCopy} /> : undefined}
      footer={a.exec_status === "executed" ? undefined : <>
        <PostFooter
          a={a}
          handlers={footerHandlers}
          busy={busy || saving}
          text={outText}
          thread={outThread}
          imagePath={photo.value.rendered_image_path}
          postRevision={a.run_id === null || a.staged_draft_id ? draft.publishRevision ?? a.post_revision : undefined}
          editing={editing}
          onToggleEdit={openEditor}
          canSnooze={canSnooze}
          canRedo={canRedo}
          platformName={name}
          directPublishOnly={platform?.directPublishOnly}
          publishLabel={redditManual ? "Connect Reddit to post" : publishLabel}
          manualPost={manualPost || redditManual}
          composerHref={composerHref}
          composerLabel={platform?.composerLabel}
          blockedReason={blockedReason}
          copyAllText={
            parts
              ? copyAllParts(parts.map((p, i) => {
                  const cur = drafts[i] ?? seed(i);
                  return { label: p.label, content: fills.fill([cur.text, ...(cur.thread ?? [])].join("\n\n")) };
                }))
              : null
          }
        />
        {connectError && <p role="alert" className="mt-3 rounded-lg border border-warn bg-warnBg px-3 py-2 text-sm text-ink">{connectError}</p>}
        {blockedReason && !notConnected && <p role="status" className="mt-3 rounded-lg border border-warn bg-warnBg px-3 py-2 text-sm text-ink">{blockedReason}</p>}
      </>}
    />
  </>);
}
