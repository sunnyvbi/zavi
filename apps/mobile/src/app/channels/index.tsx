import { useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect, useRouter } from "expo-router";
import { showDialog } from "../../components/DialogHost";
import { BackIcon, Icon } from "../../components/Icon";
import { UnderlinedText } from "../../components/UnderlinedText";
import { ChannelRow } from "../../components/channels/ChannelRow";
import { ChannelListSkeleton, ChannelsEmptyState, ChannelsErrorState, StatusSpinner } from "../../components/channels/ChannelStates";
import { groupRows, listSummary, planName, waitingLabel, type ListRow } from "../../features/channels/channelList";
import { useChannelList } from "../../features/channels/hooks";
import { useCanManage } from "../../features/settings/api";
import { isBillingEnabled, useSignupAvailability } from "../../auth/signup";
import { CHANNELS_ENABLED } from "../../lib/flags";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export default function ChannelsRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <Channels />;
}

function Channels() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const canManage = useCanManage();
  const billingEnabled = isBillingEnabled(useSignupAvailability().data);
  const { rowsFor, tenantTier, isLoading, isError, refetch } = useChannelList();
  const [pulling, setPulling] = useState(false);
  function pull() {
    setPulling(true);
    void Promise.resolve(refetch()).finally(() => setPulling(false));
  }
  const order = useRef<string[] | null>(null);
  const rows = rowsFor(order.current ?? undefined);
  if (!order.current && rows.length > 0) order.current = rows.map((r) => r.slug);

  function goBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/chat");
  }

  function open(row: ListRow) {
    if (row.comingSoon) return;
    const plan = planName(row.planTier);
    if (plan) {
      if (canManage && billingEnabled) router.push("/settings/billing");
      else if (billingEnabled) void showDialog({ title: `Needs ${plan} plan`, message: `Ask an owner or admin to upgrade to ${plan} to open ${row.name}.` });
      else void showDialog({ title: `Needs ${plan} plan`, message: `${row.name} isn't included in your plan.` });
      return;
    }
    router.push({ pathname: "/channels/actions/[slug]", params: { slug: row.slug } });
  }

  const summary = listSummary(rows);
  const page = groupRows(rows);
  const showHeads = page.sections.length > 1 || page.plans.length > 0;
  const plan = planName(tenantTier);
  const lockedWorking = rows.filter((r) => r.planTier && r.workState === "running").length;
  const lockedPlan = page.sections.length === 0 && page.plans.length > 0 ? planName(page.plans[0].tier) : null;

  function getPlan() {
    if (canManage) router.push("/settings/billing");
    else void showDialog({ title: `Needs ${lockedPlan} plan`, message: `Ask an owner or admin to upgrade to ${lockedPlan} to use channels.` });
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          style={styles.headerButton}
          onPress={goBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back to navigation"
        >
          <BackIcon color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Channels</Text>
        <View style={styles.headerButton} />
      </View>

      <View style={styles.body}>
        {isLoading ? <ChannelListSkeleton /> : null}
        {!isLoading && isError ? <ChannelsErrorState onRetry={() => void refetch()} /> : null}
        {!isLoading && !isError && rows.length === 0 ? <ChannelsEmptyState /> : null}
        {!isLoading && !isError && rows.length > 0 ? (
          <ScrollView
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={pulling}
                onRefresh={pull}
                tintColor={colors.muted}
                colors={[colors.ink]}
                progressBackgroundColor={colors.surfaceRaised}
              />
            }
          >
            {lockedPlan ? (
              <View style={styles.lockCard}>
                <View style={styles.lockText}>
                  <View style={styles.lockLabelRow}>
                    <Icon name="lock" size={14} color={colors.onInk} />
                    <Text style={[styles.cardLabel, styles.lockLabel]}>Channels are locked</Text>
                  </View>
                  <Text style={styles.cardTitle}>{`Get ${lockedPlan} to use channels`}</Text>
                </View>
                {billingEnabled ? (
                  <Pressable
                    style={styles.lockButton}
                    onPress={getPlan}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Get a plan, ${lockedPlan} unlocks channels`}
                  >
                    <Text style={styles.lockButtonText}>Get a plan</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              <View style={styles.card} accessible accessibilityRole="summary">
                <Text style={styles.cardLabel}>Needs you today</Text>
                {summary.actions > 0 ? (
                  <Text style={styles.cardTitle}>
                    {`${summary.actions} ${summary.actions === 1 ? "action" : "actions"}`}
                    <Text style={styles.cardSoft}>
                      {` across ${summary.channels} ${summary.channels === 1 ? "channel" : "channels"}`}
                    </Text>
                  </Text>
                ) : (
                  <Text style={styles.cardTitle}>Nothing new for you</Text>
                )}
                {summary.working > 0 ? (
                  <View style={styles.cardWorking}>
                    <StatusSpinner />
                    <Text style={styles.cardSoftSmall}>{`${summary.working} working now`}</Text>
                  </View>
                ) : null}
              </View>
            )}

            {plan && billingEnabled ? (
              <View style={styles.planLine}>
                <Text style={styles.planText}>{`You're on the ${plan} plan`}</Text>
                {canManage ? (
                  <Pressable onPress={() => router.push("/settings/billing")} hitSlop={6} accessibilityRole="link">
                    <UnderlinedText style={styles.planLink}>Compare plans</UnderlinedText>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {lockedWorking > 0 ? (
              <Text style={styles.banner}>
                {`Zavi is working on ${lockedWorking} ${lockedWorking === 1 ? "channel" : "channels"} for you. This takes a few minutes. You can leave this page.`}
              </Text>
            ) : null}

            {page.sections.map((sec) => (
              <View key={sec.key}>
                {showHeads ? <Text style={styles.sectionTitle}>{sec.label}</Text> : null}
                <View style={styles.group}>
                  {sec.rows.map((r, i) => (
                    <ChannelRow key={r.slug} row={r} divider={i > 0} onPress={() => open(r)} />
                  ))}
                </View>
              </View>
            ))}

            {page.plans.map((g, gi) => {
              const name = planName(g.tier);
              return (
                <View key={g.tier}>
                  <View style={styles.planHead}>
                    <View style={styles.planHeadText}>
                      <Text style={styles.sectionTitleInline}>{`On ${name}`}</Text>
                      {g.waiting > 0 ? (
                        <Text style={styles.planWaiting} numberOfLines={1}>
                          {`${g.waiting} ${g.waiting === 1 ? "action" : "actions"} waiting for you`}
                        </Text>
                      ) : null}
                    </View>
                    {billingEnabled ? (
                      <Pressable
                        style={[styles.upgrade, gi === 0 && styles.upgradeFirst]}
                        onPress={() => open(g.rows[0])}
                        accessibilityRole="button"
                        accessibilityLabel={g.waiting > 0 ? `See them, upgrade to ${name}` : `Upgrade to ${name}`}
                      >
                        <Text style={[styles.upgradeText, gi === 0 && styles.upgradeTextFirst]}>
                          {g.waiting > 0 ? "See them · Upgrade" : `Upgrade to ${name}`}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <View style={styles.group}>
                    {g.rows.map((r, i) => (
                      <ChannelRow key={r.slug} row={r} divider={i > 0} onPress={() => open(r)} />
                    ))}
                  </View>
                </View>
              );
            })}

            {page.soon.length > 0 ? (
              <View style={styles.soonRow}>
                <Text style={styles.soonLabel}>Coming soon</Text>
                {page.soon.map((r) => (
                  <View key={r.slug} style={styles.soonChip}>
                    <Text style={styles.soonChipText}>{`${r.name}${r.waiting > 0 ? ` · ${waitingLabel(r.waiting)} waiting` : ""}`}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </ScrollView>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  headerButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  headerTitle: {
    flex: 1,
    marginHorizontal: space.xs,
    fontFamily: font.family.semi,
    fontSize: 18,
    lineHeight: 24,
    textAlign: "center",
    textAlignVertical: "center",
    includeFontPadding: false,
    color: colors.ink,
  },
  body: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20 },
  card: { padding: space.lg, gap: 4, borderRadius: radius.lg, backgroundColor: colors.ink },
  cardLabel: { fontFamily: font.family.medium, fontSize: 12, color: colors.onInk, opacity: 0.6 },
  cardTitle: { fontFamily: font.family.semi, fontSize: 20, lineHeight: 26, color: colors.onInk },
  cardSoft: { fontFamily: font.family.regular, opacity: 0.6 },
  lockCard: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.ink },
  lockText: { flex: 1, minWidth: 0, gap: 4 },
  lockLabelRow: { flexDirection: "row", alignItems: "center", gap: 6, opacity: 0.6 },
  lockLabel: { opacity: 1 },
  lockButton: { paddingHorizontal: space.lg, paddingVertical: 10, borderRadius: radius.pill, backgroundColor: colors.onInk },
  lockButtonText: { fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
  cardWorking: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  cardSoftSmall: { fontFamily: font.family.regular, fontSize: 12, color: colors.onInk, opacity: 0.7 },
  planLine: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: space.md, paddingHorizontal: 2 },
  planText: { fontFamily: font.family.regular, fontSize: 13, color: colors.textSecondary },
  planLink: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
  banner: {
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.soft,
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
    overflow: "hidden",
  },
  sectionTitle: {
    marginTop: space.lg + space.xs,
    marginBottom: space.sm,
    marginLeft: 2,
    fontFamily: font.family.medium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  sectionTitleInline: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
  planHead: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: space.md, marginTop: space.lg + space.xs, marginBottom: space.sm, marginLeft: 2 },
  planHeadText: { flex: 1, minWidth: 0, gap: 2 },
  planWaiting: { fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
  upgrade: { paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill },
  upgradeFirst: { backgroundColor: colors.ink, borderColor: colors.ink },
  upgradeText: { fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
  upgradeTextFirst: { color: colors.onInk },
  soonRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: space.lg },
  soonLabel: { marginRight: 4, fontFamily: font.family.regular, fontSize: 13, color: colors.muted },
  soonChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: colors.soft },
  soonChipText: { fontFamily: font.family.medium, fontSize: 11, color: colors.muted },
  group: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: colors.panel,
  },
});
