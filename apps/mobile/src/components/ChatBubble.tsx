import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import { ChatImageThumb } from "./ChatImageThumb";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { MessageActions } from "./MessageActions";
import { RunArtifacts } from "./RunArtifacts";
import type { RunArtifact } from "../features/agents/runArtifacts";
import type { SentVideo } from "../features/agents/sentVideos";
import { VideoPoster } from "./VideoPoster";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import type { ChatAttachment, ChatMessage } from "../features/agents/types";
import { agentName, planReplyCards } from "../features/agents/replyCards";
import { PausedCard } from "./reply/PausedCard";
import { ReplyCards, type ReplyCardActions } from "./reply/ReplyCards";
import { SourcesFootnote } from "./reply/SourcesFootnote";
import { CHANNELS } from "@zavi/shared";
import { ChannelLogo } from "./channels/ChannelGlyph";
import { splitApprovalContext, splitChannelMention } from "../features/agents/composerTools";

const attachmentKind = (a: ChatAttachment) =>
  a.kind ?? (a.path.endsWith(".jpg") ? "image" : "doc");

export function ChatBubble({
  message,
  artifacts,
  onPreviewImage,
  sentVideo,
  onPreviewVideo,
  threadSlug,
  isLast = false,
  cardActions,
  onRequestCopy,
  footer,
}: {
  message: ChatMessage;
  threadSlug?: string;
  isLast?: boolean;
  cardActions?: ReplyCardActions;
  onPreviewImage?: (url: string, filename: string) => void;
  sentVideo?: SentVideo;
  onPreviewVideo?: (video: SentVideo) => void;
  artifacts?: RunArtifact[];
  onRequestCopy?: (body: string, position: { x: number; y: number }) => void;
  footer?: ReactNode;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const isUser = message.sender_role === "user";
  const isSystem = message.sender_role === "system";
  const images = (message.attachments ?? []).filter(
    (a) => attachmentKind(a) === "image",
  );
  const docs = (message.attachments ?? []).filter((a) => attachmentKind(a) === "doc");
  const body = sentVideo && message.body.trim() === "(video)" ? "" : message.body;

  if (isSystem) {
    return (
      <View style={styles.systemWrap}>
        <Text style={styles.systemText}>{message.body}</Text>
      </View>
    );
  }

  if (!isUser) {
    return (
      <AssistantReply
        message={message}
        artifacts={artifacts}
        threadSlug={threadSlug ?? "operator"}
        isLast={isLast}
        cardActions={cardActions ?? {}}
        footer={footer}
      />
    );
  }

  const mention = splitChannelMention(body, CHANNELS);
  const asked = splitApprovalContext(mention.body);

  function onLongPress(e: GestureResponderEvent) {
    if (!body) return;
    onRequestCopy?.(body, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY });
  }

  return (
    <View style={styles.userRow}>
      <Pressable
        style={styles.userBubble}
        onLongPress={onLongPress}
        accessibilityRole={body ? "button" : undefined}
        accessibilityLabel={body ? "Copy message" : undefined}
      >
        {images.length > 0 ? (
          <View style={[styles.thumbs, (!!body || !!sentVideo || docs.length > 0) && styles.thumbsSpaced]}>
            {images.map((a) => (
              <ChatImageThumb
                key={a.path}
                path={a.path}
                onPress={
                  onPreviewImage
                    ? (url) => onPreviewImage(url, a.path.split("/").pop() ?? "Image")
                    : undefined
                }
              />
            ))}
          </View>
        ) : null}
        {sentVideo ? (
          <View style={[styles.sentVideo, (!!body || docs.length > 0) && styles.thumbsSpaced]}>
            <VideoPoster
              name={sentVideo.name}
              compact
              onPress={onPreviewVideo ? () => onPreviewVideo(sentVideo) : undefined}
            />
          </View>
        ) : null}
        {docs.length > 0 ? (
          <View style={[styles.docs, !!body && styles.thumbsSpaced]}>
            {docs.map((a) => (
              <View key={a.path} style={styles.docPill}>
                <Icon name="file" size={14} color={colors.muted} />
                <Text style={styles.docExt}>
                  {a.path.includes(".") ? a.path.split(".").pop()!.toUpperCase() : "DOC"}
                </Text>
                <Text style={styles.docLabel}>attachment</Text>
              </View>
            ))}
          </View>
        ) : null}
        {asked.approval ? (
          <View style={[styles.sentChip, styles.approvalChip]} accessibilityLabel={`About the approval ${asked.approval.summary}`}>
            <Icon name="check" size={14} color={colors.amber} />
            <Text style={[styles.sentChipText, styles.approvalChipText]} numberOfLines={2}>
              {asked.approval.summary}
            </Text>
          </View>
        ) : null}
        {mention.channel ? (
          <View style={styles.mentionRow}>
            <View style={styles.sentChip} accessibilityLabel={`Asked of ${mention.channel.name}`}>
              <ChannelLogo slug={mention.channel.slug} size={16} />
              <Text style={styles.sentChipText}>{mention.channel.name}</Text>
            </View>
            {asked.body ? <Text style={[styles.userText, styles.mentionText]}>{asked.body}</Text> : null}
          </View>
        ) : asked.approval ? (
          asked.body ? <Text style={styles.userText}>{asked.body}</Text> : null
        ) : body ? (
          <Text style={styles.userText}>{body}</Text>
        ) : null}
      </Pressable>
    </View>
  );
}

function AssistantReply({
  message,
  artifacts,
  threadSlug,
  isLast,
  cardActions,
  footer,
}: {
  message: ChatMessage;
  artifacts?: RunArtifact[];
  threadSlug: string;
  isLast: boolean;
  cardActions: ReplyCardActions;
  footer?: ReactNode;
}) {
  const styles = useStyles(makeStyles);
  const plan = useMemo(
    () => planReplyCards(message, { isLast, threadSlug }),
    [message, isLast, threadSlug],
  );

  if (plan.paused) {
    return (
      <View style={styles.assistant}>
        <PausedCard model={plan.paused} fallbackName={agentName(threadSlug)} />
      </View>
    );
  }

  return (
    <View style={styles.assistant}>
      {plan.body ? <Markdown body={plan.body} /> : null}
      <ReplyCards cards={plan.cards} actions={cardActions} />
      {artifacts && artifacts.length > 0 ? <RunArtifacts artifacts={artifacts} /> : null}
      {plan.sources ? <SourcesFootnote sources={plan.sources} /> : null}
      <ReplyCards cards={plan.trailing} actions={cardActions} />
      <MessageActions body={message.body} runId={message.agent_run_id} />
      {footer}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  assistant: { width: "100%", marginTop: space.md, marginBottom: space.lg },
  userRow: { width: "100%", marginVertical: space.sm, flexDirection: "row", justifyContent: "flex-end" },
  userBubble: {
    maxWidth: "80%",
    paddingVertical: 10,
    paddingHorizontal: space.md,
    borderRadius: radius.lg + 3,
    backgroundColor: colors.bubbleUserBg,
  },
  thumbs: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  thumbsSpaced: { marginBottom: space.sm },
  docs: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  sentVideo: { width: 220 },
  docPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.veil,
  },
  docExt: { fontSize: font.size.xs, fontFamily: font.family.semi, color: colors.ink },
  docLabel: { fontSize: font.size.xs, color: colors.muted },
  sentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 24,
    paddingLeft: 4,
    paddingRight: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.mentionChipBg,
  },
  approvalChip: {
    alignSelf: "flex-start",
    paddingLeft: 8,
    paddingVertical: 3,
    marginBottom: space.sm,
    borderWidth: 1,
    borderColor: colors.approvalBorder,
    backgroundColor: colors.approvalBg,
  },
  approvalChipText: { flexShrink: 1, fontSize: 14 },
  mentionRow: { flexDirection: "row", alignItems: "flex-start", gap: 7 },
  mentionText: { flexShrink: 1 },
  sentChipText: {
    fontSize: 15,
    lineHeight: 18,
    fontFamily: font.family.regular,
    textAlignVertical: "center",
    includeFontPadding: false,
    color: colors.ink,
  },
  userText: {
    fontSize: 16,
    lineHeight: 24,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    color: colors.bubbleUserText,
  },
  systemWrap: { alignItems: "center", marginVertical: space.sm },
  systemText: {
    maxWidth: "80%",
    textAlign: "center",
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.family.regular,
    includeFontPadding: false,
    color: colors.muted,
    fontStyle: "italic",
  },
});
