"use client";

import { splitFileRefs } from "@/lib/workspace/fileRefs";
import { FileRefChips } from "./FileRefChips";
import { useContext, useState } from "react";
import { SideChatTypeContext } from "./sideChatType";
import { CitationChip } from "@/components/agents/CitationChip";
import type { Citation } from "@/lib/citations";
import Link from "next/link";
import { CHANNELS, type Channel } from "@zavi/shared";
import { AgentMentionIcon } from "./composer/AgentMentionIcon";
import {
  splitChannelMention,
  splitHandoffHeader,
} from "@/lib/workspace/channelMention";
import { agentDisplayName } from "@/lib/agentRegistry";
import { fullTimestamp } from "@/lib/workspace/dayLabels";
import { AuthorAvatar } from "./AuthorAvatar";
import { SourceIcon } from "./layout/SourceIcon";
import { bubbleRenderShape, type BubbleRenderShape } from "./chatBubbleShape";
import { ChatImageThumb } from "./ChatImageThumb";
import { CopyMessageButton } from "./CopyMessageButton";
import { FeedbackInline } from "@/components/feedback/FeedbackInline";
import { TeamNoteFlag } from "./chat/TeamNoteFlag";
import type { OfferedTeamNote } from "@/lib/workspace/teamNote";
import { Markdown } from "./Markdown";
import { TrendPill } from "./receipts/Receipts";
import { NextActionsCard, parseNextActions } from "./receipts/NextActions";
import { parseTrendLead, type FigureReceiptMeta } from "./receipts/receiptData";
import { cachedFigureMarks } from "./receipts/figureMarks";
import { ThinkingDots } from "./RunActivityFeed";
import { replyCopyMarkdown } from "@/lib/workspace/replyCopy";

export { bubbleRenderShape };
export type { BubbleRenderShape };

export type ChatBubbleProps = {
  role: "user" | "assistant" | "system";
  text: string;
  fullReplyMarkdown?: string | null;
  agentSlug?: string;
  fromAgentSlug?: string;
  viaEmail?: boolean;
  trigger?: string;
  createdAt?: string;
  tools?: string[];
  citations?: Citation[];
  attachments?: { path: string; kind?: "image" | "doc" }[] | null;
  brainProvenance?: { crossThreadHits: string[] } | null;
  onEdit?: () => void;
  runIds?: ReadonlyArray<string>;
  isStreaming?: boolean;
  onGoDeeper?: () => void;
  goDeeperBusy?: boolean;
  hideFooterActions?: boolean;
  copyMarkdown?: string | null;
  feedbackRunId?: string;
  teamNoteFlag?: OfferedTeamNote | null;
  variant?: "bubble" | "flat";
  figureReceipts?: FigureReceiptMeta[];
  unverifiedFigures?: string[];
  onAskAction?: (title: string) => Promise<boolean>;
};

function AttachmentImages({
  paths,
  width,
}: {
  paths: string[];
  width: string;
}) {
  if (paths.length === 1) {
    return (
      <div className={width}>
        <ChatImageThumb
          path={paths[0]}
          className="aspect-square w-full rounded-[20px]"
        />
      </div>
    );
  }
  return (
    <div className={`grid grid-cols-2 gap-1 ${width}`}>
      {paths.map((path) => (
        <ChatImageThumb
          key={path}
          path={path}
          className="aspect-square w-full rounded-[20px]"
        />
      ))}
    </div>
  );
}

function AttachmentPill({ path }: { path: string }) {
  const name = path.split("/").pop() ?? path;
  const raw = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toUpperCase()
    : "DOC";
  const ext = raw === "TXT" ? "TEXT" : raw;
  return (
    <div className="flex items-center gap-2 rounded-md border border-ink/10 bg-white/70 px-2 py-1 text-[12px] text-ink">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path
          d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"
          strokeLinejoin="round"
        />
        <path d="M14 3v5h5" strokeLinejoin="round" />
      </svg>
      <span className="font-semibold">{ext}</span>
      <span className="max-w-[180px] truncate opacity-70">attachment</span>
    </div>
  );
}

function shortTime(iso: string | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function HandoffBadge({
  channel,
  agentSlug,
}: {
  channel: Channel | null;
  agentSlug: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full bg-ink/[0.06] py-[5px] pr-3 text-[13px] font-medium leading-[20px] text-ink [&>span]:ring-0 ${
        channel ? "pl-[5px]" : "pl-3"
      }`}
    >
      {channel && <SourceIcon channel={channel} size="sm" />}
      {channel?.name ?? agentDisplayName(agentSlug)}
      <span className="text-inkMuted">· handed off</span>
    </span>
  );
}

const GROWTH_PAGE_HREF = "/workspace?tab=growth-strategy";

export function HandoffSigner({ slug, viaEmail }: { slug: string; viaEmail?: boolean }) {
  const channel = CHANNELS.find((c) => c.executor === slug) as Channel | undefined;
  const cgo = slug === "cgo";
  const name = cgo ? "Your CGO" : (channel?.name ?? agentDisplayName(slug));
  return (
    <div className="mb-1.5 flex items-center gap-2 text-[13px] [&>span]:ring-0">
      {channel ? <SourceIcon channel={channel} size="sm" /> : <AgentMentionIcon slug={slug} />}
      <span className="font-medium text-ink">{name}</span>
      {viaEmail && <span className="text-[11px] text-inkMuted">via email</span>}
      {cgo && (
        <Link
          href={GROWTH_PAGE_HREF}
          className="ml-auto text-[12px] font-medium text-inkMuted underline-offset-2 hover:text-ink hover:underline"
        >
          Open Growth page
        </Link>
      )}
    </div>
  );
}

function SentChannelChip({ channel }: { channel: Channel }) {
  return (
    <span
      className="mr-[7px] inline-flex translate-y-[-1px] items-center gap-[5px] rounded-full bg-ink/[0.07] py-[4px] pl-[4px] pr-[10px] align-middle text-[16px] font-normal leading-[20px] text-ink [&>span]:ring-0"
      title={`Asked of ${channel.name}`}
    >
      <SourceIcon channel={channel} size="sm" />
      {channel.name}
    </span>
  );
}

function AnswerMarkdown(props: Omit<React.ComponentProps<typeof Markdown>, "breaks" | "reading" | "compact">) {
  const sideChat = useContext(SideChatTypeContext);
  return <Markdown {...props} breaks reading={!sideChat} compact={sideChat} />;
}

export function ChatBubble({
  role,
  text,
  fullReplyMarkdown,
  agentSlug,
  fromAgentSlug,
  viaEmail,
  trigger,
  createdAt,
  citations,
  attachments,
  brainProvenance,
  onEdit,
  isStreaming,
  onGoDeeper,
  goDeeperBusy,
  hideFooterActions,
  copyMarkdown,
  feedbackRunId,
  teamNoteFlag,
  variant = "bubble",
  figureReceipts,
  unverifiedFigures,
  onAskAction,
}: ChatBubbleProps) {
  const figureMarks = role === "assistant" && !isStreaming ? cachedFigureMarks(figureReceipts, unverifiedFigures) : null;
  if (role === "user") {
    const allAttachments = attachments ?? [];
    const attachmentKind = (a: { path: string; kind?: "image" | "doc" }) =>
      a.kind ?? (a.path.endsWith(".jpg") ? "image" : "doc");
    const imgs = allAttachments.filter((a) => attachmentKind(a) === "image");
    const docs = allAttachments.filter((a) => attachmentKind(a) === "doc");
    const hasAttachments = allAttachments.length > 0;
    const { channel: mentionChannel, body: mentionBody } =
      splitChannelMention(text);
    const { body: displayText, files: fileRefs } = splitFileRefs(mentionBody);
    const oneLine =
      !mentionChannel &&
      displayText.length > 0 &&
      displayText.length <= 36 &&
      !displayText.includes("\n");
    const showEdit = !!onEdit && text.trim().length > 0;
    const copyText = splitFileRefs(text).body;
    const showCopy = copyText.trim().length > 0;

    if (variant === "flat") {
      return (
        <div className="flex w-full min-w-0 gap-3">
          {}
          <AuthorAvatar label="You" size="ml" />
          <div className="min-w-0 flex-1">
            {}
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-[14px] font-semibold leading-[22.5px] tracking-[-0.2344px] text-ink">
                You
              </span>
              {shortTime(createdAt) && (
                <span
                  title={fullTimestamp(createdAt)}
                  className="text-[12px] font-normal leading-[18px] tracking-normal text-inkMuted"
                >
                  {shortTime(createdAt)}
                </span>
              )}
            </div>
            {imgs.length > 0 && (
              <div className="mb-2">
                <AttachmentImages
                  paths={imgs.map((a) => a.path)}
                  width="w-[260px] max-w-full"
                />
              </div>
            )}
            {docs.length > 0 && (
              <div className="mb-2 flex flex-col items-start gap-1">
                {docs.map((a) => (
                  <AttachmentPill key={a.path} path={a.path} />
                ))}
              </div>
            )}
            <FileRefChips files={fileRefs} variant="thumb" className="mb-2" />
            {}
            {}
            {(mentionChannel || displayText) && (
              <div className="whitespace-pre-wrap break-words text-[14px] leading-[24.75px] tracking-[-0.2344px] text-ink">
                {mentionChannel && <SentChannelChip channel={mentionChannel} />}
                {displayText}
              </div>
            )}
            {(showEdit || showCopy) && (
              <div className="mt-1 flex items-center gap-0.5">
                {showCopy && <CopyMessageButton text={copyText} />}
                {showEdit && <EditButton onEdit={onEdit!} />}
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="group/u flex flex-col items-end">
        {imgs.length > 0 && (
          <AttachmentImages
            paths={imgs.map((a) => a.path)}
            width="w-[240px] max-w-[82%]"
          />
        )}
        {docs.length > 0 && (
          <div className={`flex flex-col items-end gap-1 ${imgs.length > 0 ? "mt-1.5" : ""}`}>
            {docs.map((a) => (
              <AttachmentPill key={a.path} path={a.path} />
            ))}
          </div>
        )}
        <FileRefChips
          files={fileRefs}
          align="end"
          variant="thumb"
          className={`max-w-[82%] ${hasAttachments ? "mt-1.5" : ""}`}
        />
        {}
        {(mentionChannel || displayText) && (
          <div
            className={`max-w-[82%] whitespace-pre-wrap break-words bg-[#f0f0f0] py-[9px] pr-[16px] text-[16px] font-normal leading-[25px] text-[#0e0f11] ${
              mentionChannel ? "pl-[9px]" : "pl-[16px]"
            } ${oneLine ? "rounded-full" : "rounded-[20px]"} ${
              hasAttachments || fileRefs.length > 0 ? "mt-1.5" : ""
            }`}
          >
            {mentionChannel && <SentChannelChip channel={mentionChannel} />}
            {displayText}
          </div>
        )}
        {}
        {(showEdit || showCopy) && (
          <div className="mt-1 flex items-center justify-end gap-0.5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/u:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
            {showCopy && <CopyMessageButton text={copyText} />}
            {showEdit && <EditButton onEdit={onEdit!} />}
          </div>
        )}
      </div>
    );
  }

  if (role === "system") {
    return (
      <div className="flex justify-center">
        <div className="max-w-[80%] text-center text-[13px] italic leading-[1.5] text-inkMuted">
          {text}
        </div>
      </div>
    );
  }

  const handoff = splitHandoffHeader(text);
  const body = handoff.body;

  const hasOverflow =
    typeof fullReplyMarkdown === "string" &&
    fullReplyMarkdown.trim().length > 0 &&
    fullReplyMarkdown.trim() !== body.trim();

  const tag = trigger && trigger !== "chat" ? trigger : null;
  const fullIsWhole = hasOverflow && (fullReplyMarkdown as string).startsWith(body.trim());
  const whole = fullIsWhole ? (fullReplyMarkdown as string) : body;
  const trend = parseTrendLead(whole);
  const primary = trend ? trend.body : whole;
  const nextActions = trend && !isStreaming && !(hasOverflow && !fullIsWhole) ? parseNextActions(primary) : null;

  const flat = variant === "flat";
  const copyMd = copyMarkdown === undefined ? replyCopyMarkdown(text, fullReplyMarkdown) : copyMarkdown;
  const footerActions = (
    <>
      {copyMd && <CopyMessageButton markdown={copyMd} />}
      {}
      {onGoDeeper && <GoDeeperButton onGoDeeper={onGoDeeper} busy={goDeeperBusy} />}
      {teamNoteFlag !== undefined && <TeamNoteFlag note={teamNoteFlag} />}
    </>
  );
  return (
    <div className="flex w-full min-w-0 justify-start">
      <div
        className={
          flat
            ? "min-w-0 flex-1 text-[14px] leading-[1.65] text-ink"
            : "w-full min-w-0 max-w-[100%] text-[14px] leading-[1.65] text-ink"
        }
      >
        {}
        {tag && (
          <div
            className={
              flat
                ? "mb-1 flex items-baseline gap-2"
                : "mb-1.5 flex items-center gap-2 text-inkMuted"
            }
          >
            <span
              className={
                flat
                  ? "text-[12px] text-inkMuted"
                  : "text-[12px] text-inkMuted"
              }
            >
              {tag}
            </span>
          </div>
        )}
        {}
        {brainProvenance && brainProvenance.crossThreadHits.length > 0 && (
          <div className="mb-2 inline-flex items-center gap-2 rounded-[7px] border border-ink/[0.12] bg-cream px-2 py-1 text-[12px] text-inkMuted">
            <span aria-hidden>💭</span>
            <span>Answering from your workspace Brain across threads</span>
          </div>
        )}
        {}
        {fromAgentSlug ? (
          <HandoffSigner slug={fromAgentSlug} viaEmail={viaEmail} />
        ) : handoff.agentSlug && (
          <div className="mb-1.5">
            <HandoffBadge
              channel={handoff.channel}
              agentSlug={handoff.agentSlug}
            />
          </div>
        )}
        {}
        {trend && (
          <div className="mb-2">
            <TrendPill tone={trend.tone}>{trend.pill}</TrendPill>
          </div>
        )}
        {isStreaming ? (
          <AnswerMarkdown source={primary} />
        ) : hasOverflow && !fullIsWhole ? (
          <>
            <AnswerMarkdown source={primary} figures={figureMarks} />
            <div className="mt-3 border-t border-rule pt-3">
              <AnswerMarkdown source={fullReplyMarkdown as string} figures={figureMarks} />
            </div>
          </>
        ) : nextActions ? (
          <>
            {nextActions.before && <AnswerMarkdown source={nextActions.before} figures={figureMarks} />}
            <NextActionsCard actions={nextActions.actions} onAsk={onAskAction} />
            {nextActions.after && (
              <div className="mt-3">
                <AnswerMarkdown source={nextActions.after} figures={figureMarks} />
              </div>
            )}
          </>
        ) : (
          <AnswerMarkdown source={primary} figures={figureMarks} />
        )}
        {}
        {isStreaming && (
          <>
            <div
              aria-hidden
              className="mt-2 flex items-center gap-2 text-[13px] text-ink/60"
            >
              <ThinkingDots />
              <span>working…</span>
            </div>
            <div role="status" className="sr-only">
              Assistant is still responding…
            </div>
          </>
        )}
        {}
        {citations && citations.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {citations.map((c, i) => (
              <CitationChip key={`${c.kind}-${c.ref}-${i}`} citation={c} />
            ))}
          </div>
        )}
        {}
        {!isStreaming && !hideFooterActions && text.trim().length > 0 && (
          feedbackRunId ? (
            <div className="mt-1.5">
              <FeedbackInline
                targetType="agent_run"
                targetId={feedbackRunId}
                agentSlug={agentSlug ?? "unknown"}
                noteOnBad
                trailing={footerActions}
              />
            </div>
          ) : (
            <div className="mt-1.5 flex items-center gap-0.5">{footerActions}</div>
          )
        )}
        {}
      </div>
    </div>
  );
}

function GoDeeperButton({
  onGoDeeper,
  busy,
}: {
  onGoDeeper: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onGoDeeper}
      disabled={busy}
      aria-label="Went light: go deeper with a stronger model"
      title="Re-run this deeper"
      className="inline-flex items-center gap-1 rounded-cta px-2 py-1 text-[13px] text-inkMuted transition-colors hover:bg-ink/5 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="text-inkMuted/80">went light ·</span>
      <span className="font-medium">
        {busy ? "Going deeper…" : "Go deeper"}
      </span>
      {!busy && (
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 17 17 7" />
          <path d="M8 7h9v9" />
        </svg>
      )}
    </button>
  );
}

function EditButton({ onEdit }: { onEdit: () => void }) {
  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label="Edit message"
      title="Edit"
      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-ink/5 hover:text-ink"
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="h-[15px] w-[15px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
      </svg>
    </button>
  );
}
