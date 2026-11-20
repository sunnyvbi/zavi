import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { StateLine, UgcScreen, openOnWeb } from "../../../components/channels/UgcParts";
import { relativeTime } from "../../../features/channels/channelPage";
import { noticeTarget, type Notice } from "../../../features/channels/ugc";
import { useMarkNoticesRead, useNotices } from "../../../features/channels/ugcHooks";
import { CHANNELS_ENABLED } from "../../../lib/flags";
import { font, space, type Colors } from "../../../theme/tokens";
import { useStyles } from "../../../theme/theme";

export default function NoticesRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <Notices />;
}

function Notices() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const q = useNotices();
  const mark = useMarkNoticesRead();
  const items = q.data?.notifications ?? [];

  function open(n: Notice) {
    if (!n.read_at) mark.mutate([n.id]);
    const target = noticeTarget(n.link_path);
    if (target) router.push({ pathname: target.pathname as never, params: target.params });
    else openOnWeb();
  }

  return (
    <UgcScreen
      title="Updates"
      right={
        (q.data?.unread ?? 0) > 0 ? (
          <Pressable onPress={() => mark.mutate("all")} hitSlop={8} accessibilityRole="button" accessibilityLabel="Mark all read">
            <Text style={styles.markAll}>Read all</Text>
          </Pressable>
        ) : null
      }
    >
      <FlatList
        data={items}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<StateLine loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()} empty="No updates yet." />}
        renderItem={({ item: n }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            onPress={() => open(n)}
            accessibilityRole="button"
            accessibilityLabel={`${n.title}${n.read_at ? "" : ", unread"}`}
          >
            <View style={[styles.dot, !!n.read_at && styles.dotRead]} />
            <View style={styles.text}>
              <Text style={[styles.title, !n.read_at && styles.titleNew]}>{n.title}</Text>
              {n.body ? (
                <Text style={styles.body} numberOfLines={2}>
                  {n.body}
                </Text>
              ) : null}
              <Text style={styles.at}>{relativeTime(n.created_at)}</Text>
            </View>
          </Pressable>
        )}
      />
    </UgcScreen>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20 },
    markAll: { fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
    row: { flexDirection: "row", gap: space.md, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.line },
    pressed: { opacity: 0.7 },
    dot: { width: 8, height: 8, marginTop: 6, borderRadius: 4, backgroundColor: colors.status.greenDot },
    dotRead: { backgroundColor: "transparent" },
    text: { flex: 1, gap: 2 },
    title: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.ink },
    titleNew: { fontFamily: font.family.semi },
    body: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    at: { fontFamily: font.family.regular, fontSize: 11, color: colors.muted },
  });
