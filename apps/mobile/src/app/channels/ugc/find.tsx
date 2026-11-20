import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { AppBottomSheet } from "../../../components/AppBottomSheet";
import { Icon } from "../../../components/Icon";
import { CreatorRow } from "../../../components/channels/CreatorRow";
import { FindBar } from "../../../components/channels/FindBar";
import { StateLine, UgcScreen } from "../../../components/channels/UgcParts";
import { NO_FILTERS, activeCount, matchesLocally, resultsParts, type CreatorSearchRow, type FindFilters } from "../../../features/channels/ugc";
import { useCreatorSearch } from "../../../features/channels/ugcHooks";
import { CHANNELS_ENABLED } from "../../../lib/flags";
import { font, radius, space, type Colors } from "../../../theme/tokens";
import { useStyles, useTheme } from "../../../theme/theme";

export default function FindCreatorsRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <FindCreators />;
}

function FindCreators() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { colors } = useTheme();
  const [filters, setFilters] = useState<FindFilters>(NO_FILTERS);
  const [draft, setDraft] = useState("");
  const [about, setAbout] = useState(false);
  useEffect(() => {
    if (draft === filters.keyword) return;
    const t = setTimeout(() => setFilters((f) => ({ ...f, keyword: draft })), 300);
    return () => clearTimeout(t);
  }, [draft, filters.keyword]);

  const q = useCreatorSearch(filters);
  const rows = useMemo(
    () => [...(q.data?.creators ?? []), ...(q.data?.invited ?? [])].filter((c) => matchesLocally(c, filters)),
    [q.data, filters],
  );
  const options = q.data?.filter_options ?? null;
  const labels = q.data?.filter_labels ?? null;
  const orders = q.data?.order_options ?? [];
  const notes = q.data?.results_notes;
  const orderLabel = orders.find((o) => o.value === filters.order)?.label ?? q.data?.order_label;

  function open(c: CreatorSearchRow) {
    router.push({ pathname: "/channels/ugc/creator/[id]", params: { id: c.human_member_id } });
  }

  const header = (
    <View style={styles.head}>
      <FindBar
        value={filters}
        onChange={setFilters}
        keywordDraft={draft}
        onKeywordDraft={setDraft}
        onSearch={() => setFilters((f) => ({ ...f, keyword: draft }))}
        options={options}
        labels={labels}
        orders={orders}
      />
      {q.data ? (
        <Pressable style={styles.resultsRow} onPress={() => setAbout(true)} accessibilityRole="button" accessibilityLabel={`${resultsParts(rows.length, orderLabel).count}. About these results`}>
          <Text style={styles.results} numberOfLines={1} accessibilityLiveRegion="polite">
            <Text style={styles.count}>{resultsParts(rows.length, orderLabel).count}</Text>
            {orderLabel ? ` · ${orderLabel}` : ""}
          </Text>
          <View style={styles.info}>
            <Icon name="alertCircle" size={14} color={colors.muted} />
            <Text style={styles.infoText}>Not ranked by Zavi</Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <UgcScreen title="Find creators">
      <FlatList
        data={rows}
        keyExtractor={(c) => c.human_member_id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <StateLine
            loading={q.isLoading}
            error={q.isError}
            onRetry={() => void q.refetch()}
            empty={activeCount(filters) > 0 ? "No creators match these filters." : "No creators here yet."}
          />
        }
        renderItem={({ item: c }) => (
          <View style={q.isPlaceholderData ? styles.stale : undefined}>
            <CreatorRow c={c} onOpen={() => open(c)} />
          </View>
        )}
      />
      <AppBottomSheet open={about} onClose={() => setAbout(false)} title="About these results">
        <View style={styles.aboutList}>
          {[notes?.summary, q.data?.neutrality_note, q.data?.self_reported_note ? `Follower numbers: ${q.data.self_reported_note}` : null, notes?.fee]
            .filter((n): n is string => !!n)
            .map((n) => (
              <Text key={n} style={styles.about}>
                {n}
              </Text>
            ))}
        </View>
      </AppBottomSheet>
    </UgcScreen>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20 },
    head: { gap: 4, paddingBottom: space.sm },
    stale: { opacity: 0.45 },
    resultsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, minHeight: 36, paddingTop: 2 },
    results: { flex: 1, fontFamily: font.family.regular, fontSize: 13, color: colors.muted },
    count: { fontFamily: font.family.semi, color: colors.ink },
    info: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.soft },
    infoText: { fontFamily: font.family.medium, fontSize: 12, color: colors.textSecondary },
    aboutList: { gap: space.md },
    about: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
  });
