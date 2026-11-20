import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { BackIcon, Icon } from "../../../components/Icon";
import { ChannelActionCard } from "../../../components/channels/ChannelActionCard";
import { ChannelActionsSkeleton } from "../../../components/channels/ChannelStates";
import {
  ChannelHero,
  ChannelTabBar,
  ConnectStrip,
  NumbersCard,
  PlanCard,
  RunButton,
  RunLog,
  RunProgress,
} from "../../../components/channels/ChannelPageSections";
import { NextStepsSection } from "../../../components/channels/ChannelNextSteps";
import { KeyboardAvoider } from "../../../components/KeyboardAvoider";
import { OptionSheet } from "../../../components/OptionSheet";
import { useChannelToast, useSuccessToast } from "../../../components/channels/ChannelToast";
import { UgcHeaderButtons, UgcLane, UgcNumbers, useExtraCards } from "../../../components/channels/UgcHub";
import { ChannelSettings } from "../../../components/channels/ChannelSettings";
import { RedditNumbers, RedditScanControl } from "../../../components/channels/RedditPanel";
import { getChannel } from "@zavi/shared";
import { ScheduleChip } from "../../../components/reply/ScheduleChip";
import { ChecklistCard } from "../../../components/channels/Checklist";
import { xChecklist } from "../../../features/channels/xChecklist";
import { TopPostsCard } from "../../../components/channels/TopPosts";
import { topPostsTable } from "../../../features/channels/topPosts";
import { nextPick, pickTables } from "../../../features/channels/channelTables";
import { ChannelTableCard } from "../../../components/channels/ChannelTables";
import { geoTables } from "../../../features/channels/geoKpis";
import { apiFetch } from "../../../lib/api";
import { SeoHealthCard } from "../../../components/channels/SeoHealth";
import { SeoIssuesCard } from "../../../components/channels/SeoIssues";
import { channelAccount } from "../../../features/channels/channelAccount";
import { ZaviTextField } from "../../../components/ZaviTextField";
import { seoHealth, seoIssues, seoTables } from "../../../features/channels/seoKpis";
import { CampaignWorkspace } from "../../../components/channels/CampaignWorkspace";
import { asDashboard, CHATGPT_ADS_SLUG } from "../../../features/channels/managedCampaigns";
import { AdLocationsCard } from "../../../components/channels/AdLocations";
import { AD_LOCATION_SLUGS } from "../../../features/channels/adLocations";
import { GoogleAdsCampaigns, GoogleAdsControls, GoogleAdsPlan } from "../../../components/channels/GoogleAdsPanel";
import { fallbackMetrics, KPI_FALLBACK } from "../../../features/channels/kpiFallback";
import { useChannelDashboard, useRefreshChannelDashboard } from "../../../features/channels/dashboardHooks";
import { pickRange, rangeControls } from "../../../features/channels/dashboardRanges";
import { RangeControls } from "../../../components/channels/RangeControls";
import { DEFAULT_RANGE_ID, GADS_SLUG, kpisToMetrics, rangeFor } from "../../../features/channels/googleAds";
import { useGoogleAdsDashboard, useRefreshGoogleAds } from "../../../features/channels/googleAdsHooks";
import { UGC_SLUG } from "../../../features/channels/ugc";
import { REDDIT_SLUG, redditOff } from "../../../features/channels/reddit";
import { ACCOUNT_FIELD, settingsFor } from "../../../features/channels/settingsConfig";
import { useRedditDashboard, useRefreshReddit } from "../../../features/channels/redditHooks";
import { takePendingToast } from "../../../features/channels/pendingToast";
import { channelName } from "../../../features/channels/display";
import {
  useApproveAction,
  useChannelActions,
  useChannelHistory,
  useChannelList,
  useChannelKinds,
  useChannelMetrics,
  useChannelPlan,
  useDismissChannelAction,
  useRedoAction,
  useRunChannel,
} from "../../../features/channels/hooks";
import {
  cardKind,
  dismissOptions,
  emptyLine,
  metricTiles,
  nextStepsTitle,
  runCost,
  runLabel,
  runDrawer,
  zaviSetupNotice,
} from "../../../features/channels/channelPage";
import type { ChannelAction } from "../../../features/channels/types";
import { ApiFetchError } from "../../../lib/api";
import { CHANNELS_ENABLED } from "../../../lib/flags";
import { font, space, type Colors } from "../../../theme/tokens";
import { useStyles, useTheme } from "../../../theme/theme";

type TabKey = "overview" | "settings";

function errorMessage(error: unknown): string {
  return error instanceof ApiFetchError && error.message ? error.message : "Something went wrong. Try again.";
}

export default function ChannelActionsRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <ChannelActions />;
}

function ChannelActions() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const { slug = "" } = useLocalSearchParams<{ slug: string }>();
  const { show, toast } = useChannelToast();
  const { show: showSuccess, toast: successToast } = useSuccessToast();

  useFocusEffect(
    useCallback(() => {
      const m = takePendingToast();
      if (m) showSuccess(m);
    }, [showSuccess]),
  );
  const { items, markSeen, viewOf, isLoading: listLoading, refetch: refetchList } = useChannelList();
  const item = items.find((i) => i.slug === slug);
  const view = viewOf(slug);
  const { actions: allActions, isLoading, isError, refetch, ranked, zaviCount, done } = useChannelActions(slug, true);
  const planQ = useChannelPlan(slug);
  const plan = planQ.data ?? null;
  const actions = plan ? allActions.filter((a) => a.id !== plan.id) : allActions;
  const metricsQ = useChannelMetrics(slug);
  const working = view?.work_state === "running";
  const historyQ = useChannelHistory(slug, working);
  const runChannel = useRunChannel();
  const approveAction = useApproveAction();
  const redo = useRedoAction();
  const dismiss = useDismissChannelAction();
  const [starting, setStarting] = useState(false);
  const [completingIds, setCompletingIds] = useState<Set<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const name = item?.name ?? channelName(slug);
  const kinds = useChannelKinds(slug);
  const extra = useExtraCards(slug);
  const [tab, setTab] = useState<TabKey>("overview");
  const [dismissing, setDismissing] = useState<ChannelAction | null>(null);
  const dismissChoices = dismissOptions();
  const isReddit = slug === REDDIT_SLUG;
  const redditQ = useRedditDashboard(isReddit);
  const refreshReddit = useRefreshReddit();
  const isGads = slug === GADS_SLUG;
  const [gadsRangeId, setGadsRangeId] = useState(DEFAULT_RANGE_ID);
  const gadsRange = rangeFor(gadsRangeId);
  const gadsQ = useGoogleAdsDashboard(gadsRange.days, isGads);
  const refreshGads = useRefreshGoogleAds(gadsRange.days);
  const gads = isGads ? gadsQ.data : undefined;
  const hasFallback = !!KPI_FALLBACK[slug];
  const [picked, setPicked] = useState({ id: "30d", days: 30 });
  const dashQ = useChannelDashboard(slug, hasFallback, picked.days);
  const refreshDash = useRefreshChannelDashboard(slug, picked.days);
  const controls = rangeControls(slug, dashQ.data);
  const dashRange = pickRange(controls, picked.id);
  const redditSurfaceOff = !redditQ.data || redditOff(redditQ.data);

  useEffect(() => {
    if (!listLoading) markSeen(slug);
  }, [listLoading, markSeen, slug]);

  const changing = allActions.some((a) => a.execStatus === "queued" || a.execStatus === "dispatching");
  useEffect(() => {
    if (!working && !changing) return;
    const id = setInterval(() => {
      void refetch();
      void refetchList();
    }, 20_000);
    return () => clearInterval(id);
  }, [working, changing, refetch, refetchList]);

  function goBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/channels");
  }

  function refresh() {
    setRefreshing(true);
    void Promise.all([
      refetch(),
      refetchList(),
      metricsQ.refetch(),
      historyQ.refetch(),
      planQ.refetch(),
      isReddit ? refreshReddit().catch(() => {}) : null,
      isGads ? refreshGads().catch(() => {}) : null,
      hasFallback ? dashQ.refetch() : null,
    ]).finally(() =>
      setRefreshing(false),
    );
  }

  function run() {
    if (starting || working) return;
    setStarting(true);
    runChannel.mutate(slug, {
      onSuccess: () => {
        show("Started. This takes a few minutes; the actions land here when it finishes.");
        void refetchList();
        void historyQ.refetch();
      },
      onError: () => show("Zavi could not start this run."),
      onSettled: () => setStarting(false),
    });
  }

  function markComplete(action: ChannelAction) {
    const id = action.id;
    if (completingIds.has(id)) return;
    setCompletingIds((current) => new Set(current).add(id));
    approveAction.mutate(
      { id, source: action.action_source },
      {
        onSuccess: () => show("Marked done."),
        onError: (error) => show(errorMessage(error)),
        onSettled: () =>
          setCompletingIds((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          }),
      },
    );
  }

  function askDismiss(action: ChannelAction) {
    setDismissing(action);
  }

  function dismissWith(action: ChannelAction, o: ReturnType<typeof dismissOptions>[number]) {
    dismiss.mutate(
      { id: action.id, reason: { action: o.action, note: o.note, until: o.until } },
      {
        onSuccess: () =>
          show(
            o.action === "snoozed"
              ? "Hidden for now. It comes back on its own."
              : "Rejected. Zavi reads your reason the next time this channel runs.",
          ),
        onError: (error) => show(errorMessage(error)),
      },
    );
  }

  function changePlan(note: string): Promise<boolean> {
    if (!plan) return Promise.resolve(false);
    return redo
      .mutateAsync({ id: plan.id, message: note, source: "channel_action" })
      .then(() => {
        show("Zavi is writing a new plan with your note. It replaces this one when the run finishes.");
        return true;
      })
      .catch((error: unknown) => {
        show(errorMessage(error));
        return false;
      });
  }

  function renderAction(action: ChannelAction) {
    return (
      <ChannelActionCard
        action={action}
        busy={completingIds.has(action.id) || dismiss.isPending}
        onMarkComplete={() => markComplete(action)}
        onDismiss={action.action_source === "channel_action" ? () => askDismiss(action) : undefined}
        actionType={kinds[action.id]}
        onReview={() => router.push({ pathname: "/channels/[id]", params: { id: action.id } })}
      />
    );
  }

  const connected = view?.connected ?? false;
  const needsConnect = isReddit ? false : item?.needsConnect ?? false;
  const runs = historyQ.data?.runs ?? [];
  const lastRunFailed = !!runs[0] && !["success", "queued", "running", "blocked"].includes(runs[0].status);
  const runnable = item?.runnable ?? view?.runnable ?? true;
  const isUgc = slug === UGC_SLUG;
  const accountLinked = connected && (view?.connectors ?? []).length > 0 && !!ACCOUNT_FIELD[slug];
  const settingsFields = isReddit ? (redditSurfaceOff ? null : settingsFor(slug)) : settingsFor(slug, accountLinked);
  const hasSchedule = (connected || (view?.connectors ?? []).length === 0) && runnable !== false;
  const executor = getChannel(slug)?.executor ?? slug;
  const tabs: ReadonlyArray<readonly [TabKey, string]> = settingsFields || hasSchedule
    ? [["overview", "Overview"], ["settings", "Settings"]]
    : [["overview", "Overview"]];
  const active: TabKey = tabs.some(([k]) => k === tab) ? tab : "overview";
  const total = actions.length + extra.length;
  const showRun = !isLoading && !isError && total === 0;

  const emptyBody = isLoading ? (
    <ChannelActionsSkeleton />
  ) : isError ? (
    <Pressable
      style={styles.errorRow}
      onPress={() => void refetch()}
      accessibilityRole="button"
      accessibilityLabel="Couldn't load this channel. Retry"
    >
      <Text style={styles.bodyText}>
        Couldn't load this channel. <Text style={styles.retryText}>Retry</Text>
      </Text>
    </Pressable>
  ) : (
    <View>
      <Text style={styles.bodyText}>
        {working ? "Zavi is working on it." : emptyLine({ workState: view?.work_state ?? null, lastRunFailed })}
      </Text>
      {showRun ? (
        <RunButton
          run={{
            label: runLabel({ name, runnable, starting, working, ranBefore: runs.length > 0 }),
            cost: runCost(view?.run_reserve_credits),
            disabled: !runnable || starting || working,
            busy: starting,
            onPress: run,
          }}
        />
      ) : null}
    </View>
  );

  const topPosts = topPostsTable(slug, dashQ.data);
  const checklist = slug === "x_organic" ? xChecklist(dashQ.data) : null;
  const numberTiles = metricTiles(slug, metricsQ.data?.length ? metricsQ.data : isGads && gads ? kpisToMetrics(gads) : fallbackMetrics(slug, dashQ.data));
  const [pickedMetric, setPickedMetric] = useState<string | null | undefined>(undefined);
  const dataTables = slug === "seo" ? seoTables(dashQ.data) : slug === "geo" ? geoTables(dashQ.data) : [];
  const runRowAction = async (a: { call: { method: "POST" | "DELETE"; path: string; body?: unknown } }): Promise<string | null> => {
    try {
      const res = await apiFetch(a.call.path, { method: a.call.method, ...(a.call.body === undefined ? {} : { body: JSON.stringify(a.call.body) }), retryOnNetworkError: false });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        return body.error?.message ?? "That did not save. Try again.";
      }
      await dashQ.refetch();
      return null;
    } catch {
      return "That did not save. Try again.";
    }
  };
  const seoHealthData = slug === "seo" ? seoHealth(dashQ.data) : null;
  const seoIssuesData = slug === "seo" ? seoIssues(dashQ.data) : null;
  const pick = pickTables(
    slug,
    numberTiles.map((t) => t.key),
    [...dataTables.map((t) => t.id), ...(seoIssuesData ? ["seo_issues"] : [])],
    pickedMetric,
  );
  const gadsPacing = gads?.kpis.find((k) => k.key === "pacing")?.pacing ?? null;

  const overview = (
    <>
      {hasFallback ? (
        <RangeControls
          label={dashRange.label}
          ranges={controls.ranges}
          value={dashRange.id}
          pickable={controls.pickable}
          account={channelAccount(slug, dashQ.data)}
          onPick={(id) => setPicked({ id, days: controls.ranges.find((r) => r.id === id)?.days ?? 30 })}
          onRefresh={refreshDash}
        />
      ) : null}
      {seoHealthData ? <SeoHealthCard health={seoHealthData} /> : null}
      {AD_LOCATION_SLUGS.has(slug) ? <AdLocationsCard slug={slug} channelName={name} /> : null}
      {slug === CHATGPT_ADS_SLUG ? (
        <CampaignWorkspace dashboard={asDashboard(dashQ.data)} loading={dashQ.isLoading} days={picked.days} onChanged={() => void refreshDash()} />
      ) : isUgc ? (
        <UgcNumbers />
      ) : isReddit ? (
        redditOff(redditQ.data) ? null : (
          <RedditNumbers payload={redditQ.data} loading={redditQ.isLoading} onChanged={refreshReddit} />
        )
      ) : (
        <NumbersCard
          slug={slug}
          connectors={view?.connectors ?? []}
          tiles={numberTiles}
          selectable={pick.claimable}
          selectedKey={pick.selectedKey}
          onSelect={(key) => setPickedMetric(nextPick(slug, key, pick.selectedKey))}
          connected={connected}
          needsConnect={needsConnect}
          loading={metricsQ.isLoading || (!metricsQ.data?.length && ((isGads && gadsQ.isLoading) || (hasFallback && dashQ.isLoading)))}
        />
      )}
      {gads?.connected && gadsPacing ? (
        <GoogleAdsPlan key={gadsPacing.plan ?? "none"} pacing={gadsPacing} onSaved={refreshGads} />
      ) : null}
      {gads?.connected && gads.kpis.length > 0 ? <GoogleAdsCampaigns payload={gads} /> : null}
      {topPosts ? <TopPostsCard table={topPosts} /> : null}
      {checklist ? <ChecklistCard title="Profile checklist" checklist={checklist} /> : null}
      {slug === "seo" && seoIssuesData && pick.visible("seo_issues") ? <SeoIssuesCard issues={seoIssuesData} /> : null}
      {}
      {[...dataTables.filter((t) => t.id === pick.selectedTable), ...dataTables.filter((t) => t.id !== pick.selectedTable && pick.visible(t.id))].map((t) => (
        <ChannelTableCard key={t.id} table={t} onRun={runRowAction} />
      ))}
      <RunProgress working={working} waiting={actions.length} />
      {plan ? <PlanCard name={name} plan={plan} busy={redo.isPending} onChange={changePlan} /> : null}
      {zaviSetupNotice(zaviCount) ? <Text style={[styles.bodyText, styles.notice]}>{zaviSetupNotice(zaviCount)}</Text> : null}
      {isError && total > 0 ? (
        <Pressable onPress={() => void refetch()} accessibilityRole="button" style={styles.notice}>
          <Text style={styles.bodyText}>
            Couldn't refresh just now. <Text style={styles.retryText}>Retry</Text>
          </Text>
        </Pressable>
      ) : null}
      <NextStepsSection
        title={nextStepsTitle(slug)}
        grouped={ranked}
        extra={extra}
        extraPosition={isUgc ? "before" : "after"}
        actions={actions}
        kindOf={(a) => cardKind(kinds[a.id], a.intent)}
        renderAction={renderAction}
        empty={emptyBody}
      />
      {done.length > 0 ? (
        <View style={styles.notice}>
          <Text style={styles.doneTitle} accessibilityRole="header">Done</Text>
          {done.map((a) => (
            <ChannelActionCard key={a.id} action={a} actionType={kinds[a.id]} done busy={false} onMarkComplete={() => undefined} onReview={() => undefined} />
          ))}
        </View>
      ) : null}
      {isUgc ? <UgcLane /> : null}
      <RunLog drawer={runDrawer(historyQ.data, channelName)} />
    </>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.topBar}>
        <Pressable
          style={styles.headerButton}
          onPress={goBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back to channels"
        >
          <BackIcon color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {name}
        </Text>
        <View style={styles.headerButton} />
      </View>

      <KeyboardAvoider style={styles.body}>
        <ScrollView
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} colors={[colors.ink]} progressBackgroundColor={colors.surfaceRaised} />
          }
        >
          <ChannelHero slug={slug} name={name} />
          {needsConnect ? (
            <ConnectStrip
              slug={slug}
              name={name}
              connectors={view?.connectors ?? []}
              onAttempted={() => {
                void refetchList();
                void metricsQ.refetch();
              }}
            />
          ) : null}
          <ChannelTabBar tabs={tabs} active={active} onSelect={setTab} count={total} />
          {isUgc ? <UgcHeaderButtons /> : null}
          {isGads && active === "overview" ? (
            <GoogleAdsControls
              payload={gads}
              range={gadsRange}
              onRange={setGadsRangeId}
              onRefresh={refreshGads}
              onReconnected={() => {
                void refetchList();
                void refreshGads().catch(() => {});
              }}
            />
          ) : null}
          {isReddit ? <RedditScanControl payload={redditQ.data} surfaceOff={redditOff(redditQ.data)} onRefresh={refreshReddit} /> : null}
          {active === "settings" ? (
            <>
              {}
              {accountLinked ? (
                <ZaviTextField
                  title="Connected account"
                  value={channelAccount(slug, dashQ.data)?.name ?? ""}
                  placeholder={hasFallback ? "Shows after the first read" : `${name} account connected`}
                  editable={false}
                  multiline={false}
                  containerStyle={styles.connectedAccount}
                />
              ) : null}
              {settingsFields ? (
                <ChannelSettings slug={slug} fields={settingsFields} onSaved={() => showSuccess("Settings saved. Applies on the next run.")} />
              ) : null}
              {hasSchedule ? (
                <View style={styles.scheduleBlock}>
                  <Text style={styles.scheduleTitle}>Schedule</Text>
                  <ScheduleChip slug={executor} flush />
                </View>
              ) : null}
            </>
          ) : (
            overview
          )}
        </ScrollView>
      </KeyboardAvoider>
      <OptionSheet
        open={!!dismissing}
        title="Dismiss: why?"
        message="Zavi uses your answer to improve."
        options={dismissChoices.map((o, i) => ({ value: i, label: o.label }))}
        value={-1}
        onPick={(i) => dismissing && dismissWith(dismissing, dismissChoices[i])}
        onClose={() => setDismissing(null)}
      />
      {toast}
      {successToast}
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  connectedAccount: { marginTop: space.md },
  scheduleBlock: { marginTop: space.lg, marginBottom: space.xl * 2, gap: space.xs },
  scheduleTitle: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
  topBar: {
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
    includeFontPadding: false,
    color: colors.ink,
  },
  body: { flex: 1 },
  listContent: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20 },
  bodyText: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 12, lineHeight: 18, color: colors.muted },
  errorRow: { minHeight: 44, justifyContent: "center" },
  emptyText: { marginTop: 10, fontSize: 13, lineHeight: 19 },
  retryText: { includeFontPadding: false, fontFamily: font.family.semi, color: colors.ink },
  notice: { marginTop: space.md },
  doneTitle: { fontFamily: font.family.semi, fontSize: 17, letterSpacing: -0.2, color: colors.ink },
});
