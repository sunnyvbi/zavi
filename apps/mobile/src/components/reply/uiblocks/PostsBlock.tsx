import { StyleSheet, Text, View } from "react-native";
import { socialLimit, xWeightedLength, type PostsBlock as PostsBlockModel } from "@zavi/shared";
import { ChannelLogo } from "../../channels/ChannelGlyph";
import { font, radius, space, type Colors } from "../../../theme/tokens";
import { useStyles } from "../../../theme/theme";
import { Card } from "../ui";

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function socialSlug(channel: string): string {
  if (channel.startsWith("linkedin")) return "linkedin_organic";
  if (channel.startsWith("instagram")) return "instagram_organic";
  if (channel.startsWith("reddit")) return "reddit_organic";
  if (channel.startsWith("x") || channel.startsWith("twitter")) return "x_organic";
  if (channel.startsWith("tiktok")) return "tiktok_organic";
  if (channel.startsWith("pinterest")) return "pinterest_organic";
  if (channel.startsWith("youtube")) return "youtube_organic";
  return channel;
}

function channelLabel(channel: string): string {
  const first = channel.split("_")[0] || channel;
  if (first === "x") return "X";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function formatScheduledAt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function linkHost(text: string, pinLink: string): string | null {
  const match = (pinLink || text).match(/https?:\/\/([^\s/]+)/);
  return match ? match[1].replace(/^www\./, "") : null;
}

export function PostsBlock({ block }: { block: PostsBlockModel }) {
  const styles = useStyles(makeStyles);

  return (
    <Card>
      <Text style={styles.title}>{block.title}</Text>
      <View style={styles.list}>
        {block.posts.map((post, index) => (
          <PostCard key={index} post={post} />
        ))}
      </View>
    </Card>
  );
}

function PostCard({ post }: { post: PostsBlockModel["posts"][number] }) {
  const styles = useStyles(makeStyles);
  const text = textOf(post.payload.text);
  const title = textOf(post.payload.title);
  const imagePath = textOf(post.payload.image_path);
  const videoPath = textOf(post.payload.video_path);
  const subreddit = textOf(post.payload.subreddit);
  const boardName = textOf(post.payload.board_name);
  const pinLink = textOf(post.payload.link);
  const thread = Array.isArray(post.payload.thread)
    ? post.payload.thread.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    : [];
  const when = formatScheduledAt(post.scheduled_at);
  const limit = socialLimit(post.channel);
  const cap = limit?.text ?? null;
  const isX = post.channel === "x" || post.channel.startsWith("x_") || post.channel.startsWith("twitter");
  const count = isX && cap !== null ? xWeightedLength(text, cap).length : text.length;
  const host = linkHost(text, pinLink);

  return (
    <View>
      {post.label ? <Text style={styles.postLabel}>{post.label}</Text> : null}
      <View style={styles.postCard}>
        <View style={styles.postHeader}>
          <ChannelLogo slug={socialSlug(post.channel)} size={24} />
          <Text style={styles.platform}>{channelLabel(post.channel)}</Text>
          {subreddit ? <Text style={styles.meta}>r/{subreddit}</Text> : null}
          {boardName ? <Text style={styles.meta}>board {boardName}</Text> : null}
        </View>
        <View style={styles.postBody}>
          {title ? <Text style={styles.postTitle}>{title}</Text> : null}
          {text ? <Text style={styles.postText}>{text}</Text> : null}
          {thread.length > 0 ? (
            <View style={styles.thread}>
              {thread.map((part, index) => (
                <Text key={index} style={styles.threadText}>
                  {index + 2}/{thread.length + 1} {part}
                </Text>
              ))}
            </View>
          ) : null}
          {imagePath ? <Text style={styles.media}>Image attached - {imagePath.split("/").pop()}</Text> : null}
          {videoPath ? <Text style={styles.media}>Video attached - {videoPath.split("/").pop()}</Text> : null}
          {pinLink ? <Text style={styles.media}>Links to {pinLink}</Text> : host ? <Text style={styles.media}>Links to {host}</Text> : null}
        </View>
        <View style={styles.footer}>
          <Text style={styles.meta}>{when ? `Publishes ${when}` : "Staged for your approval"}</Text>
          {cap !== null ? <Text style={styles.meta}>{count} / {cap}</Text> : null}
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  title: { fontSize: 16, lineHeight: 22, fontFamily: font.family.semi, color: colors.ink },
  list: { gap: space.sm },
  postLabel: {
    marginBottom: 4,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.family.medium,
    color: colors.muted,
    textTransform: "uppercase",
  },
  postCard: {
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.panel,
  },
  postHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  platform: { flex: 1, fontSize: 13, lineHeight: 18, fontFamily: font.family.semi, color: colors.ink },
  postBody: { gap: space.xs, padding: space.md },
  postTitle: { fontSize: 14, lineHeight: 18, fontFamily: font.family.semi, color: colors.ink },
  postText: { fontSize: 13, lineHeight: 18, fontFamily: font.family.regular, color: colors.ink },
  thread: { gap: 4, borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: space.sm },
  threadText: { fontSize: 13, lineHeight: 18, fontFamily: font.family.regular, color: colors.ink },
  media: { fontSize: 12, lineHeight: 16, fontFamily: font.family.regular, color: colors.muted },
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  meta: { fontSize: 12, lineHeight: 16, fontFamily: font.family.regular, color: colors.muted },
});
