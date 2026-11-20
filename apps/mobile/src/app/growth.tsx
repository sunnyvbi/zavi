import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useIsFocused, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { CHANNELS } from "@zavi/shared";
import { Screen } from "../components/Screen";
import { BackHeader, PrimaryButton } from "../components/settings/SettingsUI";
import { Icon } from "../components/Icon";
import { AlertLine, Bars, StatusChip, StoryBecause, StoryStep, TextLink } from "../components/growth/StoryKit";
import { DoingStepBody, GoalsStepBody, HappenedStepBody, NeedsStepBody, WayStepBody } from "../components/growth/StorySteps";
import { KnowledgeSheet, type DataRows } from "../components/growth/KnowledgeSheet";
import { GoalEditorSheet } from "../components/growth/GoalEditorSheet";
import { NoteSheet } from "../components/growth/NoteSheet";
import { channelName as registryName } from "../features/channels/display";
import { useCompanyFacts, useMyRole } from "../features/settings/api";
import { usePersonalization } from "../features/personalization/usePersonalization";
import { buildConnections, type Connection } from "../features/connectors/health";
import { connectorUses } from "../features/connectors/catalog";
import { isZaviManagedGithubLogin } from "../features/connectors/connectPlan";
import { useConnections } from "../features/connectors/useConnections";
import { useWorkspace } from "../features/workspaces/WorkspaceProvider";
import {
  useBrandKit,
  useGoalHistories,
  useGrowthPlan,
  useGrowthQuestions,
  useGrowthWork,
  useKeptConstraints,
  useLiveGoalValues,
  useMarkPlanOpened,
  usePlanWatch,
  useSetChannelAutorun,
  useSetupState,
  useYouAsked,
} from "../features/growth/hooks";
import {
  EDIT_ACTIONS,
  LOADING,
  SETUP_KINDS,
  activeGoals,
  bareSlug,
  connectedSources,
  goalFix,
  growthHeadline,
  growthPending,
  hasLivePlan,
  humanize,
  measurementNeed,
  planChannels,
  shortDate,
  splitCompetitors,
  withLiveValue,
  type GrowthGoal,
  type GrowthPlan,
  type HeadlineAction,
  type MeasurementNeed,
  type ReadyHeadline,
} from "../features/growth/plan";
import { goalCountLabel, goalPill, goalStatusLine, weekMomentum, type GoalPill } from "../features/growth/story";
import { leftForYou, needsModel, waitingMoves, type Answered } from "../features/growth/needs";
import { companyName as briefName, connectorLabel, suggestedConnectors } from "../features/growth/knowledge";
import { noteLinkTarget } from "../features/growth/note";
import { growthAccess } from "../features/growth/access";
import { track } from "../lib/analytics";
import { firstThisDevice } from "../lib/analyticsCore";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

const CHANNEL_SLUGS: ReadonlySet<string> = new Set(CHANNELS.map((c) => c.slug));
const CGO_RUN_SLUGS: ReadonlySet<string> = new Set(
  CHANNELS.filter((c) => (c.category === "organic" || c.category === "owned") && !c.slug.endsWith("_ads")).map((c) => c.slug),
);
const SPEND_TOOL = /_propose_(?:budget_change|new_campaign|new_ad_set|video_campaign)$/;
const SEND_TOOLS = new Set(["email_send", "outbound__propose_email"]);
const RISK_BY_SLUG: ReadonlyMap<string, string> = new Map(
  CHANNELS.flatMap((c): Array<[string, string]> =>
    c.tools.some((t: string) => SPEND_TOOL.test(t))
      ? [[c.slug, "spend money"]]
      : c.tools.some((t: string) => SEND_TOOLS.has(t))
        ? [[c.slug, "send to your customers"]]
        : [],
  ),
);
const CHAT_SURFACES = new Set(["whatsapp", "telegram", "discord", "teams", "msteams", "microsoft_teams"]);
const BUILDING_LINE = "Building your growth strategy. This takes 2–5 minutes; this page updates automatically.";
const GROWTH_OFFICER_SLUG = "cgo";
const READ_ACTIONS: ReadonlySet<HeadlineAction["kind"]> = new Set(["review", "ask", "recheck", "add_goal", "enter_number", "set_voice"]);

const nameOf = (slug: string) => {
  const n = registryName(slug);
  return n === slug ? humanize(slug) : n;
};

export default function Growth() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const storyY = useRef(0);
  const needsY = useRef(0);

  const role = useMyRole();
  const access = growthAccess(role);
  const { tenants, activeTenantId } = useWorkspace();
  const workspaceName = tenants.find((t) => t.tenant_id === activeTenantId)?.display_name ?? null;

  const setupQ = useSetupState();
  const setup = setupQ.data && setupQ.data.enabled ? setupQ.data : null;
  const oneState = setup?.one_state === true;
  const setupRunning = oneState && setup?.draft.status === "running";

  const fastPoll = useRef(false);
  const planQ = useGrowthPlan(fastPoll);
  const plan = planQ.data ?? null;
  const watch = usePlanWatch(plan);
  fastPoll.current = watch.drafting || setupRunning;
  const planAt = planQ.dataUpdatedAt;

  const watchedRun = useRef<string | null>(null);
  const draftRun = setup?.draft.status === "running" ? setup.draft.run_id : null;
  const draftSettled = setup?.draft.status === "done" || setup?.draft.status === "failed";
  const { watch: startWatch, stop: stopWatch } = watch;
  const refetchPlan = planQ.refetch;
  useEffect(() => {
    if (!draftRun || watchedRun.current === draftRun) return;
    watchedRun.current = draftRun;
    startWatch();
    void refetchPlan();
  }, [draftRun, startWatch, refetchPlan]);
  useEffect(() => {
    if (!oneState || !watch.drafting || !draftSettled || !watchedRun.current) return;
    stopWatch();
    void refetchPlan();
  }, [oneState, watch.drafting, draftSettled, stopWatch, refetchPlan]);
  const hasPlan = !!plan?.plan;
  useMarkPlanOpened(hasPlan);
  const focused = useIsFocused();
  useEffect(() => {
    if (!hasPlan || !activeTenantId || !focused) return;
    void firstThisDevice(AsyncStorage, `zavi_first_result:${activeTenantId}`).then((first) => {
      if (first) track("first_result_seen", { kind: "growth_plan" });
    });
  }, [hasPlan, activeTenantId, focused]);

  const { approvals: approvalsQ, channels: channelsQ } = useGrowthWork(planAt);
  const questionsQ = useGrowthQuestions();
  const [answeredQ, setAnsweredQ] = useState<Record<string, Answered>>({});
  const onAnswered = useCallback((id: string, a: Answered) => setAnsweredQ((m) => ({ ...m, [id]: a })), []);
  const asked = useYouAsked(planAt);
  const factsQ = useCompanyFacts();
  const personalizationQ = usePersonalization();
  const kitQ = useBrandKit();
  const connectionsQ = useConnections();
  const { kept, keep, failed: keepFailed, pending: keepPending } = useKeptConstraints();

  const autorunMutation = useSetChannelAutorun();

  const [knowOpen, setKnowOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [voiceEdit, setVoiceEdit] = useState(false);
  const [editing, setEditing] = useState<{ goal: GrowthGoal } | { create: string | undefined } | null>(null);

  const connected: string[] | null | undefined = connectionsQ.data
    ? connectionsQ.data.rows.map((r) => r.slug)
    : connectionsQ.isError
      ? null
      : undefined;

  const goalsUnreadable = !plan || plan.unreadable.includes("goals");
  const ranked = useMemo(() => (plan && !plan.unreadable.includes("goals") ? activeGoals(plan) : []), [plan]);
  const live = useLiveGoalValues(ranked, planAt);
  const liveGoals = ranked.map((g) => withLiveValue(g, live));
  const fixOf = new Map(ranked.map((g) => [g.id, goalFix(g, live, connected)] as const));
  const measuredGoals = liveGoals.filter((g) => {
    const f = fixOf.get(g.id);
    return f !== undefined && f !== LOADING && f !== null && f.kind === "none";
  });
  const histories = useGoalHistories(measuredGoals);
  const pillOf = new Map(liveGoals.map((g) => [g.id, goalPill(g, fixOf.get(g.id) ?? null, histories.reads.get(g.id))] as const));
  const pillsSettled = goalsUnreadable || Array.from(pillOf.values()).every((p) => p !== LOADING);
  const settledPills = new Map<string, GoalPill | null>(Array.from(pillOf.entries()).map(([id, p]) => [id, p === LOADING ? null : p]));
  const settledFixes = new Map<string, MeasurementNeed | null>(Array.from(fixOf.entries()).map(([id, f]) => [id, f === LOADING ? null : f]));

  const workSettled = !approvalsQ.isPending && !channelsQ.isPending;
  const pending = approvalsQ.data ? growthPending(approvalsQ.data, CHANNEL_SLUGS) : null;
  const runningKnown = !!channelsQ.data;
  const running = new Set((channelsQ.data?.channels ?? []).filter((c) => c.work_state === "running").map((c) => c.channel_slug));
  const inPlan = plan ? planChannels(plan, nameOf) : [];
  const rivals = splitCompetitors(factsQ.data?.competitors ?? "");

  const computed = plan
    ? growthHeadline({
        pending: !workSettled ? LOADING : pending?.total ?? null,
        pendingCapped: pending?.capped ?? false,
        activeGoals: goalsUnreadable ? null : ranked.length,
        measurement: goalsUnreadable ? null : measurementNeed(ranked, live, connected),
        channels: plan.unreadable.includes("channels")
          ? null
          : !workSettled
            ? LOADING
            : !runningKnown
              ? null
              : inPlan.map((c) => ({ slug: c.slug, name: nameOf(c.slug), ranAt: c.last_run_at, running: running.has(c.slug) })),
        rivals: factsQ.isPending ? LOADING : factsQ.isError ? null : rivals.length,
        brandVoiceSet: personalizationQ.isError
          ? null
          : personalizationQ.data
            ? (personalizationQ.data.brand_voice ?? "").trim().length > 0
            : personalizationQ.isPending
              ? LOADING
              : null,
        noGoalFirst: oneState,
      })
    : ({ kind: "loading" } as const);

  const lastStatus = useRef<string | null>(null);
  if (plan && pillsSettled && !goalsUnreadable) lastStatus.current = goalStatusLine(liveGoals.map((g) => settledPills.get(g.id) ?? null));
  const lastSettled = useRef<ReadyHeadline | null>(null);
  if (computed.kind !== "loading") lastSettled.current = computed;
  const settled = computed.kind === "loading" ? lastSettled.current : computed;
  const headline: ReadyHeadline = settled ?? { kind: "unknown", text: "", action: { kind: "recheck", label: "" } };
  const setupStep = SETUP_KINDS.has(headline.kind);
  const statusText = setupStep ? null : lastStatus.current;
  const headlineLoading = settled === null || (!setupStep && !goalsUnreadable && lastStatus.current === null && !pillsSettled);

  const hogUnreadable = !plan || plan.unreadable.includes("head_of_growth");
  const left = plan ? leftForYou(plan) : { rows: [], label: "Left for you", more: null };
  const waiting = plan ? waitingMoves(plan) : [];
  const questions = questionsQ.data?.questions ?? [];
  const openQuestions = questions.filter((q) => !answeredQ[q.id]).length;
  const countless = oneState && ranked.length === 0 && !goalsUnreadable;
  const needs = needsModel({
    questions: {
      state: questionsQ.isPending ? "loading" : questionsQ.isError ? "failed" : "ready",
      open: openQuestions,
      listed: questions.length,
    },
    pending,
    approvalsSettled: workSettled,
    goalWorkUnreadable: !plan || plan.unreadable.includes("goal_work"),
    hogUnreadable,
    left: left.rows.length,
    more: left.more?.count ?? 0,
    waitingMoves: waiting.length,
    countless,
  });

  const sources: Connection[] | null = useMemo(() => {
    const data = connectionsQ.data;
    if (!data) return null;
    const rows = data.rows.filter(
      (r) => !CHAT_SURFACES.has(bareSlug(r.slug)) && !(oneState && r.slug === "github" && isZaviManagedGithubLogin(r.account_login)),
    );
    return buildConnections({
      rows,
      suggested: [],
      labelFor: connectorLabel,
      usedByFor: connectorUses,
      slackMissing: data.slackMissing,
      lastSync: data.lastSync,
      now: Date.now(),
    });
  }, [connectionsQ.data, oneState]);
  const notSyncing = sources ? sources.filter((c) => c.health === "reconnect" || c.health === "stale").length : 0;
  const anyMeasured = !!plan && !plan.unreadable.includes("metrics") && plan.metrics.some((m) => m.status === "measured" && m.value !== null);
  const dataRows: DataRows = {
    loading: connectionsQ.isPending,
    sources: connectionsQ.isError ? null : sources,
    suggested: connectionsQ.data ? suggestedConnectors(connectionsQ.data.recommended, connectedSources(connectionsQ.data.rows)) : [],
    gaConnected: (connected ?? []).some((s) => bareSlug(s) === "google_analytics"),
    anyMeasured,
  };

  const planReady = !!plan?.plan && !plan.unreadable.includes("plan");
  const draftFailed = !!setup?.done && setup.draft.status === "failed" && setup.draft.can_retry;
  const drafting = watch.drafting || setupRunning;
  const building = !planReady && !watch.draftSlow && !draftFailed && (watch.drafting || setup?.draft.status === "running");

  const ask = (text: string) => router.push({ pathname: "/chat", params: { slug: GROWTH_OFFICER_SLUG, prefill: text, back: "1" } });
  const openChat = () => router.push({ pathname: "/chat", params: { slug: GROWTH_OFFICER_SLUG, back: "1" } });
  const scrollToNeeds = () =>
    scrollRef.current?.scrollTo({ y: Math.max(0, storyY.current + needsY.current - space.lg), animated: true });
  const openLink = (url: string) => {
    const target = noteLinkTarget(url);
    if (target.kind === "channel") {
      setNoteOpen(false);
      if (target.action) router.push({ pathname: "/channels/[id]", params: { id: target.action } });
      else router.push({ pathname: "/channels/actions/[slug]", params: { slug: target.slug } });
    } else {
      void WebBrowser.openBrowserAsync(target.url);
    }
  };
  const openUrl = (url: string) => void WebBrowser.openBrowserAsync(url);
  const toggleAutorun = (slug: string, next: boolean) => {
    autorunMutation.mutate(
      { slug, autorun: next },
      {
        onSuccess: () => {
          if (next) track("growth_autorun_started");
        },
      },
    );
  };

  const refreshAll = async () => {
    live.refetchAll();
    histories.refetchAll();
    await Promise.allSettled([
      planQ.refetch(),
      approvalsQ.refetch(),
      channelsQ.refetch(),
      questionsQ.refetch(),
      factsQ.refetch(),
      personalizationQ.refetch(),
      kitQ.refetch(),
      connectionsQ.refetch(),
      setupQ.refetch(),
    ]);
  };

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    await refreshAll();
    setRefreshing(false);
  };

  const act = (action: HeadlineAction) => {
    if (action.kind === "review") scrollToNeeds();
    else if (action.kind === "ask") ask(action.question);
    else if (action.kind === "recheck") void refreshAll();
    else if (action.kind === "set_voice") {
      setVoiceEdit(true);
      setKnowOpen(true);
    } else if (action.kind === "add_goal") setEditing({ create: undefined });
    else if (action.kind === "enter_number") {
      const goal = liveGoals.find((g) => g.id === action.goalId);
      if (goal) setEditing({ goal });
    }
  };
  const showAction =
    setupStep && READ_ACTIONS.has(headline.action.kind) && (!EDIT_ACTIONS.has(headline.action.kind) || access.canEdit);

  const company = briefName(factsQ.data?.company_name, workspaceName);
  const hogNote = plan?.head_of_growth.note ?? null;
  const nextCheckIn = hogNote?.next_review_at ? shortDate(hogNote.next_review_at) : null;

  return (
    <Screen>
      <BackHeader title="Your CGO" />
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} progressBackgroundColor={colors.surfaceRaised} colors={[colors.ink]} />
        }
      >
        {planQ.isPending ? (
          <PageSkeleton />
        ) : !plan ? (
          <View style={styles.errorBox} accessibilityRole="alert">
            <Text style={styles.errorTitle}>Could not load your growth plan</Text>
            <Text style={styles.meta}>
              {planQ.error && "status" in planQ.error
                ? `Couldn't load your plan (HTTP ${(planQ.error as { status: number }).status}).`
                : "Couldn't load your plan."}
            </Text>
            <PrimaryButton label="Try again" onPress={() => void planQ.refetch()} />
          </View>
        ) : (
          <>
            <Banners
              plan={plan}
              drafting={drafting}
              draftSlow={watch.draftSlow && !planReady}
              draftFailed={draftFailed && !drafting}
              retryCharged={draftFailed && !setup?.draft.free_retry}
              onRetry={() => void planQ.refetch()}
            />

            {}
            <View style={styles.brief} accessibilityLabel="Growth brief">
              <Text style={styles.eyebrow} numberOfLines={1}>{`Growth brief for ${company} · from Zavi`.toUpperCase()}</Text>
              {headlineLoading ? (
                <View style={styles.headlineSkeleton}>
                  <Bars label="Checking what needs you" lines={2} height={22} />
                </View>
              ) : (
                <Text style={styles.headline} accessibilityRole="header">
                  {statusText ?? headline.text}
                </Text>
              )}
              {nextCheckIn || hogNote ? (
                <View style={styles.subLine}>
                  {nextCheckIn ? <Text style={styles.subText}>{`Next check-in ${nextCheckIn}${hogNote ? " ·" : ""}`}</Text> : null}
                  {hogNote ? <TextLink label="Read the full note" onPress={() => setNoteOpen(true)} /> : null}
                </View>
              ) : null}
              {needs.showPill ? (
                <Pressable
                  onPress={scrollToNeeds}
                  style={({ pressed }) => [styles.needPill, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={`${needs.count} need you. Jump to What needs you`}
                >
                  <View style={styles.needCount}>
                    <Text style={styles.needCountText}>{needs.count}</Text>
                  </View>
                  <Text style={styles.needPillText}>need you ↓</Text>
                </Pressable>
              ) : null}
              {!headlineLoading && showAction ? (
                <View style={styles.action}>
                  <PrimaryButton label={headline.action.label} onPress={() => act(headline.action)} />
                </View>
              ) : null}
            </View>

            <View style={styles.story} onLayout={(e) => (storyY.current = e.nativeEvent.layout.y)}>
              <StoryStep n={1} title="Your goals" aside={goalsUnreadable ? undefined : goalCountLabel(ranked.length)}>
                {building && ranked.length === 0 && !goalsUnreadable ? (
                  <Bars label="Setting your goals" lines={2} height={18} />
                ) : !pillsSettled ? (
                  <Bars label="Loading your goals" lines={2} height={18} />
                ) : (
                  <GoalsStepBody
                    plan={plan}
                    goals={liveGoals}
                    pills={settledPills}
                    fixes={settledFixes}
                    unavailable={goalsUnreadable}
                    canEdit={access.canEdit}
                    onEdit={(goal) => setEditing({ goal })}
                    onCreate={(objective) => setEditing({ create: objective })}
                  />
                )}
              </StoryStep>

              <StoryBecause>held back by…</StoryBecause>

              <StoryStep
                n={2}
                title="What's in the way"
                aside={
                  plan.plan?.constraint_statement?.trim() && !plan.unreadable.includes("plan") ? (
                    <TextLink
                      label="Ask Zavi why"
                      onPress={() =>
                        ask(`You think "${plan.plan!.constraint_statement!.trim()}". How sure are you, and what would change your mind?`)
                      }
                    />
                  ) : undefined
                }
              >
                {building && !plan.plan?.constraint_statement?.trim() && !plan.unreadable.includes("plan") ? (
                  <Bars label="Working out what's in the way" lines={2} height={18} />
                ) : (
                  <WayStepBody plan={plan} goals={ranked} building={building} kept={kept} onKeep={(id) => void keep(id)} keepFailed={keepFailed} keepPending={keepPending} canEdit={access.canEdit} onAsk={ask} />
                )}
              </StoryStep>

              <StoryBecause>so Zavi is…</StoryBecause>

              <StoryStep n={3} title="What Zavi is doing">
                {building && inPlan.length === 0 && !plan.unreadable.includes("channels") ? (
                  <Bars label="Picking your channels" lines={3} height={18} />
                ) : !plan.unreadable.includes("channels") && !workSettled ? (
                  <Bars label="Loading your channels" lines={3} height={18} />
                ) : (
                  <DoingStepBody
                    plan={plan}
                    inPlan={inPlan}
                    nameOf={nameOf}
                    cgoRunSlugs={CGO_RUN_SLUGS}
                    riskBySlugs={RISK_BY_SLUG}
                    hogUnavailable={hogUnreadable}
                    canAutopilot={access.canAutopilot}
                    canEdit={access.canEdit}
                    hasLivePlan={hasLivePlan(plan)}
                    autorunSaving={autorunMutation.isPending}
                    onAsk={ask}
                    onToggleAutorun={toggleAutorun}
                  />
                )}
              </StoryStep>

              <StoryBecause>so far…</StoryBecause>

              <StoryStep n={4} title="What happened" aside={plan.unreadable.includes("goal_work") ? undefined : <HappenedAside plan={plan} />}>
                <HappenedStepBody plan={plan} asked={asked} />
              </StoryStep>

              <StoryBecause>to keep going, it needs you…</StoryBecause>

              <StoryStep n={5} title="What needs you" needs aside={needs.aside ?? undefined} onLayoutY={(y) => (needsY.current = y)}>
                <NeedsStepBody
                  needs={needs}
                  questions={questions}
                  left={left.rows}
                  leftLabel={left.label}
                  more={left.more}
                  waiting={waiting}
                  canDecide={access.canDecide}
                  canAnswer={questionsQ.data?.canAnswer ?? false}
                  answered={answeredQ}
                  onAnswered={onAnswered}
                  onRetry={() => void refreshAll()}
                  onOpenLink={openLink}
                  onOpenReview={() => router.push("/growth-review")}
                />
              </StoryStep>
            </View>

            {}
            <View style={styles.footer}>
              <TextLink label="Business results and experiment controls (web)" onPress={() => openUrl("https://www.zaviagent.com/workspace?tab=growth-strategy#business-controls")} />
              <TextLink label="What Zavi knows about you" onPress={() => setKnowOpen(true)} />
              <Text style={styles.subText}>· Company, rivals, data, brand voice</Text>
              {notSyncing > 0 ? (
                <View style={styles.warnPill}>
                  <Text style={styles.warnPillText}>{`${notSyncing} not syncing`}</Text>
                </View>
              ) : null}
            </View>
          </>
        )}
      </ScrollView>

      <Pressable
        onPress={openChat}
        style={({ pressed }) => [styles.fab, { bottom: insets.bottom + space.lg }, pressed && styles.fabPressed]}
        accessibilityRole="button"
        accessibilityLabel="Chat with Zavi about your growth"
      >
        <Icon name="messageSquare" size={22} color={colors.onInk} />
      </Pressable>

      {editing && access.canEdit ? (
        <GoalEditorSheet
          key={"goal" in editing ? editing.goal.id : "new"}
          goal={"goal" in editing ? editing.goal : null}
          initialObjective={"create" in editing ? editing.create : undefined}
          onClose={() => setEditing(null)}
          onAsk={(text) => {
            setEditing(null);
            ask(text);
          }}
        />
      ) : null}

      {plan ? (
        <>
          <KnowledgeSheet
            open={knowOpen}
            onClose={() => {
              setKnowOpen(false);
              setVoiceEdit(false);
            }}
            canEdit={access.canEdit}
            startEditingVoice={voiceEdit}
            facts={
              factsQ.data
                ? {
                    company_name: factsQ.data.company_name,
                    what_we_sell: factsQ.data.what_we_sell,
                    domain: factsQ.data.domain,
                    competitors: rivals,
                  }
                : null
            }
            factsState={factsQ.isPending ? "loading" : factsQ.isError ? "failed" : "ready"}
            workspaceName={workspaceName}
            detail={plan.detail}
            data={dataRows}
            voice={personalizationQ.data ?? null}
            voiceState={personalizationQ.isPending ? "loading" : personalizationQ.isError ? "failed" : "ready"}
            kit={kitQ.data ?? null}
            onRetryFacts={() => void factsQ.refetch()}
            onOpenConnectors={() => {
              setKnowOpen(false);
              router.push("/toolkit");
            }}
            onOpenUrl={openUrl}
          />
          <NoteSheet open={noteOpen} onClose={() => setNoteOpen(false)} plan={plan} canClaim={access.canEdit} nameOf={nameOf} onOpenLink={openLink} />
        </>
      ) : null}
    </Screen>
  );
}

function Banners({
  plan,
  drafting,
  draftSlow,
  draftFailed,
  retryCharged,
  onRetry,
}: {
  plan: GrowthPlan;
  drafting: boolean;
  draftSlow: boolean;
  draftFailed: boolean;
  retryCharged: boolean;
  onRetry: () => void;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.banners}>
      {plan.unreadable.length > 0 ? (
        <View style={styles.banner}>
          <AlertLine right={<TextLink label="Retry" onPress={onRetry} />}>
            {`Could not load ${plan.unreadable.map(humanize).join(", ")}. Missing data is unknown.`}
          </AlertLine>
        </View>
      ) : null}
      {drafting ? (
        <Text style={styles.meta} accessibilityLiveRegion="polite">
          {BUILDING_LINE}
        </Text>
      ) : null}
      {draftSlow ? (
        <Text style={styles.meta} accessibilityLiveRegion="polite">
          Your growth strategy is taking longer than usual. Reload this page in a few minutes to check again.
        </Text>
      ) : null}
      {draftFailed ? (
        <View style={styles.banner}>
          <AlertLine>Something went wrong cooking your strategy</AlertLine>
          {retryCharged ? <Text style={styles.meta}>This try uses your credits.</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function HappenedAside({ plan }: { plan: GrowthPlan }) {
  const styles = useStyles(makeStyles);
  const momentum = weekMomentum(plan.goal_work);
  if (momentum.length === 0) return null;
  return (
    <View style={styles.asideRow} accessibilityLabel="Last 7 days">
      <Text style={styles.subText}>Last 7 days ·</Text>
      {momentum.map((m) => (
        <StatusChip key={m.label} tone={m.tone}>
          {m.label}
        </StatusChip>
      ))}
    </View>
  );
}

function PageSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.skeleton} accessible accessibilityLabel="Loading your growth plan" accessibilityState={{ busy: true }}>
      <Bars label="Loading your growth plan" lines={1} height={12} />
      <Bars label="Loading your growth plan" lines={2} height={24} />
      {[1, 2, 3, 4, 5].map((n) => (
        <View key={n} style={styles.skeletonStep}>
          <Bars label={`Loading step ${n}`} lines={1} height={16} />
          <Bars label={`Loading step ${n}`} lines={2} height={40} />
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    content: { paddingHorizontal: space.lg, paddingTop: 20 },
    banners: { gap: space.sm },
    banner: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.md, paddingVertical: 10, gap: 4 },
    brief: { marginTop: space.sm, gap: 6 },
    eyebrow: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.muted, letterSpacing: 0.3 },
    headline: { fontFamily: font.family.semi, fontSize: 24, lineHeight: 30, includeFontPadding: false, color: colors.ink },
    headlineSkeleton: { paddingVertical: 4 },
    subLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 6 },
    subText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    needPill: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      marginTop: 6,
      borderRadius: radius.pill,
      backgroundColor: colors.ink,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    needCount: { borderRadius: radius.pill, backgroundColor: colors.onInk, paddingHorizontal: 7, paddingVertical: 1 },
    needCountText: { fontFamily: font.family.bold, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.ink },
    needPillText: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.onInk },
    action: { marginTop: space.md, alignSelf: "flex-start", minWidth: 180 },
    story: { marginTop: space.xl },
    footer: {
      marginTop: space.xl,
      paddingTop: space.lg,
      borderTopWidth: 1,
      borderTopColor: colors.line,
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "baseline",
      gap: 6,
    },
    warnPill: { borderRadius: radius.pill, backgroundColor: colors.status.amberBg, paddingHorizontal: 8, paddingVertical: 2 },
    warnPillText: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.status.amberText },
    asideRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
    meta: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    errorBox: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.sm, marginTop: space.md },
    errorTitle: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, includeFontPadding: false, color: colors.ink },
    pressed: { opacity: 0.8 },
    fab: {
      position: "absolute",
      right: space.lg,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.ink,
      alignItems: "center",
      justifyContent: "center",
      elevation: 4,
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
    },
    fabPressed: { opacity: 0.8 },
    skeleton: { gap: space.lg, marginTop: space.sm },
    skeletonStep: { gap: space.sm, marginTop: space.md },
  });
