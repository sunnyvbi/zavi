import { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { Chip, ReadOnlyNote, StateLine, UgcButton, UgcScreen } from "../../../components/channels/UgcParts";
import { BRIEFS_EMPTY_BODY, BRIEFS_EMPTY_TITLE, NEW_BRIEF_ROUTE, briefListRow } from "../../../features/channels/ugcHire";
import { useBriefs, useCanWrite } from "../../../features/channels/ugcHooks";
import { CHANNELS_ENABLED } from "../../../lib/flags";
import { font, space, type Colors } from "../../../theme/tokens";
import { useStyles, useTheme } from "../../../theme/theme";

export default function BriefsRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <Briefs />;
}

function Briefs() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const canWrite = useCanWrite();
  const q = useBriefs();
  const [pulling, setPulling] = useState(false);
  const onPull = () => {
    setPulling(true);
    void q.refetch().finally(() => setPulling(false));
  };
  const now = Date.now();
  const rows = (q.data ?? []).map((b) => briefListRow(b, now));

  return (
    <UgcScreen title="Briefs">
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={colors.muted} colors={[colors.ink]} progressBackgroundColor={colors.surfaceRaised} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            {canWrite ? (
              <UgcButton label="New brief" onPress={() => router.push({ pathname: NEW_BRIEF_ROUTE.pathname as never, params: NEW_BRIEF_ROUTE.params })} />
            ) : (
              <ReadOnlyNote />
            )}
          </View>
        }
        ListEmptyComponent={
          !q.data ? (
            <StateLine loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{BRIEFS_EMPTY_TITLE}</Text>
              <Text style={styles.emptyBody}>{BRIEFS_EMPTY_BODY}</Text>
            </View>
          )
        }
        renderItem={({ item: r }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            onPress={() => router.push({ pathname: r.to.pathname as never, params: r.to.params })}
            accessibilityRole="button"
            accessibilityLabel={`${r.title}, ${r.chip.label}. ${r.line}`}
          >
            <View style={styles.rowText}>
              <Text style={styles.title} numberOfLines={2}>
                {r.title}
              </Text>
              {r.sub ? <Text style={styles.sub}>{r.sub}</Text> : null}
              <Text style={styles.line}>{r.line}</Text>
            </View>
            <Chip label={r.chip.label} tone={r.chip.tone} />
          </Pressable>
        )}
      />
    </UgcScreen>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20 },
    header: { paddingBottom: space.sm },
    row: { flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.line },
    pressed: { opacity: 0.7 },
    rowText: { flex: 1, minWidth: 0, gap: 3 },
    title: { fontFamily: font.family.semi, fontSize: 15, lineHeight: 20, color: colors.ink },
    sub: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    line: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    empty: { gap: space.sm, paddingTop: 40, paddingHorizontal: space.sm },
    emptyTitle: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink, textAlign: "center" },
    emptyBody: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.muted, textAlign: "center" },
  });
