import { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { StateLine, UgcButton, UgcScreen } from "../../../components/channels/UgcParts";
import { ToneChip } from "../../../components/channels/UgcParts";
import { jobListRow, type JobListRow } from "../../../features/channels/ugcInbox";
import { useJobs } from "../../../features/channels/ugcHooks";
import { CHANNELS_ENABLED } from "../../../lib/flags";
import { font, radius, space, type Colors } from "../../../theme/tokens";
import { useStyles, useTheme } from "../../../theme/theme";

const LEDE =
  "Every creator you have booked or hired. Zavi holds your payment until you approve the work, and the same deadline you see here is the one the creator sees.";

export default function JobsRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <Jobs />;
}

function Jobs() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const jobs = useJobs();
  const [pulling, setPulling] = useState(false);
  const onPull = () => {
    setPulling(true);
    void jobs.refetch().finally(() => setPulling(false));
  };
  const rows = (jobs.data ?? []).map(jobListRow);

  return (
    <UgcScreen title="Jobs">
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={onPull}
            tintColor={colors.muted}
            colors={[colors.ink]}
            progressBackgroundColor={colors.surfaceRaised}
          />
        }
        ListHeaderComponent={<Text style={styles.lede}>{LEDE}</Text>}
        ListEmptyComponent={
          !jobs.data ? (
            <StateLine loading={jobs.isLoading} error={jobs.isError} onRetry={() => void jobs.refetch()} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No jobs yet</Text>
              <Text style={styles.emptyBody}>
                A job starts when you book a creator's package or hire someone who applied to one of your briefs. Your card is held, not charged, until the creator accepts.
              </Text>
              <UgcButton label="Open your briefs" onPress={() => router.push("/channels/ugc/briefs")} />
            </View>
          )
        }
        renderItem={({ item }) => <JobCard row={item} onOpen={() => router.push({ pathname: "/channels/ugc/job/[id]", params: { id: item.id } })} />}
      />
    </UgcScreen>
  );
}

function JobCard({ row: r, onOpen }: { row: JobListRow; onOpen: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${r.title}, ${r.status}, ${r.total}`}
    >
      <View style={styles.top}>
        <View style={styles.left}>
          <Text style={styles.title}>{r.title}</Text>
          <Text style={styles.sub}>{r.sub}</Text>
        </View>
        <View style={styles.right}>
          <Text style={styles.total}>{r.total}</Text>
          <ToneChip label={r.status} tone={r.tone} />
        </View>
      </View>
      {r.moneyLine ? <Text style={styles.sub}>{r.moneyLine}</Text> : null}
      {r.deadline ? <Text style={styles.deadline}>{r.deadline}</Text> : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20, gap: space.md },
    lede: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    card: { gap: 6, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    pressed: { opacity: 0.7 },
    top: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.md },
    left: { flex: 1, minWidth: 0, gap: 4 },
    right: { flexShrink: 0, maxWidth: "45%", alignItems: "flex-end", gap: 6 },
    title: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
    total: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 22, color: colors.ink },
    sub: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    deadline: { marginTop: 2, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    empty: { alignItems: "center", gap: space.sm, paddingTop: space.lg },
    emptyTitle: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink, textAlign: "center" },
    emptyBody: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary, textAlign: "center" },
  });
