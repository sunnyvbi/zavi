import { useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import { BackHeader, Segmented } from "../../components/settings/SettingsUI";
import { AreaChart, BarChart, ChartSkeleton, EmptyChart } from "../../components/analytics/Charts";
import { Card, H3, LivePill, Muted, PillTabs, SmallButton, StatTile, TileGrid } from "../../components/analytics/kit";
import { GeoBands, SOURCE, type SourceId } from "../../components/analytics/Source";
import { RedditDetail } from "../../components/analytics/RedditDetail";
import { useRedditDashboard, useRefreshReddit } from "../../features/channels/redditHooks";
import { useBillingEnabled } from "../../features/agents/billingLink";
import { useAdsDashboard, useChannelLocks, useSeoGeoDashboard } from "../../features/analytics/hooks";
import {
  PLAN_NAME,
  RANGE_OPTIONS,
  SCORE_WORD,
  adKpiCards,
  adScopes,
  adsConnected,
  ago,
  bucketAds,
  compactCount,
  computeHalfDeltas,
  costPerBooking,
  count,
  crawlDate,
  ctrPct,
  defaultScope,
  money,
  pointsInRange,
  position,
  scoreTone,
  searchHasNumbers,
  shortDay,
  type AdScope,
} from "../../features/analytics/model";
import { setAnalyticsRange, useAnalyticsRange } from "../../features/analytics/range";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

function scoreColors(colors: Colors) {
  const s = colors.status;
  return {
    good: { bg: s.greenBg, fg: s.greenText },
    fair: { bg: s.amberBg, fg: s.amberText },
    weak: { bg: s.redBg, fg: s.redVivid },
  };
}

function isSource(v: unknown): v is SourceId {
  return v === "ads" || v === "search" || v === "ai" || v === "reddit";
}

export default function AnalyticsSource() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ source?: string }>();
  const id: SourceId = isSource(params.source) ? params.source : "ads";
  const router = useRouter();
  const billingEnabled = useBillingEnabled();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const refreshReddit = useRefreshReddit();
  const locks = useChannelLocks();
  const range = useAnalyticsRange();
  const adsQ = useAdsDashboard(range, id === "ads" && locks.ready && !locks.adsLock);
  const seoQ = useSeoGeoDashboard((id === "search" || id === "ai") && locks.ready);
  const redditQ = useRedditDashboard(id === "reddit");
  const lock = id === "ads" ? locks.adsLock : id === "search" ? locks.searchLock : id === "ai" ? locks.aiLock : null;

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.allSettled([id === "ads" ? adsQ.refresh() : id === "reddit" ? refreshReddit() : seoQ.refetch()]);
    setRefreshing(false);
  };
  const ask = (text: string) => router.push({ pathname: "/chat", params: { prefill: text, back: "1" } });

  return (
    <Screen>
      <BackHeader title={SOURCE[id].title} />
      <ScrollView
        style={styles.page}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 20 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.wire.mute} progressBackgroundColor={colors.surfaceRaised} colors={[colors.ink]} />}
      >
        {lock ? (
          <Card>
            <Muted>{`${SOURCE[id].title} numbers come with the ${PLAN_NAME[lock]} plan.`}</Muted>
            {billingEnabled ? (
              <View style={styles.gap12}>
                <SmallButton primary label="See plans" onPress={() => router.push("/settings/billing")} />
              </View>
            ) : null}
          </Card>
        ) : id === "ads" ? (
          <AdsDetail q={adsQ} range={range} loading={!locks.ready || adsQ.isLoading} onAsk={ask} onConnect={() => router.push("/toolkit")} />
        ) : id === "reddit" ? (
          <RedditDetail q={redditQ} />
        ) : id === "search" ? (
          <SearchDetail q={seoQ} loading={!locks.ready || seoQ.isLoading} onAsk={ask} onConnect={() => router.push("/toolkit")} />
        ) : (
          <AiDetail q={seoQ} loading={!locks.ready || seoQ.isLoading} onAsk={ask} />
        )}
      </ScrollView>
    </Screen>
  );
}

type AdsQ = ReturnType<typeof useAdsDashboard>;
type SeoQ = ReturnType<typeof useSeoGeoDashboard>;

function Failed({ onRetry }: { onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Card>
      <Muted>Couldn't load this.</Muted>
      <View style={styles.gap12}>
        <SmallButton label="Retry" onPress={onRetry} />
      </View>
    </Card>
  );
}

const searchRow = (r: { key: string; clicks: number; impressions: number; ctr: number; position: number }): string[] => [
  r.key,
  count(r.clicks),
  count(r.impressions),
  ctrPct(r.ctr),
  position(r.position),
];

const pagePath = (url: string): string => {
  const m = /^https?:\/\/[^/?#]+([^#]*)/i.exec(url);
  return m ? m[1] || "/" : url;
};

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  const styles = useStyles(makeStyles);
  const dense = head.length > 3;
  const numStyle = dense ? styles.numDense : null;
  return (
    <View style={styles.table}>
      <View style={[styles.tableHead, dense && styles.rowDense]}>
        <Text style={[styles.th, styles.cellFirst]}>{head[0]}</Text>
        {head.slice(1).map((h) => (
          <Text key={h} style={[styles.th, numStyle]}>
            {h}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View key={`${r[0]}-${i}`} style={[styles.tr, dense && styles.rowDense]}>
          <Text style={[styles.td, styles.cellFirst]} numberOfLines={dense ? 2 : 1}>
            {r[0]}
          </Text>
          {r.slice(1).map((v, j) => (
            <Text key={j} style={[styles.tdNum, numStyle]}>
              {v}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function AdsDetail({
  q,
  range,
  loading,
  onAsk,
  onConnect,
}: {
  q: AdsQ;
  range: ReturnType<typeof useAnalyticsRange>;
  loading: boolean;
  onAsk: (t: string) => void;
  onConnect: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const ads = q.data ?? null;
  const [scope, setScope] = useState<AdScope | null>(null);
  useEffect(() => {
    if (ads && (!scope || !adScopes(ads).some((s) => s.value === scope))) setScope(defaultScope(ads));
  }, [ads, scope]);
  const on = adsConnected(ads);
  const sc: AdScope = scope ?? "all";
  const totals = ads?.totals[sc] ?? null;
  const points = ads?.series[sc] ?? [];
  const buckets = bucketAds(pointsInRange(points, range, new Date()), range);
  const title = ads?.windowLabel ? ads.windowLabel.charAt(0).toUpperCase() + ads.windowLabel.slice(1) : "";

  return (
    <>
      <PillTabs label="Date range" value={range} options={RANGE_OPTIONS} onChange={setAnalyticsRange} />
      {ads && adScopes(ads).length > 1 ? (
        <View style={styles.gap12}>
          <Segmented label="Ad account" value={sc} options={adScopes(ads)} onChange={setScope} />
        </View>
      ) : null}
      {q.isError && !ads ? (
        <View style={styles.gap12}>
          <Failed onRetry={() => void q.refetch()} />
        </View>
      ) : (
        <Card style={styles.gap12}>
          <View style={styles.row}>
            <H3>{loading ? "Reading" : title}</H3>
            {loading ? (
              <LivePill tone="grey" label="Reading" />
            ) : !on ? (
              <LivePill tone="grey" label="Not connected" />
            ) : ads?.lastGood || ads?.errors.length ? (
              <LivePill tone="amber" label="Last good read" />
            ) : (
              <LivePill />
            )}
          </View>
          {loading ? (
            <View style={styles.gap12}>
              <ChartSkeleton height={170} />
            </View>
          ) : on && totals ? (
            <>
              <TileGrid>
                {adKpiCards(sc, totals, computeHalfDeltas(points)).map((c) => (
                  <StatTile key={c.label} label={c.label} value={c.value} delta={c.delta} />
                ))}
              </TileGrid>
              <Muted style={styles.gap8}>Change is the second half of this range against the first half, as on web.</Muted>
              {ads?.errors.map((e) => (
                <Muted key={e} style={styles.gap8}>
                  {e}
                </Muted>
              ))}
              {buckets.length ? (
                <>
                  <H3 style={styles.subhead}>Spend vs cost per purchase</H3>
                  <AreaChart
                    title="Spend vs cost per purchase"
                    dualAxis
                    height={190}
                    labels={buckets.map((b) => b.label)}
                    series={[
                      { id: "spend", label: "Spend ($)", color: colors.status.greenDot, unit: "$", values: buckets.map((b) => b.spend) },
                      { id: "cpb", label: "Cost per purchase ($)", color: colors.chart.blue, unit: "$", values: buckets.map(costPerBooking) },
                    ]}
                  />
                  <H3 style={styles.subhead}>{`Purchases from ads, by ${range === "90d" ? "week" : "day"}`}</H3>
                  <BarChart bars={buckets.map((b) => ({ label: b.label, value: b.bookings }))} height={170} label="Purchases" />
                  <Muted style={styles.center}>Tap a bar to see its value</Muted>
                  <Muted style={styles.gap8}>Bookings counts every conversion the ad accounts report; the daily bars count purchases (Meta) and conversions (Google), as web's trend does.</Muted>
                </>
              ) : (
                <View style={styles.gap12}>
                  <EmptyChart height={170} text="No ad days in this range yet." />
                </View>
              )}
            </>
          ) : (
            <>
              <View style={styles.gap12}>
                <EmptyChart height={170} text="No numbers yet. Connect Meta Ads or Google Ads." />
              </View>
              <View style={styles.gap12}>
                <SmallButton primary full label="Connect Meta Ads" onPress={onConnect} />
              </View>
            </>
          )}
        </Card>
      )}
      {on && !loading && buckets.length ? (
        <View style={styles.gap12}>
          <Table
            head={[range === "90d" ? "Week of" : "Day", "Purchases", "Spend"]}
            rows={[...buckets].reverse().map((b) => [b.label, count(b.bookings), money(b.spend)])}
          />
        </View>
      ) : null}
      <Muted style={styles.gap16}>{`From ${SOURCE.ads.from}${ads?.fetchedAt ? ` · read ${ago(ads.fetchedAt, new Date())}` : ""}`}</Muted>
      <View style={styles.gap12}>
        <SmallButton full label="Ask Zavi about ads" onPress={() => onAsk("Look at my ads for this period and tell me what to change.")} />
      </View>
    </>
  );
}

function SearchDetail({ q, loading, onAsk, onConnect }: { q: SeoQ; loading: boolean; onAsk: (t: string) => void; onConnect: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const s = q.data?.search ?? null;
  const on = searchHasNumbers(s);
  const period = s?.start && s?.end ? `${shortDay(s.start)} – ${shortDay(s.end)}` : "";
  return (
    <>
      <Muted>Google Search Console's last 28 days, the same window web shows. The 7 / 30 / 90 day picker only moves Ads.</Muted>
      {q.isError && !s ? (
        <View style={styles.gap12}>
          <Failed onRetry={() => void q.refetch()} />
        </View>
      ) : (
        <Card style={styles.gap12}>
          <View style={styles.row}>
            <H3>Last 28 days</H3>
            {loading ? <LivePill tone="grey" label="Reading" /> : on ? <LivePill /> : <LivePill tone="grey" label="Not connected" />}
          </View>
          {period && on ? <Muted style={styles.gap4}>{period}</Muted> : null}
          {loading ? (
            <View style={styles.gap12}>
              <ChartSkeleton height={170} />
            </View>
          ) : on && s?.totals ? (
            <>
              <TileGrid>
                <StatTile label="Clicks" value={count(s.totals.clicks)} />
                <StatTile label="Impressions" value={count(s.totals.impressions)} />
                <StatTile label="CTR" value={ctrPct(s.totals.ctr)} />
                <StatTile label="Avg position" value={position(s.totals.position)} />
              </TileGrid>
              <H3 style={styles.subhead}>Clicks from Google, by day</H3>
              <AreaChart
                title="Search clicks"
                height={170}
                labels={s.series.map((p) => shortDay(p.date))}
                series={[{ id: "c", label: "Clicks", color: colors.chart.bar, values: s.series.map((p) => p.clicks) }]}
              />
              <Muted style={styles.center}>Tap a point to see its value</Muted>
            </>
          ) : (
            <>
              <View style={styles.gap12}>
                <EmptyChart height={170} text={s?.loadError ? "Search Console didn't answer just now." : "No numbers yet. Connect Google Search Console."} />
              </View>
              {!s?.loadError ? (
                <View style={styles.gap12}>
                  <SmallButton primary full label="Connect Search Console" onPress={onConnect} />
                </View>
              ) : null}
            </>
          )}
        </Card>
      )}
      {on && !loading && s ? (
        <>
          {s.topQueries.length ? (
            <View style={styles.gap12}>
              <Table head={["Top queries", "Clicks", "Impr.", "CTR", "Pos."]} rows={s.topQueries.slice(0, 10).map(searchRow)} />
            </View>
          ) : null}
          {s.topPages.length ? (
            <View style={styles.gap12}>
              <Table head={["Top pages", "Clicks", "Impr.", "CTR", "Pos."]} rows={s.topPages.slice(0, 10).map((r) => searchRow({ ...r, key: pagePath(r.key) }))} />
            </View>
          ) : null}
          <View style={styles.gap12}>
            <Table head={["Day", "Clicks"]} rows={[...s.series].reverse().map((p) => [shortDay(p.date), count(p.clicks)])} />
          </View>
        </>
      ) : null}
      <Muted style={styles.gap16}>{`From ${SOURCE.search.from}${s?.site ? ` · ${s.site}` : ""}`}</Muted>
      <View style={styles.gap12}>
        <SmallButton full label="Ask Zavi about search" onPress={() => onAsk("Look at my Google search numbers and tell me what to change.")} />
      </View>
    </>
  );
}

function AiDetail({ q, loading, onAsk }: { q: SeoQ; loading: boolean; onAsk: (t: string) => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const geo = q.data?.geo ?? null;
  const date = crawlDate(geo?.fetchedAt ?? null);
  const tone = geo ? scoreTone(geo.score) : "weak";
  return (
    <>
      <Muted>
        {`How ready your site is to be quoted by AI assistants. This is Zavi's own check of your pages${date ? ` from the ${date} crawl` : ""}, not a count of citations.`}
      </Muted>
      {q.isError && !q.data ? (
        <View style={styles.gap12}>
          <Failed onRetry={() => void q.refetch()} />
        </View>
      ) : (
        <Card style={styles.gap12}>
          <View style={styles.row}>
            <H3>Readiness</H3>
            {loading ? (
              <LivePill tone="grey" label="Reading" />
            ) : geo?.measured ? (
              <LivePill tone={geo.stale ? "amber" : "green"} label={`${date} crawl`} />
            ) : (
              <LivePill tone="grey" label="Not checked" />
            )}
          </View>
          {loading ? (
            <View style={styles.gap12}>
              <ChartSkeleton height={170} />
            </View>
          ) : geo?.measured ? (
            <>
              <View style={[styles.row, styles.gap12]}>
                <Text style={styles.score}>
                  {geo.score}
                  <Text style={styles.scoreOf}>/100</Text>
                </Text>
                <View style={[styles.word, { backgroundColor: scoreColors(colors)[tone].bg }]}>
                  <Text style={[styles.wordText, { color: scoreColors(colors)[tone].fg }]}>{SCORE_WORD[tone]}</Text>
                </View>
              </View>
              <Muted style={styles.gap4}>Zavi's readiness score, from the pages it fetched. It never says how often you are cited.</Muted>
              <View style={styles.gap16}>
                <GeoBands geo={geo} big />
              </View>
              <TileGrid>
                <StatTile label="Pages checked" value={count(geo.pagesChecked)} />
                <StatTile label="Readable without JS" value={`${geo.readableWithoutJs}/${geo.pagesChecked}`} />
                <StatTile label="AI crawlers blocked" value={`${geo.crawlersBlocked}/${geo.crawlersRecommended}`} />
                <StatTile label="Issues found" value={count(geo.issues)} />
              </TileGrid>
              {geo.stale ? <Muted style={styles.gap8}>Couldn't re-check just now; this is the last crawl.</Muted> : null}
            </>
          ) : (
            <View style={styles.gap12}>
              <EmptyChart
                height={170}
                text={geo ? "No page could be read yet, so there is nothing to score." : "Not checked yet. Zavi reads your site on the first SEO run."}
              />
            </View>
          )}
        </Card>
      )}
      {geo?.notChecked.length ? (
        <Card style={styles.gap12}>
          <H3>Not checked</H3>
          <View style={styles.list}>
            {geo.notChecked.map((t) => (
              <View key={t} style={styles.li}>
                <View style={styles.dot} />
                <Text style={styles.liText}>{t}</Text>
              </View>
            ))}
          </View>
        </Card>
      ) : null}
      <Muted style={styles.gap16}>{`From ${SOURCE.ai.from}${geo?.site ? ` · ${geo.site}` : ""}`}</Muted>
      <View style={styles.gap12}>
        <SmallButton full label="Ask Zavi to fix the biggest gap" onPress={() => onAsk("What is the biggest gap in my site's AI search readiness, and how do I fix it?")} />
      </View>
    </>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.wire.page },
  content: { paddingHorizontal: 16, paddingTop: 20 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  gap4: { marginTop: 4 },
  gap8: { marginTop: 8 },
  gap12: { marginTop: 12 },
  gap16: { marginTop: 16 },
  subhead: { marginTop: 20, marginBottom: 6 },
  center: { marginTop: 6, textAlign: "center" },
  table: { borderRadius: 16, borderWidth: 1, borderColor: colors.wire.line, backgroundColor: colors.surfaceRaised, overflow: "hidden" },
  tableHead: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 10, backgroundColor: colors.wire.head, gap: 12 },
  th: { fontFamily: font.family.medium, fontSize: 13, color: colors.wire.sub, textAlign: "right", minWidth: 64 },
  tr: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.wire.tint, gap: 12 },
  cellFirst: { flex: 1, textAlign: "left" },
  rowDense: { paddingHorizontal: 12, gap: 8 },
  numDense: { minWidth: 42 },
  td: { fontFamily: font.family.regular, fontSize: 13.5, color: colors.wire.sub },
  tdNum: { fontFamily: font.family.semi, fontSize: 13.5, color: colors.wire.text, textAlign: "right", minWidth: 64, fontVariant: ["tabular-nums"] },
  score: { fontFamily: font.family.semi, fontSize: 40, lineHeight: 44, color: colors.wire.text, fontVariant: ["tabular-nums"] },
  scoreOf: { fontFamily: font.family.regular, fontSize: 16, color: colors.wire.mute },
  word: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 },
  wordText: { fontFamily: font.family.semi, fontSize: 13 },
  list: { marginTop: 8, gap: 6 },
  li: { flexDirection: "row", gap: 8 },
  dot: { marginTop: 7, width: 5, height: 5, borderRadius: 3, backgroundColor: colors.wire.faint },
  liText: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.wire.mute },
});
