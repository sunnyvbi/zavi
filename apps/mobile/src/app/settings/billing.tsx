import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { isBillingEnabled, useSignupAvailability } from "../../auth/signup";
import { BackIcon, Icon } from "../../components/Icon";
import { Screen } from "../../components/Screen";
import { Message } from "../../components/settings/SettingsUI";
import { CurrentPlanCard } from "../../components/billing/CurrentPlanCard";
import { LowCreditsCard, BillingNote } from "../../components/billing/LowCreditsCard";
import { PlansSection } from "../../components/billing/PlansSection";
import { InvoicesSection } from "../../components/billing/InvoicesSection";
import {
  effectiveTier,
  useCanManage,
  useCredits,
  useInvoices,
  useUsageBreakdown,
  type UsageWindow,
} from "../../features/settings/api";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type Tab = "billing" | "usage";

const TABS: { id: Tab; label: string }[] = [
  { id: "billing", label: "Billing & Credits" },
  { id: "usage", label: "Usage" },
];

const WINDOWS: UsageWindow[] = [7, 30, 90];

function agentColors(colors: Colors): string[] {
  return [colors.wire.ink, colors.chart.indigo, colors.chart.teal, colors.chart.seriesOther];
}

function n(v: number): string {
  const x = Math.max(0, Math.round(v));
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (x >= size) {
      const short = Math.floor((x / size) * 10) / 10;
      return `${short.toFixed(1).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(x);
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const ACRONYMS = new Set(["pm", "qa", "seo", "ugc", "ai", "ceo", "cto"]);

function agentName(slug: string): string {
  if (!slug || slug === "unknown") return "Other";
  const words = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w));
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export default function Billing() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("billing");
  const creditsQ = useCredits();
  const c = creditsQ.data;
  const invoicesQ = useInvoices();
  const canManage = useCanManage();
  const showLinks = canManage;
  const availability = useSignupAvailability();
  const invoices = (invoicesQ.data ?? []).map((i) => ({
    number: i.number ?? i.id,
    date: i.created * 1000,
    amountCents: Math.round(i.amount_due_usd * 100),
  }));

  if (!isBillingEnabled(availability.data)) {
    return availability.isPending ? (
      <Screen>
        <ActivityIndicator style={styles.pendingSpinner} color={colors.muted} />
      </Screen>
    ) : (
      <Redirect href="/settings" />
    );
  }

  return (
    <Screen>
      {}
      <View style={styles.topBar}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <BackIcon color={colors.wire.ink} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          Billing & credits
        </Text>
        <View style={styles.topBarEnd} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {}
        <Text style={styles.intro}>Your plan, your credits, and what Zavi spent them on.</Text>

        {}
        <View style={styles.tabs} accessibilityRole="tablist">
          {TABS.map((t) => {
            const on = t.id === tab;
            return (
              <Pressable
                key={t.id}
                style={[styles.tab, on && styles.tabOn]}
                onPress={() => setTab(t.id)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
              >
                <Text style={[styles.tabText, on && styles.tabTextOn]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {creditsQ.isLoading ? (
          <ActivityIndicator style={styles.loading} color={colors.muted} />
        ) : creditsQ.isError || !c ? (
          <Message tone="error">Couldn't load billing. Go back and try again.</Message>
        ) : tab === "billing" ? (
          <View style={styles.column}>
            <CurrentPlanCard c={c} />
            <LowCreditsCard c={c} showLinks={showLinks} canManage={canManage} />
            <PlansSection c={c} showLinks={showLinks} />
            <InvoicesSection
              invoices={invoices}
              isFree={effectiveTier(c) === "free"}
              canOpenReceipts={showLinks}
            />
            <BillingNote showLinks={showLinks} />
          </View>
        ) : (
          <UsageSection />
        )}
      </ScrollView>
    </Screen>
  );
}

function UsageSection() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [days, setDays] = useState<UsageWindow>(30);
  const usageQ = useUsageBreakdown(days);
  const u = usageQ.data;

  let body: ReactNode;
  if (usageQ.isLoading) {
    body = <ActivityIndicator style={styles.usageLoading} color={colors.muted} />;
  } else if (usageQ.isError || !u) {
    body = <Text style={styles.empty}>Couldn't load usage.</Text>;
  } else {
    const top = u.by_agent.slice(0, 3);
    const rest = u.by_agent.slice(3).reduce((sum, a) => sum + a.credits, 0);
    const rows = [
      ...top.map((a, i) => ({ name: agentName(a.agent_slug), credits: a.credits, color: agentColors(colors)[i] })),
      ...(rest > 0 ? [{ name: "Everything else", credits: rest, color: agentColors(colors)[3] }] : []),
    ];
    const shares = rows.map((r) => (u.total_credits > 0 ? r.credits / u.total_credits : 0));
    const peak = Math.max(1, ...u.daily.map((d) => d.credits));
    const gap = days === 90 ? 1 : days === 30 ? 2 : 6;

    body = (
      <>
        {}
        <View style={styles.totalRow}>
          <Text style={styles.totalNumber}>{n(u.total_credits)}</Text>
          <Text style={styles.totalLabel}>credits used</Text>
        </View>

        {}
        <View
          style={[styles.chart, { gap }]}
          accessible
          accessibilityRole="image"
          accessibilityLabel={
            u.total_credits > 0
              ? `Daily credit use over the last ${days} days, stacked by agent`
              : "No credit use in this period"
          }
        >
          {u.daily.map((d) => (
            <View key={d.date} style={styles.chartCol}>
              {[...shares].reverse().map((share, i) => (
                <View
                  key={i}
                  style={{
                    width: "100%",
                    height: `${((d.credits * share) / peak) * 100}%`,
                    backgroundColor: agentColors(colors)[shares.length - 1 - i] ?? agentColors(colors)[3],
                  }}
                />
              ))}
            </View>
          ))}
        </View>

        {}
        <View style={styles.dates}>
          <Text style={styles.dateText}>{shortDate(u.period_start)}</Text>
          <Text style={styles.dateText}>{shortDate(u.period_end)}</Text>
        </View>

        {}
        <View style={styles.list}>
          {rows.length === 0 ? (
            <Text style={[styles.empty, styles.listRow]}>
              No credits used in this period. Spend shows here after Zavi's first run.
            </Text>
          ) : (
            rows.map((r) => (
              <View key={r.name} style={[styles.listRow, styles.agentRow]}>
                <View style={[styles.dot, { backgroundColor: r.color }]} />
                <Text style={styles.agentName}>{r.name}</Text>
                <Text style={styles.agentCredits}>{`${r.credits.toLocaleString("en-US")} credits`}</Text>
              </View>
            ))
          )}
          <View style={styles.totalListRow}>
            <View style={styles.dotSpacer} />
            <Text style={styles.totalName}>Total</Text>
            <Text style={styles.totalValue}>{`${u.total_credits.toLocaleString("en-US")} credits`}</Text>
          </View>
        </View>
      </>
    );
  }

  return (
    <View style={styles.card}>
      {}
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>Where your credits went</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{`Last ${days} days`}</Text>
        </View>
      </View>

      {}
      <View style={styles.segment} accessibilityRole="tablist">
        {WINDOWS.map((w) => {
          const on = w === days;
          return (
            <Pressable
              key={w}
              style={[styles.segmentItem, on && styles.segmentOn]}
              onPress={() => setDays(w)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{`${w} days`}</Text>
            </Pressable>
          );
        })}
      </View>

      {body}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  pendingSpinner: { marginTop: space.xl },
  topBar: {
    height: 60,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.wire.line,
    backgroundColor: colors.bg,
  },
  backButton: { width: 44, height: 44, margin: 2, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  title: {
    flex: 1,
    marginHorizontal: 4,
    textAlign: "center",
    fontFamily: font.family.semi,
    fontSize: 17,
    lineHeight: 24,
    color: colors.wire.ink,
  },
  topBarEnd: { width: 48, height: 48 },
  content: { paddingTop: 20, paddingHorizontal: 16, paddingBottom: 20 },
  intro: { marginTop: 4, fontFamily: font.family.regular, fontSize: 14, lineHeight: 21, color: colors.wire.sub },
  tabs: { flexDirection: "row", gap: 24, marginTop: 16, marginBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.wire.line },
  tab: { marginBottom: -1, paddingBottom: 10, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabOn: { borderBottomColor: colors.wire.ink },
  tabText: { fontFamily: font.family.semi, fontSize: 15, color: colors.wire.mute },
  tabTextOn: { color: colors.wire.ink },
  loading: { marginVertical: space.xl },
  column: { gap: 14 },
  card: { borderWidth: 1, borderColor: colors.wire.line, borderRadius: 16, backgroundColor: colors.surfaceRaised, padding: 16 },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardTitle: { fontFamily: font.family.semi, fontSize: 15, color: colors.wire.ink },
  badge: { borderRadius: 999, paddingVertical: 2, paddingHorizontal: 9, backgroundColor: colors.wire.tint },
  badgeText: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 18, color: colors.wire.sub },
  segment: { flexDirection: "row", gap: 4, padding: 4, marginTop: 12, borderRadius: 12, backgroundColor: colors.wire.tint },
  segmentItem: { flex: 1, minHeight: 32, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  segmentOn: {
    backgroundColor: colors.wire.tabOn,
    shadowColor: "#101214",
    shadowOpacity: 0.12,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segmentText: { fontFamily: font.family.medium, fontSize: 13, color: colors.wire.mute },
  segmentTextOn: { fontFamily: font.family.semi, color: colors.wire.ink },
  usageLoading: { marginVertical: 40 },
  totalRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 14 },
  totalNumber: { fontFamily: font.family.bold, fontSize: 28, letterSpacing: -0.5, color: colors.wire.ink, fontVariant: ["tabular-nums"] },
  totalLabel: { fontFamily: font.family.regular, fontSize: 13, color: colors.wire.mute },
  chart: { flexDirection: "row", alignItems: "stretch", marginTop: 12, height: 130 },
  chartCol: { flex: 1, minHeight: 0, justifyContent: "flex-end", overflow: "hidden", borderRadius: 3, backgroundColor: colors.wire.head },
  dates: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  dateText: { fontFamily: font.family.regular, fontSize: 13, color: colors.wire.faint },
  list: { marginTop: 14, borderTopWidth: 1, borderTopColor: colors.wire.tint },
  listRow: { borderBottomWidth: 1, borderBottomColor: colors.wire.tint },
  empty: { paddingVertical: 12, fontFamily: font.family.regular, fontSize: 14, color: colors.wire.mute },
  agentRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  dot: { width: 10, height: 10, borderRadius: 999 },
  dotSpacer: { width: 10 },
  agentName: { flex: 1, fontFamily: font.family.medium, fontSize: 14, color: colors.wire.text },
  agentCredits: { fontFamily: font.family.regular, fontSize: 14, color: colors.wire.sub, fontVariant: ["tabular-nums"] },
  totalListRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  totalName: { flex: 1, fontFamily: font.family.semi, fontSize: 14, color: colors.wire.ink },
  totalValue: { fontFamily: font.family.semi, fontSize: 14, color: colors.wire.ink, fontVariant: ["tabular-nums"] },
});
