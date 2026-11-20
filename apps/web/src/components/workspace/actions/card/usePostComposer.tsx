"use client";

import { useState, type ReactNode } from "react";
import { getChannel } from "@zavi/shared";
import { REDDIT_ORGANIC_SLUG } from "@/lib/agentRegistry";
import { ChannelMarkIcon } from "../../growth/GrowthChannelLabel";
import { useBlankFills, type BlankFills } from "../BlanksFill";
import { useChannelSurface } from "../ChannelSurface";
import { MediaMissing } from "../MediaFrame";
import { PartTabs } from "../PartTabs";
import { PostEditDialog } from "../PostEditDialog";
import { PostPhoto } from "../PostPhoto";
import { PostPhotoFields } from "../PostPhotoFields";
import { PostPreview } from "../PostPreview";
import { PostVideo } from "../PostVideo";
import { CONFIRM_RE, copyAllParts, deliverableParts, mediaOf, partPostContent, postContent, type ActionBodyProps, type ActionHandlers } from "../types";
import { usePostDraft } from "../usePostDraft";
import { usePostEditing } from "../usePostEditing";
import { isPostImagePath } from "../usePostImageSource";
import { usePostPhoto } from "../usePostPhoto";

type Draft = { text: string; thread: string[] | null };
type PublishContent = Parameters<NonNullable<ActionHandlers["onPublish"]>>[1];

export type PostComposer = {
  handlers: ActionHandlers;
  fills: BlankFills;
  outText: string;
  texts: string[];
  display: string | null;
  media: ReactNode;
  below: ReactNode;
  wrap: (body: ReactNode) => ReactNode;
  blockedReason: string | null;
  statusLine: string | null;
  error: string | null;
  publishLabel: string | null;
  directPublish: boolean;
  manualPost: boolean;
  canCopy: boolean;
  publishContent: () => PublishContent;
  openEditor: () => void;
  dialog: ReactNode;
  copyAll: string | null;
  composerItem: { label: string; href: string } | null;
};

const VIDEO_FILE = /^[a-f0-9-]{36}\/[a-f0-9-]{36}\.mp4$/;

export function usePostComposer({ action: a, platform, handlers }: ActionBodyProps): PostComposer {
  const single = a.action_type === "video_post" || a.body?.step?.deliverable?.kind === "thread" || (a.edited_body?.text?.trim() && !a.edited_body.variants) || (Array.isArray(a.body?.thread) && a.body.thread.length);
  const parts = single ? null : deliverableParts(a);
  const [selected, setSelected] = useState(0);
  const sel = parts ? Math.min(selected, parts.length - 1) : 0;
  const seed = (i: number): Draft => (parts ? a.edited_body?.variants?.[i] ?? partPostContent(a, parts[i].content) : postContent(a));
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const current = drafts[sel] ?? seed(sel);
  const { text, thread } = current;
  const setText = (t: string) => setDrafts((all) => ({ ...all, [sel]: { ...(all[sel] ?? seed(sel)), text: t } }));
  const setThread = (th: string[] | null) => setDrafts((all) => ({ ...all, [sel]: { ...(all[sel] ?? seed(sel)), thread: th } }));
  const surface = useChannelSurface();
  const ownSave = handlers.onSaveText;
  const draft = usePostDraft(a, !!surface && !ownSave);
  const photo = usePostPhoto(a.edited_body);
  const save = ownSave ? () => ownSave(a, text) : draft.persisted ? async () => {
    const saved = await draft.save({
      text,
      thread,
      variant_index: parts && a.run_id !== null && !a.staged_draft_id ? sel : undefined,
      image_path: photo.value.image_path ?? (a.body?.media?.url && isPostImagePath(a.body.media.url) ? a.body.media.url : undefined),
      size: photo.value.size,
      headline: photo.value.headline,
    });
    if (saved) photo.change(saved);
  } : undefined;
  const { editing, saving, error: saveError, toggle, cancel } = usePostEditing(text, save);
  const defaultSize = platform?.postImageSizes?.[0].value ?? "feed";
  const [checkpoint, setCheckpoint] = useState(current);
  const openEditor = () => {
    if (editing) return;
    setCheckpoint(current);
    photo.begin(a.action_type === "image_post" && !!a.body?.media?.url, defaultSize);
    void toggle();
  };
  const cancelEditor = () => {
    if (saving || photo.busy) return;
    photo.cancel();
    setDrafts((all) => ({ ...all, [sel]: checkpoint }));
    cancel();
  };

  const name = platform?.name ?? "the platform";
  const limit = platform?.charLimit;
  const measure = (s: string) => (platform?.measure ? platform.measure(s) : s.length);
  const fills = useBlankFills([text, ...(thread ?? [])], null, a.channel_slug);
  const outText = fills.fill(text);
  const outThread = thread ? thread.map(fills.fill) : null;
  const texts = [outText, ...(outThread ?? [])];
  const overLimit = limit !== undefined && texts.some((p) => measure(p) > limit);
  const overLimitWords = `This is over ${name}'s ${limit}-character limit. Shorten it before posting.`;
  const threadReason = outThread?.some((part) => !part.trim())
    ? "Write something in every post of the thread before posting."
    : platform?.maxThreadPosts && texts.length > platform.maxThreadPosts
      ? `Zavi supports up to ${platform.maxThreadPosts} posts per ${name} thread. Remove the extra parts before posting.`
      : null;
  const editReason = !outText.trim() ? "Write something before posting." : threadReason ?? (overLimit ? overLimitWords : null);
  const textReason = editReason
    ?? (fills.left > 0 ? `Fill the ${fills.left} ${fills.left === 1 ? "blank" : "blanks"} above before posting.` : null)
    ?? (texts.some((p) => CONFIRM_RE.test(p)) ? "This draft has a fact marked [CONFIRM: …] that Zavi could not verify. Edit it to the real figure, or remove it, before posting." : null);
  const mediaReason = photo.value.rendered_image_path && thread?.length ? "Image posts cannot be published as a thread. Remove the extra parts before posting." : null;
  const redditManual = !!platform?.directPublishOnly && !handlers.onPublish && a.channel_slug === REDDIT_ORGANIC_SLUG;
  const [connectError, setConnectError] = useState<string | null>(null);
  const cardHandlers: ActionHandlers = redditManual
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
  const notConnected = !!platform?.directPublishOnly && !cardHandlers.onPublish;
  const blockedReason = mediaReason ?? (notConnected ? `Connect ${name} in Settings → Integrations to post.` : platform?.publishBlocked?.(a, outText) ?? textReason);

  const unchanged = JSON.stringify(current) === JSON.stringify(seed(sel));
  const display = parts || !unchanged ? [text, ...(thread ?? [])].join("\n\n") : null;
  const photoSource = (!editing && photo.value.rendered_image_path) || photo.value.image_path || a.body?.media?.url;
  const media = a.action_type === "image_post" && photoSource && (isPostImagePath(photoSource) || photo.value.image_path || photo.value.rendered_image_path || photo.value.headline || photo.value.size)
    ? <div className="w-ca-media shrink-0 overflow-hidden rounded-lg"><PostPhoto source={photoSource} headline={photo.value.headline} size={photo.value.size ?? defaultSize} rendered={!editing && !!photo.value.rendered_image_path} expandable /></div>
    : a.action_type === "video_post" && a.body?.media?.url && VIDEO_FILE.test(a.body.media.url)
      ? <PostVideo source={a.body.media.url} />
      : null;
  const shown = mediaOf(a);
  const below = a.action_type === "image_post" && !media && shown?.kind !== "image"
    ? <p data-testid="image-missing" className="text-ca-action text-ca-secondary">No image attached. Post sends the text only.</p>
    : a.action_type === "video_post" && !media && shown?.kind !== "video"
      ? <MediaMissing>No video yet. Film it from the script above, or ask Zavi to make one.</MediaMissing>
      : null;
  const wrap = (body: ReactNode) => parts
    ? <PartTabs labels={parts.map((p) => p.label)} selected={sel} onSelect={setSelected} copyText={texts.join("\n\n")} copyDisabled={fills.left > 0}>{body}</PartTabs>
    : body;
  const composerHref = platform?.composerUrl ? platform.composerUrl(outText, a) : null;
  const dialog = editing ? (
    <PostEditDialog
      heading={a.channel_slug === "blog" ? "Edit the article" : a.action_type === "reply" ? "Edit the reply" : a.action_type === "video_post" ? "Edit the video" : "Edit the post"}
      contentLabel={a.channel_slug === "blog" ? "Article" : a.action_type === "reply" ? "Reply" : a.action_type === "video_post" ? "Caption" : "Post text"}
      title={a.title}
      icon={getChannel(a.channel_slug) ? <ChannelMarkIcon slug={a.channel_slug} compact /> : undefined}
      text={text}
      thread={thread}
      limit={limit}
      measure={measure}
      saving={saving || photo.busy || draft.loading}
      error={saveError || draft.error}
      persisted={!!ownSave || draft.persisted}
      invalidReason={ownSave ? editReason : draft.persisted ? null : editReason}
      photoFields={a.action_type === "image_post" ? <PostPhotoFields value={photo.value} original={a.body?.media?.url} disabled={saving || photo.busy} sizes={platform?.postImageSizes} onChange={photo.change} onBusy={photo.setBusy} /> : undefined}
      onText={setText}
      onThread={setThread}
      onSave={() => void toggle()}
      onCancel={cancelEditor}
      onReset={() => {
        photo.reset();
        setDrafts((all) => ({ ...all, [sel]: parts ? partPostContent(a, parts[sel].content) : postContent({ ...a, edited_body: null }) }));
      }}
    />
  ) : null;
  return {
    handlers: cardHandlers,
    fills,
    outText,
    texts,
    display,
    media,
    below,
    wrap,
    blockedReason,
    statusLine: blockedReason && !notConnected ? blockedReason : null,
    error: connectError,
    publishLabel: redditManual ? "Connect Reddit to post" : null,
    directPublish: !!platform?.directPublishOnly,
    manualPost: redditManual || !!platform?.markDone,
    canCopy: !platform?.directPublishOnly || redditManual || !!platform.publishBlocked?.(a, outText),
    publishContent: () => ({
      text: outText,
      thread: outThread,
      ...(photo.value.rendered_image_path ? { image_path: photo.value.rendered_image_path } : {}),
      ...(() => {
        const revision = a.run_id === null || a.staged_draft_id ? draft.publishRevision ?? a.post_revision : undefined;
        return revision ? { post_revision: revision } : {};
      })(),
    }),
    openEditor,
    dialog,
    copyAll: parts
      ? copyAllParts(parts.map((p, i) => {
          const cur = drafts[i] ?? seed(i);
          return { label: p.label, content: fills.fill([cur.text, ...(cur.thread ?? [])].join("\n\n")) };
        }))
      : null,
    composerItem: handlers.onPublish && platform?.composerLabel && composerHref && !platform.directPublishOnly && !blockedReason ? { label: platform.composerLabel, href: composerHref } : null,
  };
}
