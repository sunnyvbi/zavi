import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import { BackHeader } from "../../components/settings/SettingsUI";
import { AreaChart, BarChart, ChartSkeleton, EmptyChart } from "../../components/analytics/Charts";
import { Bars, Card, Delta, EmptyAnalytics, H3, LivePill, PillTabs, SpinningIcon, StatTile, TileGrid } from "../../components/analytics/kit";
import { GeoBands, SourceCard, makeHeadlineStyles } from "../../components/analytics/Source";
import { useBillingEnabled } from "../../features/agents/billingLink";
import { useAdsDashboard, useChannelLocks, useSeoGeoDashboard } from "../../features/analytics/hooks";
import {
  RANGE_OPTIONS,
  RANGE_TITLE,
  adsConnected,
  bucketAds,
  compactCount,
  computeHalfDeltas,
  count,
  crawlDate,
  money,
  pointsInRange,
  searchHasNumbers,
  shortDay,
  summaryLine,
} from "../../features/analytics/model";
import { setAnalyticsRange, useAnalyticsRange } from "../../features/analytics/range";
import { hasData, redditOff } from "../../features/channels/reddit";
import { useRedditDashboard } from "../../features/channels/redditHooks";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export default function Analytics() {
  const styles = useStyles(makeStyles);
  const hs = useStyles(makeHeadlineStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const billingEnabled = useBillingEnabled();
  const insets = useSafeAreaInsets();
  const range = useAnalyticsRange();
  const locks = useChannelLocks();
  const redditQ = useRedditDashboard();
  const redditMeasured = hasData(redditQ.data);
  const adsQ = useAdsDashboard(range, locks.ready && !locks.adsLock);
  const seoQ = useSeoGeoDashboard(locks.ready && !(locks.searchLock && locks.aiLock));
  const [refreshing, setRefreshing] = useState(false);
  const [pulling, setPulling] = useState(false);

  const ads = adsQ.data ?? null;
  const search = seoQ.data?.search ?? null;
  const geo = seoQ.data?.geo ?? null;
  const adsLoading = !locks.ready || (!locks.adsLock && adsQ.isLoading);
  const seoLoading = !locks.ready || seoQ.isLoading;
  const loading = adsLoading || seoLoading;
  const adsOn = adsConnected(ads) && !locks.adsLock;
  const searchOn = searchHasNumbers(search) && !locks.searchLock;
  const aiOn = !!geo?.measured && !locks.aiLock;

  const now = new Date();
  const allPoints = ads?.series.all ?? [];
  const deltas = computeHalfDeltas(allPoints);
  const buckets = bucketAds(pointsInRange(allPoints, range, now), range);
  const by = range === "90d" ? "week" : "day";
  const totals = ads?.totals.all ?? null;
  const nothing = !loading && !adsOn && !searchOn;
  const emptyPage = nothing && !aiOn;
  const allLocked = !!(locks.adsLock && locks.searchLock && locks.aiLock);

  const reload = async () => {
    setRefreshing(true);
    await Promise.allSettled([locks.refetch(), adsOn ? adsQ.refresh() : adsQ.refetch(), seoQ.refetch(), redditQ.refetch()]);
    setRefreshing(false);
  };
  const onPull = async () => {
    setPulling(true);
    await reload();
    setPulling(false);
  };
  const onRefreshButton = () => {
    if (!refreshing) void reload();
  };
  const open = (id: string) => router.push({ pathname: "/analytics/[source]", params: { source: id } });
  const toConnectors = () => router.push("/toolkit");
  const toPlans = billingEnabled ? () => router.push("/settings/billing") : undefined;

  return (
    <Screen>
      <BackHeader
        title="Analytics"
        right={
          <Pressable
            onPress={onRefreshButton}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Refresh data"
            accessibilityState={{ busy: refreshing }}
          >
            <SpinningIcon name="refresh" size={20} color={colors.wire.ink} spinning={refreshing && !pulling} />
          </Pressable>
        }
      />
      <ScrollView
        style={styles.page}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 20 }]}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={colors.wire.mute} progressBackgroundColor={colors.surfaceRaised} colors={[colors.ink]} />}
      >
        {emptyPage ? null : <PillTabs label="Date range" value={range} options={RANGE_OPTIONS} onChange={setAnalyticsRange} />}

        {emptyPage ? (
          <Card style={styles.summary}>
            <EmptyAnalytics
              body={
                allLocked
                  ? `Ads, search and AI search numbers come with a paid plan.${toPlans ? " Pick one and this page fills in." : ""}`
                  : "Connect an ad account or Google Search Console and bookings, spend and search clicks land here."
              }
              actionLabel={allLocked ? (toPlans ? "Get plan" : undefined) : "Connect a source"}
              onAction={allLocked ? toPlans : toConnectors}
            />
          </Card>
        ) : (
        <Card style={styles.summary}>
          <View style={styles.row}>
            <H3>{RANGE_TITLE[range]}</H3>
            {nothing ? (
              <LivePill tone="grey" label="Nothing connected" />
            ) : loading ? (
              <LivePill tone="grey" label="Reading" />
            ) : ads?.lastGood || ads?.errors.length ? (
              <LivePill tone="amber" label="Last good read" />
            ) : (
              <LivePill />
            )}
          </View>
          {loading ? (
            <View style={styles.gapTop}>
              <Bars lines={2} label="Loading summary" />
            </View>
          ) : (
            <Text style={styles.summaryText}>{summaryLine(adsOn ? ads : null, searchOn ? search : null)}</Text>
          )}
          <TileGrid>
            <StatTile
              label="Ad bookings"
              value={compactCount(totals?.conversions)}
              delta={deltas.bookings}
              empty={adsLoading || !adsOn}
              sub={adsLoading ? "Reading" : locks.adsLock ? "On a higher plan" : "Not connected"}
            />
            <StatTile
              label="Ad CAC"
              value={money(totals?.cpa_usd)}
              delta={deltas.cac}
              empty={adsLoading || !adsOn}
              sub={adsLoading ? "Reading" : locks.adsLock ? "On a higher plan" : "Not connected"}
            />
            <StatTile
              label="Search clicks"
              value={count(search?.totals?.clicks)}
              sub={searchOn ? "Last 28 days" : seoLoading ? "Reading" : locks.searchLock ? "On a higher plan" : "Not connected"}
              empty={seoLoading || !searchOn}
            />
            <StatTile
              label="AI readiness"
              value={`${geo?.score ?? 0}/100`}
              sub={aiOn ? `${crawlDate(geo?.fetchedAt ?? null)} crawl` : seoLoading ? "Reading" : "Not checked yet"}
              empty={seoLoading || !aiOn}
            />
          </TileGrid>
        </Card>
        )}

        <Text style={styles.bySource}>By source</Text>
        <View style={styles.cards}>
          <SourceCard
            id="ads"
            lockedTier={locks.adsLock}
            onPlans={toPlans}
            failed={adsQ.isError && !ads}
            onRetry={() => void adsQ.refetch()}
            onOpen={adsOn && !adsLoading ? () => open("ads") : undefined}
            headline={
              adsOn && !adsLoading && totals ? (
                <>
                  <Text style={hs.big}>{compactCount(totals.conversions)}</Text>
                  <Text style={hs.unit}>bookings</Text>
                  <Delta delta={deltas.bookings} />
                </>
              ) : null
            }
            chart={
              adsLoading ? (
                <ChartSkeleton height={140} />
              ) : adsOn ? (
                buckets.length ? (
                  <BarChart bars={buckets.map((b) => ({ label: b.label, value: b.bookings }))} height={140} label="Purchases" />
                ) : (
                  <EmptyChart height={140} text="No ad days in this range yet." />
                )
              ) : (
                <EmptyChart height={140} text="No numbers yet. Connect Meta Ads or Google Ads." />
              )
            }
            caption={adsOn && !adsLoading ? `Purchases from ads, by ${by} · tap a bar for its value` : undefined}
            connectLabel={!adsLoading && !adsOn ? "Connect Meta Ads" : undefined}
            onConnect={toConnectors}
          />

          <SourceCard
            id="search"
            lockedTier={locks.searchLock}
            onPlans={toPlans}
            failed={seoQ.isError && !search}
            onRetry={() => void seoQ.refetch()}
            onOpen={searchOn && !seoLoading ? () => open("search") : undefined}
            headline={
              searchOn && !seoLoading && search?.totals ? (
                <>
                  <Text style={hs.big}>{count(search.totals.clicks)}</Text>
                  <Text style={hs.unit}>clicks · last 28 days</Text>
                </>
              ) : null
            }
            chart={
              seoLoading ? (
                <ChartSkeleton height={140} />
              ) : searchOn && search ? (
                <AreaChart
                  title="Search clicks"
                  height={140}
                  labels={search.series.map((p) => shortDay(p.date))}
                  series={[{ id: "c", label: "Clicks", color: colors.chart.bar, values: search.series.map((p) => p.clicks) }]}
                />
              ) : (
                <EmptyChart
                  height={140}
                  text={search?.loadError ? "Search Console didn't answer just now." : "No numbers yet. Connect Search Console."}
                />
              )
            }
            caption={searchOn && !seoLoading ? "Clicks from Google, by day · tap a point for its value" : undefined}
            connectLabel={!seoLoading && !searchOn && !search?.loadError ? "Connect Search Console" : undefined}
            onConnect={toConnectors}
          />

          <SourceCard
            id="ai"
            lockedTier={locks.aiLock}
            onPlans={toPlans}
            failed={seoQ.isError && !seoQ.data}
            onRetry={() => void seoQ.refetch()}
            onOpen={geo && !seoLoading ? () => open("ai") : undefined}
            headline={
              aiOn && !seoLoading && geo ? (
                <>
                  <Text style={hs.big}>
                    {geo.score}
                    <Text style={hs.of}>/100</Text>
                  </Text>
                  <Text style={hs.unit}>readiness</Text>
                </>
              ) : null
            }
            chart={
              seoLoading ? (
                <ChartSkeleton height={140} />
              ) : aiOn && geo ? (
                <GeoBands geo={geo} />
              ) : (
                <EmptyChart
                  height={140}
                  text={geo ? "No page could be read yet, so there is nothing to score." : "Not checked yet. Zavi reads your site on the first SEO run."}
                />
              )
            }
            caption={aiOn && !seoLoading ? `From the ${crawlDate(geo?.fetchedAt ?? null)} crawl · not affected by the date range` : undefined}
          />

          {redditOff(redditQ.data) ? null : (
            <SourceCard
              id="reddit"
              failed={redditQ.isError && !redditQ.data}
              onRetry={() => void redditQ.refetch()}
              onOpen={redditMeasured ? () => open("reddit") : undefined}
              headline={
                redditMeasured ? (
                  <>
                    <Text style={hs.big}>{compactCount(redditQ.data?.insights?.kpis?.reply_opportunities?.value ?? 0)}</Text>
                    <Text style={hs.unit}>reply opportunities · last 7 days</Text>
                  </>
                ) : null
              }
              chart={
                redditQ.isLoading ? (
                  <ChartSkeleton height={140} />
                ) : redditMeasured ? (
                  <TileGrid>
                    <StatTile label="Posts read today" value={count(redditQ.data?.insights?.today?.posts_scanned ?? 0)} />
                    <StatTile label="Subreddits covered" value={count(redditQ.data?.insights?.today?.communities_scanned ?? 0)} />
                    <StatTile label="Worth replying to" value={count(redditQ.data?.insights?.today?.posts_relevant ?? 0)} />
                  </TileGrid>
                ) : (
                  <EmptyChart height={140} text="No Reddit scan yet. Open the Reddit channel and run a scan; the numbers land here." />
                )
              }
              caption={redditMeasured ? "From today's scan · not affected by the date range" : undefined}
            />
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.wire.page },
  content: { paddingHorizontal: 16, paddingTop: 20 },
  summary: { marginTop: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  gapTop: { marginTop: 12 },
  summaryText: { marginTop: 8, fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.wire.body },
  bySource: { marginTop: 24, marginBottom: 10, fontFamily: font.family.semi, fontSize: 17, color: colors.wire.text },
  cards: { gap: 12 },
});
