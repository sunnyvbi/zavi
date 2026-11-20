import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Icon } from "../components/Icon";
import { KeyboardAvoider } from "../components/KeyboardAvoider";
import { Screen } from "../components/Screen";
import { BackHeader } from "../components/settings/SettingsUI";
import { hintText, ZaviBorder } from "../components/ZaviTextField";
import { useChatThreads, type ChatThreadRow } from "../features/agents/hooks";
import { searchThreads } from "../features/agents/threadSearch";
import { font, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

export default function Search() {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data: threads, isLoading } = useChatThreads();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);

  const rows = useMemo(() => searchThreads(threads, query), [threads, query]);
  const searching = query.trim().length > 0;

  function openThread(row: ChatThreadRow) {
    router.dismissTo({ pathname: "/chat", params: { thread_id: row.id, slug: row.slug, channel: row.channel_slug ?? undefined, channel_action: row.channel_action_id ?? undefined } });
  }

  function renderThread({ item }: { item: ChatThreadRow }) {
    return <ThreadRow row={item} onPress={() => openThread(item)} />;
  }

  return (
    <Screen>
      <BackHeader title="Search" />
      <KeyboardAvoider style={styles.flex}>
        <View style={styles.searchWrap}>
          <ZaviBorder selected={focused} radius={10}>
            <View style={styles.searchBox}>
              <Icon name="search" size={18} color={colors.muted} strokeWidth={2} />
              <TextInput
                keyboardAppearance={keyboardAppearance}
                style={styles.searchInput}
                placeholder={hintText("Search chats")}
                placeholderTextColor={colors.muted}
                cursorColor={colors.ink}
                selectionColor={textSelectionColor}
                selectionHandleColor={colors.ink}
                value={query}
                onChangeText={setQuery}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                autoFocus
              />
              {query ? (
                <Pressable
                  style={({ pressed }) => [styles.searchClear, pressed && styles.iconPressed]}
                  onPress={() => setQuery("")}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Clear search"
                >
                  <Icon name="close" size={12} color={colors.ink} strokeWidth={2.2} />
                </Pressable>
              ) : null}
            </View>
          </ZaviBorder>
        </View>

        <FlatList
          data={rows}
          keyExtractor={(row) => row.id}
          renderItem={renderThread}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={<Text style={styles.section}>Recent</Text>}
          ListEmptyComponent={
            <View style={styles.state}>
              {isLoading ? (
                <ActivityIndicator size="small" color={colors.muted} />
              ) : (
                <Text style={styles.stateText}>{searching ? "No chats match." : "No chats yet."}</Text>
              )}
            </View>
          }
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 20 }]}
        />
      </KeyboardAvoider>
    </Screen>
  );
}

function ThreadRow({ row, onPress }: { row: ChatThreadRow; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  const agent = row.topic;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.title || "Untitled thread"}${agent ? `, ${agent}` : ""}`}
    >
      <Text style={styles.rowTitle} numberOfLines={1}>
        {row.title || "Untitled thread"}
      </Text>
      {agent ? (
        <Text style={styles.rowAgent} numberOfLines={1}>
          {agent}
        </Text>
      ) : null}
      {row.pending ? <View style={styles.pendingDot} /> : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  flex: { flex: 1 },
  searchWrap: {
    paddingHorizontal: space.lg,
    paddingTop: 20,
    paddingBottom: 20,
  },
  searchBox: {
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: 10,
  },
  searchInput: {
    flex: 1,
    height: "100%",
    paddingVertical: 0,
    fontFamily: font.family.medium,
    fontSize: 15,
    includeFontPadding: false,
    textAlignVertical: "center",
    color: colors.ink,
  },
  searchClear: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  iconPressed: { opacity: 0.7 },
  list: { flexGrow: 1 },
  section: {
    paddingHorizontal: space.lg,
    paddingTop: 20,
    paddingBottom: 20,
    fontFamily: font.family.semi,
    fontSize: 16,
    lineHeight: 22,
    includeFontPadding: false,
    color: colors.ink,
  },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
  },
  stateText: {
    fontFamily: font.family.regular,
    fontSize: 14,
    lineHeight: 20,
    includeFontPadding: false,
    textAlign: "center",
    color: colors.muted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg,
  },
  rowPressed: { backgroundColor: colors.soft },
  rowTitle: {
    flex: 1,
    fontFamily: font.family.regular,
    fontSize: 14,
    lineHeight: 20,
    includeFontPadding: false,
    color: colors.textSecondary,
  },
  rowAgent: {
    flexShrink: 0,
    maxWidth: 110,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    includeFontPadding: false,
    color: colors.muted,
  },
  pendingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.amber },
});
