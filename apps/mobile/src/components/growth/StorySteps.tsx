import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ChannelWork, GoalHypothesis, GoalMove, GrowthBet, GrowthChannel, GrowthGoal, GrowthPlan, MeasurementNeed } from "../../features/growth/plan";
import { CONFIDENCE_LABEL, goalTitle, humanize } from "../../features/growth/plan";
import {
  HAPPENED_SHOWN,
  HYP_LABEL,
  HYP_TONE,
  STATE_LABEL,
  STATE_TONE,
  answerLines,
  askAboutChannel,
  askChangeConstraint,
  bestGuess,
  conflictFor,
  goalBarPercent,
  goalDueLabel,
  goalMeta,
  goalSuggestions,
  happenedMoves,
  ideasLine,
  keptConflictFor,
  keptDay,
  replacementGuess,
  suggestedGoal,
  unstop,
  updatePlanMessage,
  type GoalPill,
  type YouAsked,
} from "../../features/growth/story";
import { capLine } from "../../features/growth/goalForm";
import type { Answered, LeftRow, Needs, WaitingQuestion } from "../../features/growth/needs";
import { foldQuestions, questionText } from "../../features/growth/needs";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { PillSwitch } from "../settings/SettingsUI";
import { AutopilotControl } from "./AutopilotControl";
import { AddGoalRow, GoalRowControls, GoalWriteDialogs, SuggestedGoalCard, useGoalWrites } from "./GoalControls";
import { MoveActions } from "./MoveActions";
import { QuestionActions } from "./QuestionActions";
import { AlertLine, Bars, Eyebrow, GoalBar, StatusChip, StoryBox, StoryRow, SubLabel, TextLink } from "./StoryKit";

export function GoalsStepBody({
  plan,
  goals,
  pills,
  fixes,
  unavailable,
  canEdit,
  onEdit,
  onCreate,
}: {
  plan: GrowthPlan;
  goals: GrowthGoal[];
  pills: ReadonlyMap<string, GoalPill | null>;
  fixes: ReadonlyMap<string, MeasurementNeed | null>;
  unavailable: boolean;
  canEdit: boolean;
  onEdit: (goal: GrowthGoal) => void;
  onCreate: (objective?: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const writes = useGoalWrites(goals);
  const now = Date.now();
  if (unavailable) {
    return (
      <StoryBox>
        <StoryRow first>
          <Text style={styles.muted}>Goals could not be loaded.</Text>
        </StoryRow>
      </StoryBox>
    );
  }
  const suggested = suggestedGoal(plan.goals.items);
  const row = plan.unreadable.includes("plan") ? null : plan.plan;
  const cap = plan.goals.max_active;
  const atCap = cap !== null && goals.length >= cap;
  const detail = plan.detail;
  return (
    <>
      <StoryBox>
        {goals.length === 0 ? (
          <StoryRow first>
            <Text style={styles.emptyBig}>No goal yet.</Text>
          </StoryRow>
        ) : null}
        {goals.map((g, i) => {
          const fix = fixes.get(g.id) ?? null;
          const measured = fix ? fix.kind === "none" : g.current_value !== null;
          const pill = pills.get(g.id) ?? null;
          const meta = goalMeta(g, now);
          const due = goalDueLabel(g);
          return (
            <StoryRow key={g.id} first={i === 0}>
              <View style={styles.goalHead}>
                <Text style={styles.goalTitle} accessibilityLabel={g.objective}>
                  {goalTitle(g, new Date(now), { date: false }) ?? g.objective}
                  {due ? <Text style={styles.goalDue}>{`  ${due}`}</Text> : null}
                </Text>
                {pill ? <StatusChip tone={pill.tone}>{pill.label}</StatusChip> : null}
              </View>
              <View style={styles.barWrap}>
                <GoalBar pct={goalBarPercent(g, measured)} label={`${g.objective} progress`} />
              </View>
              {meta ? <Text style={styles.meta}>{meta}</Text> : null}
              {canEdit ? (
                <GoalRowControls
                  goal={g}
                  index={i}
                  count={goals.length}
                  noNumber={fix !== null && fix.kind !== "none"}
                  busy={writes.busy}
                  onMove={(index, by) => void writes.move(index, by)}
                  onEdit={() => onEdit(g)}
                  onDelete={() => writes.setDeleting(g)}
                />
              ) : null}
            </StoryRow>
          );
        })}
        {canEdit ? (
          <StoryRow first={goals.length === 0}>
            {atCap ? (
              <Text style={styles.meta}>{capLine(cap!)}</Text>
            ) : (
              <AddGoalRow suggestions={goalSuggestions(row)} busy={writes.busy} onCreate={onCreate} />
            )}
          </StoryRow>
        ) : null}
      </StoryBox>
      <GoalWriteDialogs writes={writes} />
      {suggested && canEdit ? (
        <SuggestedGoalCard goal={suggested} busy={writes.busy} accepting={writes.accepting} onAccept={() => void writes.take(suggested)} />
      ) : null}
    </>
  );
}

export function WayStepBody({
  plan,
  goals,
  building,
  kept,
  onKeep,
  keepFailed = null,
  keepPending = null,
  canEdit = true,
  onAsk,
}: {
  plan: GrowthPlan;
  goals: GrowthGoal[];
  building: boolean;
  kept: ReadonlySet<string>;
  onKeep: (hypothesisId: string) => void;
  keepFailed?: string | null;
  keepPending?: string | null;
  canEdit?: boolean;
  onAsk: (text: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const [whyOpen, setWhyOpen] = useState(false);
  const [openList, setOpenList] = useState<string | null>(null);
  const planUnavailable = plan.unreadable.includes("plan");
  const workUnavailable = plan.unreadable.includes("goal_work");
  const row = planUnavailable ? null : plan.plan;
  const statement = row?.constraint_statement?.trim() ?? "";
  const evidence = (row?.basis_evidence ?? []).filter((e) => e.kind !== "gap" && e.statement.trim());
  const gaps = (row?.basis_evidence ?? []).filter((e) => e.kind === "gap" && e.statement.trim());
  const alsoFix = plan.detail.also_fix?.trim();
  const hasWhy = evidence.length > 0 || gaps.length > 0 || !!alsoFix;
  const anyConflict = goals.some((g) => conflictFor(g.id, row, plan.constraint_conflicts, kept) !== null);
  const rows: React.ReactNode[] = [];

  if (planUnavailable) {
    rows.push(<Text key="u" style={styles.muted}>Couldn't load this. Try again in a moment.</Text>);
  } else if (!statement) {
    if (goals.length === 0) rows.push(<Text key="n" style={styles.emptyBig}>Not worked out yet.</Text>);
  } else if (!anyConflict) {
    rows.push(
      <View key="p" style={styles.gap6}>
        <Text style={styles.bodyInk}>
          <Text style={styles.mutedInline}>Plan says: </Text>
          {statement}
        </Text>
        <View style={styles.inlineRow}>
          {row?.constraint_confidence ? <StatusChip tone="quiet">{CONFIDENCE_LABEL[row.constraint_confidence]}</StatusChip> : null}
          {hasWhy ? <TextLink label={whyOpen ? "Hide why" : "Why?"} onPress={() => setWhyOpen((v) => !v)} expanded={whyOpen} /> : null}
          <TextLink label="Change this" onPress={() => onAsk(askChangeConstraint(statement))} />
        </View>
        {whyOpen && hasWhy ? (
          <View style={styles.whyBox}>
            {evidence.map((e, i) => (
              <Text key={`e${i}`} style={styles.body}>
                {e.statement}
                {e.source ? <Text style={styles.mutedInline}>{` (${e.source})`}</Text> : null}
              </Text>
            ))}
            {gaps.map((e, i) => (
              <Text key={`g${i}`} style={styles.body}>{`Still unknown: ${e.statement}`}</Text>
            ))}
            {alsoFix ? <Text style={styles.body}>{`Also fix: ${alsoFix}`}</Text> : null}
          </View>
        ) : null}
      </View>,
    );
  }

  return (
    <StoryBox>
      {rows.map((r, i) => (
        <StoryRow key={`plan${i}`} first>
          {r}
        </StoryRow>
      ))}
      {goals.map((g, i) => {
        const w = plan.goal_work[g.id];
        const hyps: GoalHypothesis[] = w?.hypotheses ?? [];
        const best = bestGuess(hyps);
        const conflict = conflictFor(g.id, row, plan.constraint_conflicts, kept);
        const nowGuess = conflict ? replacementGuess(hyps, conflict) : null;
        const keptConflict = conflict ? null : keptConflictFor(g.id, row, plan.constraint_conflicts, kept);
        const listOpen = openList === g.id;
        return (
          <StoryRow key={g.id} first={rows.length === 0 && i === 0}>
            <Text style={styles.wayLabel}>{g.target_metric?.trim() ? humanize(g.target_metric) : g.objective}</Text>
            {workUnavailable || w?.hypotheses_unavailable ? (
              <Text style={styles.meta}>Couldn't load Zavi's guesses right now.</Text>
            ) : hyps.length === 0 && building ? (
              <Bars label="Working out what holds this goal back" lines={1} />
            ) : hyps.length === 0 ? (
              <Text style={styles.meta}>Not worked out yet. Zavi lists its guesses at the next review.</Text>
            ) : (
              <View style={styles.gap6}>
                {best ? (
                  <View style={styles.gap6}>
                    <Text style={styles.bodyInk}>
                      <Text style={styles.bodyStrong}>Best guess: </Text>
                      {best.claim}
                    </Text>
                    {best.status !== "testing" ? <StatusChip tone="quiet">{HYP_LABEL[best.status]}</StatusChip> : null}
                  </View>
                ) : (
                  <Text style={styles.meta}>Every idea so far is ruled out.</Text>
                )}
                <View style={styles.inlineRow}>
                  <Text style={styles.meta}>{`${ideasLine(hyps)} ·`}</Text>
                  <TextLink label={listOpen ? "Hide" : "See all"} onPress={() => setOpenList(listOpen ? null : g.id)} expanded={listOpen} />
                </View>
                {listOpen ? <Hypotheses hypotheses={hyps} /> : null}
              </View>
            )}
            {conflict && row ? (
              <View style={styles.conflict}>
                <Text style={[styles.conflictText, styles.bodyStrong]}>Zavi's evidence no longer backs your plan.</Text>
                <Text style={styles.conflictText}>
                  <Text style={styles.bodyStrong}>Your plan says: </Text>
                  {statement}
                </Text>
                <Text style={styles.conflictText}>
                  <Text style={styles.bodyStrong}>Ruled out for this goal: </Text>
                  {conflict.claim}
                </Text>
                <Text style={styles.conflictText}>
                  <Text style={styles.bodyStrong}>Best guess now: </Text>
                  {nowGuess ? nowGuess.claim : "not found yet, Zavi is still testing."}
                </Text>
                <View style={styles.inlineRow}>
                  <TextLink label="Update the plan" onPress={() => onAsk(updatePlanMessage(statement, conflict, g, nowGuess))} />
                  {canEdit ? (
                    <TextLink
                      label={keepPending === conflict.hypothesis_id ? "Saving…" : "Keep my plan"}
                      onPress={() => (keepPending ? undefined : onKeep(conflict.hypothesis_id))}
                    />
                  ) : null}
                </View>
                {keepFailed === conflict.hypothesis_id ? (
                  <Text style={[styles.conflictText, styles.bodyStrong]}>Couldn't save. Try again.</Text>
                ) : null}
              </View>
            ) : null}
            {keptConflict ? (
              <Text style={styles.meta}>{`You kept your plan on ${keptDay(keptConflict.kept_at)}. Zavi ruled out: ${unstop(keptConflict.claim)}.`}</Text>
            ) : null}
          </StoryRow>
        );
      })}
    </StoryBox>
  );
}

function Hypotheses({ hypotheses }: { hypotheses: GoalHypothesis[] }) {
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <View style={styles.hyps}>
      <Eyebrow>What I think is holding this back</Eyebrow>
      {hypotheses.map((h) => {
        const expanded = open === h.id;
        return (
          <View key={h.id} style={styles.gap6}>
            <View style={styles.hypRow}>
              <Text
                style={[styles.hypClaim, h.status === "ruled_out" && styles.struck]}
                numberOfLines={expanded ? undefined : 1}
                onPress={() => setOpen(expanded ? null : h.id)}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
              >
                {h.claim}
              </Text>
              <StatusChip tone={HYP_TONE[h.status]}>{HYP_LABEL[h.status]}</StatusChip>
            </View>
            {expanded
              ? h.evidence.length === 0
                ? <Text style={styles.meta}>No evidence checked yet.</Text>
                : h.evidence.map((e, i) => (
                    <Text key={i} style={styles.meta}>
                      {e.at ? `${e.at}: ` : ""}
                      {e.quote ? `“${e.quote}”` : ""}
                      {e.quote && e.why ? " " : ""}
                      {e.why ?? ""}
                    </Text>
                  ))
              : null}
          </View>
        );
      })}
    </View>
  );
}

const MODE_BY_CGO = "run by CGO (Autopilot), posts wait for you";

export function DoingStepBody({
  plan,
  inPlan,
  nameOf,
  cgoRunSlugs,
  riskBySlugs,
  hogUnavailable,
  canAutopilot,
  canEdit,
  hasLivePlan,
  autorunSaving,
  onAsk,
  onToggleAutorun,
}: {
  plan: GrowthPlan;
  inPlan: GrowthChannel[];
  nameOf: (slug: string) => string;
  cgoRunSlugs: ReadonlySet<string>;
  riskBySlugs: ReadonlyMap<string, string>;
  hogUnavailable: boolean;
  canAutopilot: boolean;
  canEdit: boolean;
  hasLivePlan: boolean;
  autorunSaving: boolean;
  onAsk: (text: string) => void;
  onToggleAutorun: (slug: string, next: boolean) => void;
}) {
  const styles = useStyles(makeStyles);
  const autopilot = plan.head_of_growth.autopilot;
  const unavailable = plan.unreadable.includes("channels");
  const bets = plan.unreadable.includes("bets") ? [] : plan.bets.filter((b) => b.status === "accepted" || b.status === "done");
  const betBySlug = new Map(bets.filter((b) => b.channel_slug).map((b) => [b.channel_slug as string, b]));
  const inPlanSlugs = new Set(inPlan.map((c) => c.slug));
  const pausedByZavi = plan.channels.filter((c) => c.cgo_reason && !inPlanSlugs.has(c.slug));
  const moves = plan.detail.growth_moves ?? [];
  return (
    <>
      <AutopilotControl on={autopilot} unavailable={hogUnavailable} canChange={canAutopilot} />
      <StoryBox>
        {unavailable ? (
          <StoryRow first>
            <Text style={styles.muted}>Channels could not be loaded.</Text>
          </StoryRow>
        ) : (
          <>
            {inPlan.length === 0 ? (
              <StoryRow first>
                <Text style={styles.muted}>No channels yet. Add one to put it in your plan.</Text>
              </StoryRow>
            ) : (
              inPlan.map((c, i) => (
                <ChannelRow
                  key={c.slug}
                  first={i === 0}
                  channel={c}
                  name={nameOf(c.slug)}
                  bet={betBySlug.get(c.slug)}
                  byCgo={autopilot && cgoRunSlugs.has(c.slug) && !c.autorun}
                  risk={riskBySlugs.get(c.slug)}
                  canEdit={canEdit}
                  hasLivePlan={hasLivePlan}
                  saving={autorunSaving}
                  onAsk={() => onAsk(askAboutChannel(nameOf(c.slug)))}
                  onToggleAutorun={onToggleAutorun}
                />
              ))
            )}
            {pausedByZavi.length > 0 ? (
              <StoryRow>
                {pausedByZavi.map((c) => (
                  <Text key={c.slug} style={styles.meta}>{`I paused ${nameOf(c.slug)}: ${c.cgo_reason}`}</Text>
                ))}
              </StoryRow>
            ) : null}
          </>
        )}
      </StoryBox>
      {!unavailable && moves.length > 0 ? (
        <View style={styles.after}>
          <SubLabel>Growth moves</SubLabel>
          {moves.map((m, i) => (
            <GrowthMove key={i} move={m} />
          ))}
        </View>
      ) : null}
    </>
  );
}

function ChannelRow({
  channel,
  name,
  bet,
  byCgo,
  risk,
  canEdit,
  hasLivePlan,
  saving,
  first,
  onAsk,
  onToggleAutorun,
}: {
  channel: GrowthChannel;
  name: string;
  bet: GrowthBet | undefined;
  byCgo: boolean;
  risk: string | undefined;
  canEdit: boolean;
  hasLivePlan: boolean;
  saving: boolean;
  first: boolean;
  onAsk: () => void;
  onToggleAutorun: (slug: string, next: boolean) => void;
}) {
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const controlDisabled = saving || !canEdit || !hasLivePlan;
  const flip = () => {
    if (channel.autorun) onToggleAutorun(channel.slug, false);
    else if (risk) setConfirming(true);
    else onToggleAutorun(channel.slug, true);
  };
  const mode = channel.slug === "chatgpt_ads" ? channel.autorun ? "CGO may manage ads within Growth budget · prepaid wallet" : "asks you first" : byCgo ? MODE_BY_CGO : channel.autorun ? "runs on its own" : "asks you first";
  const sub = channel.plan_selected_set_by === "founder" ? `Added by you · ${mode}` : `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
  return (
    <StoryRow first={first}>
      <View style={styles.channelHead}>
        <View style={styles.flex1}>
          <Text style={styles.channelName}>{name}</Text>
          <Text style={styles.sub}>{sub}</Text>
        </View>
        <View style={styles.channelControls}>
          <TextLink label={open ? "Less" : "Why?"} onPress={() => setOpen((v) => !v)} expanded={open} />
          {!byCgo ? (
            <Pressable
              onPress={controlDisabled ? undefined : flip}
              style={({ pressed }) => [styles.autorunBtn, pressed && !controlDisabled && styles.autorunPressed, controlDisabled && styles.autorunDisabled]}
              accessibilityRole="switch"
              accessibilityLabel={channel.autorun ? `Stop ${name} running on its own` : `Let Zavi run ${name} on its own`}
              accessibilityState={{ checked: channel.autorun, disabled: controlDisabled }}
            >
              <PillSwitch value={channel.autorun} />
              <Text style={styles.autorunLabel}>Let it run</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {confirming && risk ? (
        <View style={styles.confirmBox} accessibilityRole="alert">
          <Text style={styles.bodyInk}>{channel.slug === "chatgpt_ads" ? "Allow CGO to create, launch and manage ChatGPT campaigns using your Growth budget and prepaid wallet. This does not enable wallet refills. Pauses and budget cuts still ask you first." : `${name} will ${risk} without asking you.`}</Text>
          <Text style={styles.meta}>You can stop it here any time.</Text>
          <View style={styles.inlineRow}>
            <TextLink
              label="Yes, let it run"
              onPress={() => {
                setConfirming(false);
                onToggleAutorun(channel.slug, true);
              }}
            />
            <TextLink label="Cancel" onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : null}
      {open ? (
        <View style={styles.gap6}>
          {bet ? (
            <>
              <Text style={styles.bodyInk}>{bet.intent}</Text>
              <Text style={styles.body}>
                {bet.rationale ? `Why: ${bet.rationale}` : "Why: not recorded yet. Zavi adds it the next time the plan updates."}
              </Text>
              {bet.expected_effect?.trim() ? <Text style={styles.body}>{`Expected: ${bet.expected_effect}`}</Text> : null}
              {bet.falsifier?.trim() ? <Text style={styles.body}>{`Call it failed if: ${bet.falsifier}`}</Text> : null}
            </>
          ) : null}
          <TextLink label="Ask Zavi" onPress={onAsk} accessibilityLabel={`Ask Zavi about ${name}`} />
        </View>
      ) : null}
    </StoryRow>
  );
}

function GrowthMove({ move }: { move: NonNullable<GrowthPlan["detail"]["growth_moves"]>[number] }) {
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.move}>
      <View style={styles.inlineRow}>
        <Text style={styles.bodyStrongInk}>{move.title}</Text>
        {move.lever ? <StatusChip tone="quiet">{move.lever}</StatusChip> : null}
      </View>
      <Text style={styles.body} numberOfLines={open ? undefined : 4}>
        {move.action}
      </Text>
      {open ? (
        <>
          {move.rationale ? <Text style={styles.meta}>{`Why: ${move.rationale}`}</Text> : null}
          {move.expected_effect ? <Text style={styles.meta}>{`Expected: ${move.expected_effect}`}</Text> : null}
          {move.falsifier ? <Text style={styles.meta}>{`Call it failed if: ${move.falsifier}`}</Text> : null}
        </>
      ) : null}
      <TextLink label={open ? "Show less" : "Why this move"} onPress={() => setOpen((v) => !v)} expanded={open} />
    </View>
  );
}

export function HappenedStepBody({ plan, asked }: { plan: GrowthPlan; asked: YouAsked | null }) {
  const styles = useStyles(makeStyles);
  const [all, setAll] = useState(false);
  const [breakdown, setBreakdown] = useState(false);
  const unavailable = plan.unreadable.includes("goal_work");
  const moves = happenedMoves(plan.goal_work);
  const shown = all ? moves : moves.slice(0, HAPPENED_SHOWN);
  const hidden = moves.length - HAPPENED_SHOWN;
  const lines = answerLines(asked?.answer);
  return (
    <StoryBox>
      {asked ? (
        <StoryRow first>
          <View style={styles.asked} accessibilityLabel="You asked">
            <Text style={styles.askedQ}>{`You asked by email: "${asked.question}"`}</Text>
            {lines.length === 0 ? (
              <Text style={styles.meta}>No reply yet.</Text>
            ) : (
              <>
                <Text style={styles.askedLead}>{lines[0]}</Text>
                {lines.length > 1 ? (
                  <>
                    <TextLink label={breakdown ? "Hide" : "Breakdown"} onPress={() => setBreakdown((v) => !v)} expanded={breakdown} />
                    {breakdown ? lines.slice(1).map((l, i) => <Text key={i} style={styles.body}>{l}</Text>) : null}
                  </>
                ) : null}
              </>
            )}
          </View>
        </StoryRow>
      ) : null}
      <StoryRow first={!asked}>
        {unavailable ? (
          <Text style={styles.meta}>Couldn't load what Zavi did.</Text>
        ) : moves.length === 0 ? (
          <Text style={styles.meta}>No moves yet. Zavi picks one at its next review.</Text>
        ) : (
          <View style={styles.gap10}>
            {shown.map(({ move: m, tries }) => (
              <View key={m.decision_id} style={styles.happened}>
                <View style={styles.flex1}>
                  <Text style={styles.bodyStrongInk}>{humanize(m.agent)}</Text>
                  <Text style={styles.body} numberOfLines={2}>
                    {m.intent}
                  </Text>
                </View>
                <StatusChip tone={STATE_TONE[m.state]}>{`${STATE_LABEL[m.state]}${tries > 1 ? ` ×${tries}` : ""}`}</StatusChip>
              </View>
            ))}
            {hidden > 0 ? <TextLink label={all ? "Show less" : `Show ${hidden} more`} onPress={() => setAll((v) => !v)} expanded={all} /> : null}
          </View>
        )}
      </StoryRow>
    </StoryBox>
  );
}

export function NeedsStepBody({
  needs,
  questions,
  left,
  leftLabel,
  more,
  waiting,
  canDecide,
  canAnswer,
  answered,
  onAnswered,
  onRetry,
  onOpenLink,
  onOpenReview,
}: {
  needs: Needs;
  questions: WaitingQuestion[];
  left: LeftRow[];
  leftLabel: string;
  more: { count: number; url: string; line: string } | null;
  waiting: Array<{ move: GoalMove; actsOn: string | null }>;
  canDecide: boolean;
  canAnswer: boolean;
  answered: Readonly<Record<string, Answered>>;
  onAnswered: (id: string, a: Answered) => void;
  onRetry: () => void;
  onOpenLink: (url: string) => void;
  onOpenReview?: () => void;
}) {
  const styles = useStyles(makeStyles);
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  const [allQuestions, setAllQuestions] = useState(false);
  if (needs.state === "loading") return <Bars label="Loading what needs you" lines={2} height={40} />;
  const { shown: shownQuestions, hidden: hiddenQuestions } = foldQuestions(questions, allQuestions);
  const anything = questions.length > 0 || left.length > 0 || !!more || waiting.length > 0 || needs.footer !== null;
  return (
    <>
      {needs.state === "failed" ? (
        <View style={styles.afterTight}>
          <AlertLine right={<TextLink label="Try again" onPress={onRetry} />}>Couldn't check what needs you.</AlertLine>
        </View>
      ) : null}
      {needs.empty ? (
        <View style={styles.emptyBox}>
          <Text style={styles.muted}>Nothing needs you right now.</Text>
        </View>
      ) : anything ? (
        <StoryBox tone="needs">
          {shownQuestions.map((q, i) => {
            const t = questionText(q);
            const done = answered[q.id];
            return (
              <StoryRow key={q.id} first={i === 0}>
                <Eyebrow>Question</Eyebrow>
                <Text style={styles.needLine}>
                  {t.ask}
                  {t.recommend ? <Text style={styles.mutedInline}>{t.recommend}</Text> : null}
                </Text>
                {q.why ? <TextLink label={whyOpen === q.id ? "Hide why" : "Why"} onPress={() => setWhyOpen(whyOpen === q.id ? null : q.id)} expanded={whyOpen === q.id} /> : null}
                {q.why && whyOpen === q.id ? <Text style={styles.meta}>{q.why}</Text> : null}
                {done ? (
                  <View style={styles.answered} accessibilityRole="text" accessibilityLiveRegion="polite">
                    <Text style={styles.answeredLabel}>{done.label}</Text>
                    {done.note ? <Text style={styles.answeredNote}>{done.note}</Text> : null}
                  </View>
                ) : canAnswer && q.yes_no ? (
                  <QuestionActions question={q} onAnswered={onAnswered} />
                ) : null}
              </StoryRow>
            );
          })}
          {hiddenQuestions > 0 ? (
            <StoryRow style={styles.foldRow}>
              <TextLink
                label={allQuestions ? "Show fewer questions" : `Show ${hiddenQuestions} more question${hiddenQuestions === 1 ? "" : "s"}`}
                onPress={() => setAllQuestions((v) => !v)}
                expanded={allQuestions}
              />
            </StoryRow>
          ) : null}
          {left.map((r, i) => (
            <StoryRow key={`left${i}`} first={questions.length === 0 && i === 0}>
              <Eyebrow>{leftLabel}</Eyebrow>
              <Text style={styles.needLine}>{r.line}</Text>
              {r.url ? <TextLink label="Open" onPress={() => onOpenLink(r.url as string)} /> : null}
            </StoryRow>
          ))}
          {more ? (
            <StoryRow first={questions.length === 0 && left.length === 0}>
              <View style={styles.inlineRow}>
                <Text style={styles.meta}>{more.line}</Text>
                <TextLink label="Open" onPress={() => onOpenLink(more.url)} />
              </View>
            </StoryRow>
          ) : null}
          {waiting.map(({ move, actsOn }, i) => (
            <StoryRow key={move.decision_id} first={questions.length === 0 && left.length === 0 && !more && i === 0}>
              <Eyebrow>{`Approve · ${humanize(move.agent)}`}</Eyebrow>
              <Text style={styles.needLine}>{move.intent}</Text>
              {move.aims_to_move ? <Text style={styles.meta}>{`Aims to move: ${humanize(move.aims_to_move)}`}</Text> : null}
              {actsOn ? <Text style={styles.meta}>{`Acts on: ${actsOn}`}</Text> : null}
              {canDecide ? <MoveActions decisionId={move.decision_id} /> : null}
            </StoryRow>
          ))}
          {needs.footer ? (
            <StoryRow first={questions.length === 0 && left.length === 0 && !more && waiting.length === 0}>
              <View style={styles.footerRow}>
                <Text style={styles.meta}>{needs.footer}</Text>
                {needs.reviewLabel && onOpenReview ? (
                  <TextLink label={needs.reviewLabel} onPress={onOpenReview} />
                ) : null}
              </View>
            </StoryRow>
          ) : null}
        </StoryBox>
      ) : null}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex1: { flex: 1, minWidth: 0 },
    gap6: { gap: 6 },
    gap10: { gap: 10 },
    muted: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.muted },
    mutedInline: { fontFamily: font.family.regular, color: colors.muted },
    emptyBig: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    meta: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    sub: { fontFamily: font.family.medium, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.muted, marginTop: 2 },
    body: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.textSecondary },
    bodyInk: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.ink },
    bodyStrong: { fontFamily: font.family.semi, color: colors.ink },
    bodyStrongInk: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    struck: { textDecorationLine: "line-through", color: colors.muted },
    goalHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm },
    goalTitle: { flex: 1, fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    goalDue: { fontFamily: font.family.regular, fontSize: 13, color: colors.muted },
    barWrap: { marginTop: 16, marginBottom: 8 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    suggestion: { borderRadius: radius.pill, borderWidth: 1, borderStyle: "dashed", borderColor: colors.line, paddingHorizontal: 10, paddingVertical: 6 },
    suggestionText: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 17, includeFontPadding: false, color: colors.muted },
    after: { marginTop: space.md, gap: space.sm },
    afterTight: { marginBottom: space.sm },
    foldRow: { alignItems: "flex-end" },
    footerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
    whyBox: { borderRadius: radius.md, backgroundColor: colors.soft, padding: space.md, gap: 6 },
    inlineRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
    wayLabel: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.muted, marginBottom: 4 },
    conflict: { marginTop: 10, borderRadius: radius.md, backgroundColor: colors.status.amberBg, padding: space.md, gap: space.sm },
    conflictText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.status.amberText },
    hyps: { gap: space.sm, marginTop: 4 },
    hypRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
    hypClaim: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    channelHead: { flexDirection: "row", alignItems: "center", gap: space.md },
    channelControls: { flexDirection: "row", alignItems: "center", gap: space.sm },
    autorunBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
    autorunLabel: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    autorunPressed: { opacity: 0.8 },
    autorunDisabled: { opacity: 0.4 },
    confirmBox: { borderRadius: radius.md, backgroundColor: colors.soft, padding: space.md, gap: 6, marginTop: space.sm },
    channelName: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    move: { gap: 6, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: colors.line },
    asked: { borderRadius: radius.md, backgroundColor: colors.soft, padding: space.md, gap: 4 },
    askedQ: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.muted },
    askedLead: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.ink },
    happened: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
    emptyBox: { borderRadius: 16, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.lg, paddingVertical: 14 },
    answered: { marginTop: 6, gap: 2 },
    answeredLabel: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.green },
    answeredNote: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.textSecondary },
    needLine: { marginTop: 2, fontFamily: font.family.semi, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.ink },
  });
