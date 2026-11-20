
import { CHANNELS } from "@zavi/shared";
import type { ActiveAdBudget } from "@/services/decisions/ad-budget";
import {
  PAID_CHANNELS,
  ORGANIC_MATRIX,
  adSetEvidence,
  campaignEvidence,
  compactMetrics,
  firstLine,
  organicChannel,
  organicEvidenceOf,
  paidChannel,
  pauseEvidenceLine,
  type CgoEvidence,
  type OrganicItem,
} from "@/services/growth/cgo-evidence";
import { CGO_AD_CHANNELS } from "@/services/growth/cgo-ads";
import { planQuestions, type QuestionAsk } from "@/services/growth/cgo-questions";
import {
  channelViews,
  founderView,
  type AlarmReason,
  type CardActor,
  type NoteKind,
  type WatchAction,
  type WatchState,
} from "@/services/growth/cgo-watch";
import {
  CGO_AD_TARGETS,
  CGO_AUTO_RUN_TARGETS,
  CGO_ORGANIC_TARGETS,
  CGO_TARGETS,
  OWN_GOALS_STAGE,
  composeGoalOwnerContext,
  endedReason,
  evidenceFromPayload,
  founderRemovedChannels,
  goalAfterChange,
  goalRev,
  leftCardKey,
  leftForYouLine,
  channelCardCutHeld,
  cardsToApply,
  numberTrusted,
  parseGoalMoves,
  planChannelPauses,
  planGoalCards,
  planGoalChanges,
  planGoalEnds,
  planModelQuestions,
  reviewMetaFromPayload,
  rejectedOrdersFrom,
  reviewedRevsFromPayload,
  shouldProposeNextGoal,
  shownCardsFromPayload,
  utcDay,
  type AdviceCard,
  type GoalMoves,
  type GoalOwnerStepRow,
  type GoalRow,
  type WakeReason,
} from "@/services/growth/goal-owner";
import {
  MIN_NAME_CHARS,
  cardSubjectRefs,
  channelsForAdClass,
  contradictingCards,
  normName,
  objectFromNames,
  refsFromPayload,
  refsOfRow,
  textNamesCard,
  type AdObject,
  type OpenCardRow,
} from "@/services/growth/open-advice";
import {
  adShape,
  channelPauseFacts,
  evaluateUnattended,
  goalFactOf,
  googleObjectFacts,
  heldChangeAsk,
  heldChangePhrase,
  heldReasonWords,
  isExecutableAdClass,
  metaObjectFacts,
  normEvent,
  withConversionFiring,
  type AdObjectFacts,
  type MetaAdSetRow,
  type Tracking,
  type UnattendedAction,
  type UnattendedFacts,
  type Verdict,
} from "@/services/growth/unattended-policy";
import { runContextBlock } from "./cgo-adapter";
import {
  buildNoteItems,
  channelCardNoteItem,
  cleanReason,
  itemText,
  type CardBucket,
  type CardOutcome,
  type NoteItem,
} from "@/services/growth/cgo-note-items";
import { execVerdictOf, fixWords } from "@/services/channels/exec-failure";
import { execPlatformLabel } from "@/services/channels/exec-kill-switch";

const DAY = 86_400_000;

export type ReplayAdSet = { name: string; facts: AdObjectFacts };

export type ReplayCampaign = {
  platform: "meta" | "google";
  id: string;
  name: string;
  objective: string | null;
  sets: ReplayAdSet[];
  pausedByFounder?: boolean | null;
};

export type ReplayCard = {
  id: string;
  channel_slug: string;
  title: string;
  step?: string;
  action_type?: string;
  exec_class?: string;
  exec_payload?: Record<string, unknown>;
  proposed_days_ago: number;
  run_id?: string;
  run_goal_id?: string;
  exec_status?: string;
  exec_result?: Record<string, unknown>;
  repeat_of?: string;
};

export type ReplayChannel = {
  slug: string;
  added_by: "plan" | "founder";
  in_plan?: boolean;
  decided14d?: { acted?: number; rejected?: number; snoozed?: number };
  closedBy?: CardActor;
  founder_seen_days_ago?: number | null;
  last_run_days_ago?: number | null;
};

export type ReplayOrganicItem = { text: string; url?: string; published_days_ago: number; metrics: Record<string, unknown> | null };

export type FollowThrough = { channel: string; when: RegExp; title: string; exec_class: string; payload: Record<string, unknown> };

export type ReplayWorld = {
  company: string;
  now: string;
  autopilot: boolean;
  reason: WakeReason;
  kind: NoteKind;
  check_reasons?: AlarmReason[];
  goals: GoalRow[];
  channels: ReplayChannel[];
  cards: ReplayCard[];
  campaigns?: ReplayCampaign[];
  tracking?: { meta?: { ok: boolean | null; fired?: Record<string, string[]> }; google?: { ok: boolean | null } };
  organic?: Record<string, ReplayOrganicItem[] | null>;
  ownMoves?: string[];
  adBudget?: ActiveAdBudget | null;
  founder?: { last_active_days_ago: number | null; approved14d: number; rejected14d: number };
  followThrough?: FollowThrough[];
  offPaceGoalIds?: string[];
  steps?: GoalOwnerStepRow[];
};

export function metaSet(
  now: string,
  s: {
    id: string;
    name: string;
    campaignObjective: string;
    optimization_goal: string;
    learning?: "SUCCESS" | "LEARNING" | "LEARNING_LIMITED" | null;
    editedDaysAgo: number;
    spend7d: number;
    conv7d: number;
    event?: string;
    pixel?: string;
    bidCapUsd?: number;
  },
): ReplayAdSet {
  const t = Date.parse(now);
  const row: MetaAdSetRow = {
    id: s.id,
    optimization_goal: s.optimization_goal,
    learning_stage_info: s.learning ? { status: s.learning } : null,
    updated_time: new Date(t - s.editedDaysAgo * DAY).toISOString(),
    ...(s.bidCapUsd ? { bid_strategy: "COST_CAP", bid_amount: s.bidCapUsd * 100 } : {}),
    ...(s.event ? { promoted_object: { custom_event_type: s.event, pixel_id: s.pixel ?? "px1" } } : {}),
  };
  return { name: s.name, facts: metaObjectFacts(row, s.campaignObjective, { spend: s.spend7d, conv: s.conv7d }, new Date(t)) };
}

export function googleCampaign(c: {
  id: string;
  name: string;
  type: string;
  bidding: string;
  spend7d: number;
  conv7d: number;
  targetCpaUsd?: number | null;
  editedDaysAgo?: number | null;
  pausedByFounder?: boolean | null;
}): ReplayCampaign {
  const facts = googleObjectFacts({
    campaignId: c.id,
    type: c.type,
    bidding: c.bidding,
    daysSinceEdit: c.editedDaysAgo ?? null,
    spendUsd: c.spend7d,
    conversions: c.conv7d,
    targetCpaUsd: c.targetCpaUsd ?? null,
  });
  return {
    platform: "google",
    id: c.id,
    name: c.name,
    objective: facts.objective,
    sets: [{ name: c.name, facts }],
    ...(c.pausedByFounder !== undefined ? { pausedByFounder: c.pausedByFounder } : {}),
  };
}

export function adBudget(now: string, monthly: number, spent: number, held = 0): ActiveAdBudget {
  const d = new Date(now);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const days_in_month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    id: "budget-1",
    monthly_usd: monthly,
    month_cap_usd: monthly,
    spent_usd: spent,
    held_usd: held,
    creator_held_usd: 0,
    creator_spent_usd: 0,
    left_usd: Math.max(0, monthly - spent - held),
    daily_limit_usd: null,
    next_month_start: next.toISOString().slice(0, 10),
    days_left: Math.ceil((next.getTime() - d.getTime()) / DAY),
    days_in_month,
  };
}

const iso = (now: string, daysAgo: number) => new Date(Date.parse(now) - daysAgo * DAY).toISOString();

function watchStateOf(w: ReplayWorld): WatchState {
  const pending: WatchAction[] = w.cards.map((c) => ({
    id: c.id,
    channel_slug: c.channel_slug,
    status: "pending",
    proposed_at: iso(w.now, c.proposed_days_ago),
    title: c.title,
    action_type: c.action_type ?? null,
    exec_class: c.exec_class ?? null,
    exec_payload: c.exec_payload ?? null,
    step_body: c.step ?? null,
    subject_refs: cardSubjectRefs({ title: c.title, stepBody: c.step, execPayload: c.exec_payload }),
  }));
  const decided: WatchAction[] = [];
  for (const ch of w.channels) {
    const d = ch.decided14d ?? {};
    for (const [status, n] of [["acted", d.acted ?? 0], ["rejected", d.rejected ?? 0], ["snoozed", d.snoozed ?? 0]] as const) {
      for (let i = 0; i < n; i++) {
        const by = ch.closedBy && status !== "snoozed" ? { by: ch.closedBy } : {};
        decided.push({ id: `${ch.slug}-${status}-${i}`, channel_slug: ch.slug, status, proposed_at: iso(w.now, 3 + i), ...by });
      }
    }
  }
  const f = w.founder ?? { last_active_days_ago: 1, approved14d: 0, rejected14d: 0 };
  return {
    goals: w.goals.map((g) => ({ ...g, created_at: g.created_at ?? null })),
    pending,
    recent: [...pending, ...decided],
    channels: w.channels.map((ch) => ({
      channel_slug: ch.slug,
      plan_selected: ch.in_plan ?? true,
      plan_selected_set_by: ch.added_by,
      autorun: true,
      last_run_at: ch.last_run_days_ago == null ? null : iso(w.now, ch.last_run_days_ago),
      founder_seen_at: ch.founder_seen_days_ago == null ? null : iso(w.now, ch.founder_seen_days_ago),
      cgo_reason: null,
      cgo_set_at: null,
    })),
    notes: [],
    founder_last_active_at: f.last_active_days_ago == null ? null : iso(w.now, f.last_active_days_ago),
    last_check_run_at: null,
    approvals_14d: f.approved14d,
    rejections_14d: f.rejected14d,
    metrics: [],
    open_topics: [],
    autopilot: { enabled: w.autopilot, on_at: null },
  };
}

function metaTracking(w: ReplayWorld): Tracking {
  const m = w.tracking?.meta;
  if (!m) return { ok: null, firedEvents: null };
  return {
    ok: m.ok,
    firedEvents: m.fired ? new Map(Object.entries(m.fired).map(([px, evs]) => [px, new Set(evs.map(normEvent))])) : null,
  };
}

function googleTracking(w: ReplayWorld): Tracking {
  return { ok: w.tracking?.google?.ok ?? null, firedEvents: null };
}

const trackingOf = (w: ReplayWorld, platform: "meta" | "google") => (platform === "meta" ? metaTracking(w) : googleTracking(w));

export function evidenceOf(w: ReplayWorld, channelSlugs: readonly string[]): CgoEvidence {
  const slugs = [...new Set(channelSlugs)].sort();
  const paid = slugs
    .filter((s) => PAID_CHANNELS.has(s))
    .map((slug) => {
      if (slug !== "meta_ads" && slug !== "google_ads") return { channel_slug: slug, status: "no reader for this channel" as const };
      const platform = slug === "meta_ads" ? "meta" : "google";
      const t = trackingOf(w, platform);
      const live = (w.campaigns ?? []).filter((c) => c.platform === platform && c.pausedByFounder === undefined);
      return paidChannel(
        slug,
        live.map((c) => {
          const facts = withConversionFiring(c.sets.map((s) => s.facts), platform, t);
          return campaignEvidence({ id: c.id, name: c.name, objective: c.objective }, c.sets.map((s, i) => adSetEvidence(facts[i], s.name, t.ok)));
        }),
      );
    });
  const organic = slugs
    .filter((s) => !PAID_CHANNELS.has(s))
    .map((slug) => {
      const items = w.organic?.[slug];
      if (!ORGANIC_MATRIX[slug]?.store) return organicChannel(slug, null);
      const built: OrganicItem[] | null =
        items === undefined
          ? []
          : items === null
            ? null
            : items.map((i) => ({
                first_line: firstLine(i.text),
                url: i.url ?? null,
                published_on: iso(w.now, i.published_days_ago).slice(0, 10),
                metrics: compactMetrics(i.metrics),
              }));
      return built === null ? organicChannel(slug, null, "fixture: read failed") : organicChannel(slug, built);
    });
  return { paid, organic, own_moves: w.ownMoves ?? [] };
}

function allowedAgentsOf(w: ReplayWorld, removed: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [...CGO_TARGETS];
  if (w.autopilot && w.adBudget) out.push(...CGO_AD_TARGETS);
  if (w.autopilot) out.push(...[...CGO_ORGANIC_TARGETS].filter((t) => !removed.has(t)));
  return out.sort();
}

export function buildReview(w: ReplayWorld): { payload: Record<string, unknown>; userPrompt: string } {
  const now = new Date(w.now);
  const watch = watchStateOf(w);
  const channels = channelViews(watch, now);
  const adBudget = w.autopilot ? (w.adBudget ?? null) : null;
  const evidence = evidenceOf(w, [...channels.map((c) => c.channel_slug), ...(adBudget ? [...CGO_AD_TARGETS] : [])]);
  const context = composeGoalOwnerContext({
    today: utcDay(now),
    goals: w.goals,
    channels,
    founder: founderView(watch, now),
    lastNote: null,
    cards: [],
    steps: w.steps ?? [],
    agents: allowedAgentsOf(w, founderRemovedChannels(watch.channels)),
    adBudget,
    wake: { kind: w.kind, reason: w.reason, check_reasons: w.check_reasons ?? [], autopilot: w.autopilot },
    questions: [],
    offPaceIds: new Set(w.offPaceGoalIds ?? []),
    evidence,
  });
  const payload = {
    stage: OWN_GOALS_STAGE,
    reason: w.reason,
    note_kind: w.kind,
    autopilot: w.autopilot,
    alarm_keys: [],
    prev_idle: false,
    memory: { cgo_goals: context },
  };
  return { payload, userPrompt: runContextBlock(payload) };
}

export type ReplayApplied =
  | { kind: "ad_change"; via: "card" | "dispatch" | "tool"; exec_class: string; object: string | null; direction: string; title: string }
  | { kind: "dispatch"; target: string; intent: string; origin_action_id?: string }
  | { kind: "card_proposed"; target: string; intent: string }
  | { kind: "card_rejected"; action_id: string }
  | { kind: "channel_paused"; slug: string }
  | { kind: "goal_changed"; goal_id: string; line: string }
  | { kind: "goal_closed"; goal_id: string }
  | { kind: "next_goal" };

export type ReplayHeld = { what: string; verdict: Verdict; reasons: string[];  evidence?: string | null };
export type ReplayToolCall = { name: string; input: Record<string, unknown> };

export type ReplayOutcome = {
  parsed: { ok: true; moves: GoalMoves } | { ok: false; reason: string };
  applied: ReplayApplied[];
  held: ReplayHeld[];
  questions: Array<{ topic_key: string; ask: string; default_action: QuestionAsk["default_action"] }>;
  refused: string[];
  left: string[];
  items: NoteItem[];
  toolCalls: ReplayToolCall[];
};

type Ctx = {
  w: ReplayWorld;
  now: Date;
  out: ReplayOutcome;
  closed: Set<string>;
  extra: OpenCardRow[];
  seq: number;
  heldReasons: Map<string, string[]>;
  items: NoteItem[];
  blocked: Set<string>;
  leftKeys: Map<string, string>;
};

function openRows(c: Ctx, channels: readonly string[]): OpenCardRow[] {
  return [
    ...c.w.cards
      .filter((x) => !c.closed.has(x.id) && channels.includes(x.channel_slug))
      .map((x) => ({
        id: x.id,
        run_id: x.run_id ?? `run-${x.id}`,
        channel_slug: x.channel_slug,
        title: x.title,
        exec_class: x.exec_class ?? null,
        exec_payload: x.exec_payload ?? null,
        body: { step: { body: x.step ?? "" }, subject_refs: cardSubjectRefs({ title: x.title, stepBody: x.step, execPayload: x.exec_payload }) },
      })),
    ...c.extra.filter((x) => !c.closed.has(x.id) && channels.includes(x.channel_slug)),
  ];
}

function objectOf(c: Ctx, payload: unknown): AdObject {
  const refs = refsFromPayload(payload);
  if (refs.names.length > 0 || refs.ids.length === 0) return objectFromNames(refs, null);
  const id = refs.ids[0];
  for (const camp of c.w.campaigns ?? []) {
    if (camp.id === id) return objectFromNames(refs, [camp.name]);
    const set = camp.sets.find((x) => x.facts.id === id);
    if (set) return objectFromNames(refs, [set.name, camp.name]);
  }
  return objectFromNames(refs, null);
}

function goalFact(c: Ctx, goal_id: string | null | undefined): UnattendedFacts["goal"] {
  if (!goal_id) return { present: false };
  const g = c.w.goals.find((x) => x.id === goal_id);
  if (!g) return null;
  const today = utcDay(c.now);
  return goalFactOf({ current_value: g.current_value, current_value_at: g.current_value_at ?? null, measurement_mode: g.measurement_mode }, c.now, (r) =>
    numberTrusted(r, today),
  );
}

function objectsFor(c: Ctx, platform: "meta" | "google", objectId: string, level: "adset" | "campaign"): AdObjectFacts[] | null {
  for (const camp of c.w.campaigns ?? []) {
    if (camp.platform !== platform) continue;
    if (platform === "google" && camp.id === objectId) return camp.sets.map((s) => s.facts);
    if (platform === "meta" && level === "campaign" && camp.id === objectId) return camp.sets.length ? camp.sets.map((s) => s.facts) : null;
    if (platform === "meta" && level === "adset") {
      const s = camp.sets.find((x) => x.facts.id === objectId);
      if (s) return [s.facts];
    }
  }
  return null;
}

function pausedByFounderFor(c: Ctx, platform: "meta" | "google", objectId: string): boolean | null {
  for (const camp of c.w.campaigns ?? []) {
    if (camp.platform !== platform) continue;
    if (camp.id === objectId || camp.sets.some((s) => s.facts.id === objectId)) return camp.pausedByFounder ?? null;
  }
  return null;
}

function adFacts(c: Ctx, action: Extract<UnattendedAction, { kind: "ad" }>, goal_id: string | null | undefined): UnattendedFacts {
  const shape = adShape(action.exec_class, action.payload);
  if (shape.cls === "never") return {};
  const refs = refsFromPayload(action.payload);
  const name = refs.names[0] ?? null;
  const refsResolved = refs.ids.length > 0 || (!!name && normName(name).length >= MIN_NAME_CHARS);
  const advice: UnattendedFacts = refsResolved
    ? {
        refsResolved,
        openAdvice:
          contradictingCards(openRows(c, channelsForAdClass(action.exec_class)), {
            object: objectOf(c, action.payload),
            exclude: { action_id: action.source.table === "channel_actions" ? action.source.id : null, run_id: action.source.run_id },
            exec: { exec_class: action.exec_class, exec_payload: action.payload },
          }).length > 0
            ? "conflict"
            : "clear",
      }
    : { refsResolved, openAdvice: "clear" };
  if (shape.cls === "status" && shape.direction === "down") {
    const t = trackingOf(c.w, shape.platform);
    const objs = objectsFor(c, shape.platform, shape.platform === "google" ? (shape.campaignId ?? shape.objectId) : shape.objectId, shape.level === "campaign" ? "campaign" : "adset");
    return { ...advice, trackingOk: t.ok, objects: objs ? withConversionFiring(objs, shape.platform, t) : null };
  }
  const facts: UnattendedFacts = { ...advice, goal: goalFact(c, goal_id), spendUpUnderBudget: !!c.w.autopilot && !!c.w.adBudget };
  if (shape.cls === "create") return facts;
  const level = shape.cls === "status" ? (shape.level === "campaign" ? "campaign" : "adset") : "adset";
  const objectId = shape.platform === "google" && shape.cls === "status" ? (shape.campaignId ?? shape.objectId) : shape.objectId;
  facts.objects = objectsFor(c, shape.platform, objectId, level);
  if (shape.cls === "budget") {
    const t = trackingOf(c.w, shape.platform);
    facts.trackingOk = t.ok;
    if (facts.objects) facts.objects = withConversionFiring(facts.objects, shape.platform, t);
  }
  if (shape.cls === "status") facts.pausedByFounder = pausedByFounderFor(c, shape.platform, shape.objectId);
  return facts;
}

function throughTheDoor(
  c: Ctx,
  row: { id: string; run_id: string; exec_class: string; payload: unknown; title: string; table: "channel_actions" | "decisions" },
  via: "card" | "dispatch" | "tool",
  goal_id: string | null | undefined,
): boolean {
  if (!c.w.autopilot || !c.w.adBudget) {
    c.out.held.push({ what: row.title, verdict: "ask_founder", reasons: ["no_ad_budget"] });
    return false;
  }
  const action: Extract<UnattendedAction, { kind: "ad" }> = {
    kind: "ad",
    exec_class: row.exec_class,
    payload: row.payload,
    source: { table: row.table, id: row.id, run_id: row.run_id },
    title: row.title,
  };
  const facts = adFacts(c, action, goal_id);
  const v = evaluateUnattended(action, facts);
  if (v.verdict !== "allow") {
    const evidence = v.reasons.includes("pause_needs_founder") ? pauseEvidenceLine(facts.objects, facts.trackingOk ?? null) : null;
    c.out.held.push({ what: row.title, verdict: v.verdict, reasons: v.reasons, evidence });
    c.heldReasons.set(row.id, v.reasons);
    if (v.verdict === "ask_founder" && heldReasonWords(v.reasons).length === 0)
      c.out.questions.push({ topic_key: `held:card:${row.id}`, ask: heldChangeAsk(heldChangePhrase(row.exec_class, row.payload, row.title, null), v.reasons, evidence), default_action: null });
    return false;
  }
  const shape = adShape(row.exec_class, row.payload);
  const refs = refsFromPayload(row.payload);
  c.out.applied.push({
    kind: "ad_change",
    via,
    exec_class: row.exec_class,
    object: refs.ids[0] ?? refs.names[0] ?? null,
    direction: shape.cls === "budget" || shape.cls === "status" ? shape.direction : shape.cls,
    title: row.title,
  });
  return true;
}

function dispatchAllowed(c: Ctx, target: string, intent: string, origin?: string): { verdict: Verdict; reasons: string[] } {
  let facts: UnattendedFacts;
  if (CGO_AUTO_RUN_TARGETS.has(target)) facts = { targetAllowed: true };
  else if (CGO_ORGANIC_TARGETS.has(target)) facts = { targetAllowed: c.w.autopilot };
  else if (!CGO_AD_CHANNELS.has(target) || !c.w.adBudget) facts = { targetAllowed: false };
  else {
    const hit = openRows(c, [target])
      .filter((r) => r.id !== origin)
      .some((r) => textNamesCard(intent, refsOfRow(r)));
    facts = { targetAllowed: true, openAdvice: hit ? "conflict" : "clear" };
  }
  return evaluateUnattended({ kind: "dispatch_specialist", target, intent, origin_action_id: origin ?? null }, facts);
}

function followThrough(c: Ctx, target: string, intent: string, goal_id: string) {
  for (const ft of c.w.followThrough ?? []) {
    if (ft.channel !== target || !ft.when.test(intent)) continue;
    const id = `ft-${++c.seq}`;
    const run_id = `run-${id}`;
    const row: OpenCardRow = { id, run_id, channel_slug: target, title: ft.title, exec_class: ft.exec_class, exec_payload: ft.payload, body: {} };
    c.extra.push(row);
    if (!CGO_AD_CHANNELS.has(target) || !isExecutableAdClass(ft.exec_class)) {
      c.out.held.push({ what: ft.title, verdict: "deny", reasons: ["publish_needs_founder"] });
      continue;
    }
    if (throughTheDoor(c, { id, run_id, exec_class: ft.exec_class, payload: ft.payload, title: ft.title, table: "channel_actions" }, "dispatch", goal_id)) c.closed.add(id);
  }
}

function dispatch(c: Ctx, target: string, intent: string, goal_id: string, origin?: string): boolean {
  const v = dispatchAllowed(c, target, intent, origin);
  if (v.verdict !== "allow") {
    c.out.held.push({ what: `start ${target}: ${firstLine(intent, 80)}`, verdict: v.verdict, reasons: v.reasons });
    return false;
  }
  c.out.applied.push({ kind: "dispatch", target, intent, ...(origin ? { origin_action_id: origin } : {}) });
  followThrough(c, target, intent, goal_id);
  return true;
}

const channelName = (slug: string) => CHANNELS.find((x) => x.slug === slug)?.name ?? slug;

function workChannelCards(
  c: Ctx,
  moves: GoalMoves,
  shown: ReturnType<typeof shownCardsFromPayload>,
  goal: GoalRow | null,
  openKeys: Set<string>,
  evidence: CgoEvidence | null,
): Set<string> {
  const decided = new Set<string>();
  const wanted = moves.channel_cards ?? [];
  if (wanted.length === 0 || !shown) return decided;
  const seen = new Set<string>();
  const order = { reject: 0, leave: 1, approve: 2 } as const;
  const applicable = cardsToApply(moves.channel_card_order ? moves.channel_card_order.map((action_id) => ({ action_id })) : wanted, shown);
  const list = wanted
    .filter((x) => applicable.has(x.action_id) && !seen.has(x.action_id) && seen.add(x.action_id))
    .sort((a, b) => order[a.decision] - order[b.decision]);
  const redispatched = new Set<string>();
  for (const d of list) {
    const row = c.w.cards.find((x) => x.id === d.action_id && x.channel_slug === shown.get(d.action_id)!.channel_slug && !c.closed.has(x.id));
    if (!c.w.autopilot) continue;
    if (!row) {
      c.out.refused.push(`card ${d.action_id}: no longer open`);
      continue;
    }
    const ch = row.channel_slug;
    const label = `${channelName(ch)} card "${row.title}"`;
    const verdict = execVerdictOf(row.exec_status ?? null, row.exec_result ?? null);
    const bucket: CardBucket | null = verdict?.bucket ?? null;
    const platform = row.exec_class ? execPlatformLabel(row.exec_class) : channelName(ch);
    const fixText = bucket === "needs_founder" ? fixWords(verdict!.fix, platform, verdict!.platform_code) : null;
    const leftOutcome: CardOutcome = bucket && bucket !== "blocked_on_us" ? "approve_failed" : "leave";
    const noteRow = { id: row.id, channel_slug: ch, title: row.title, proposed_at: new Date(c.now.getTime() - row.proposed_days_ago * DAY).toISOString() };
    const item = (outcome: CardOutcome, why: string = d.why) =>
      c.items.push(channelCardNoteItem({ outcome, row: noteRow, bucket, action: d.action, why, usd: d.usd_at_stake ?? null, platform, fixText }));
    const leave = (reason: string) => {
      const line = leftForYouLine(row.title, reason);
      c.out.left.push(line);
      const key = leftCardKey(line);
      if (key !== null) c.leftKeys.set(row.id, key);
      item(leftOutcome, reason);
    };
    if (bucket === "blocked_on_us") {
      c.blocked.add(row.id);
      if (d.decision !== "reject") {
        c.out.refused.push(`${d.decision === "approve" ? "Approve" : "Leave"} the ${label}: ${platform} refused it; it is ours to fix, nothing for the founder.`);
        item("leave");
        continue;
      }
    }
    if (d.decision === "leave") {
      c.out.refused.push(`Left the ${label} for the founder.`);
      leave(d.why);
      continue;
    }
    if (d.decision === "approve" && (bucket === "needs_founder" || bucket === "partial_risk")) {
      c.out.refused.push(bucket === "needs_founder" ? `Approve the ${label}: it needs the founder's fix first.` : `Approve the ${label}: part of it may already be live, so it is never re-run.`);
      const line = leftForYouLine(row.title, fixText ? `it needs your fix first: ${fixText}` : "part of it may already be live; check it first");
      c.out.left.push(line);
      const key = leftCardKey(line);
      if (key !== null) c.leftKeys.set(row.id, key);
      item("approve_failed");
      continue;
    }
    if (!CGO_AD_CHANNELS.has(ch) || !c.w.adBudget) {
      c.out.refused.push(`The ${label} waits for the founder: cgo works only ad cards, and only under an ad budget.`);
      leave(CGO_AD_CHANNELS.has(ch) ? "Autopilot has no ad budget to approve it under" : "only you approve what goes out on this channel");
      continue;
    }
    if (d.decision === "reject") {
      c.closed.add(row.id);
      decided.add(row.id);
      c.out.applied.push({ kind: "card_rejected", action_id: row.id });
      item(bucket === "blocked_on_us" ? "leave" : "reject");
      continue;
    }
    const run_id = row.run_id ?? `run-${row.id}`;
    if (row.exec_class && isExecutableAdClass(row.exec_class)) {
      const refs = refsFromPayload(row.exec_payload);
      const other = contradictingCards(openRows(c, [ch]), {
        object: objectOf(c, row.exec_payload),
        exclude: { action_id: row.id, run_id },
        exec: { exec_class: row.exec_class, exec_payload: row.exec_payload },
      })[0];
      if (refs.ids.length + refs.names.length > 0 && other) {
        c.out.refused.push(`Approve the ${label}: the channel's open card "${other.title}" names the same object.`);
        continue;
      }
      if (!throughTheDoor(c, { id: row.id, run_id, exec_class: row.exec_class, payload: row.exec_payload, title: row.title, table: "channel_actions" }, "card", row.run_goal_id)) {
        c.out.refused.push(`Approve the ${label}: Autopilot's checks left it for the founder.`);
        const words = heldReasonWords(c.heldReasons.get(row.id) ?? []);
        leave(words.length ? words.join("; ") : "my checks did not clear it");
        continue;
      }
      c.closed.add(row.id);
      decided.add(row.id);
      item("approve_queued");
      continue;
    }
    const words = channelCardCutHeld({ channel_slug: ch, title: row.title, step: (row.step ?? "").replace(/\s+/g, " ").trim() }, d.why.trim(), evidence);
    if (words) {
      c.out.refused.push(`Approve the ${label}: not judged yet: ${words}.`);
      leave(words);
      continue;
    }
    if (redispatched.has(ch) || !goal || openKeys.has(`${goal.id}:${ch}`)) {
      c.out.refused.push(`Approve the ${label}: not sent back this review.`);
      continue;
    }
    const intent = `Build your own open card "${row.title}" now and propose the exact changes it needs. ${row.step ?? ""}`.trim();
    openKeys.add(`${goal.id}:${ch}`);
    redispatched.add(ch);
    if (!dispatch(c, ch, intent, goal.id, row.id)) {
      c.out.refused.push(`Approve the ${label}: the channel run did not start; the card waits for the founder.`);
      leave(`${channelName(ch)} could not be started to build it`);
      continue;
    }
    c.closed.add(row.id);
    decided.add(row.id);
    item("sent_back");
  }
  return decided;
}

function toolWrites(c: Ctx, calls: ReplayToolCall[]) {
  for (const t of calls) {
    const n = t.name.replace(/^mcp__[^_]+__/, "");
    const i = t.input;
    if (i.dry_run === true) continue;
    const id = `tool-${++c.seq}`;
    if (n === "meta_ads__propose_status_change") {
      const payload = { object_id: String(i.object_id ?? ""), level: i.level === "campaign" ? "campaign" : "adset", status: i.status === "ACTIVE" ? "ACTIVE" : "PAUSED", rationale: "", over_cap: false };
      throughTheDoor(c, { id, run_id: "run-review", exec_class: "meta_ads.set_status", payload, title: `${payload.status === "PAUSED" ? "Pause" : "Resume"} ${payload.object_id}`, table: "decisions" }, "tool", null);
    } else if (n === "meta_ads__propose_budget_change") {
      const payload = {
        ad_set_id: String(i.ad_set_id ?? ""),
        daily_budget_usd: Number(i.proposed_daily_budget_usd ?? 0),
        expected_current_daily_budget_usd: Number(i.current_daily_budget_usd ?? 0),
        rationale: "",
        over_cap: false,
      };
      throughTheDoor(c, { id, run_id: "run-review", exec_class: "meta_ads.update_ad_set_budget", payload, title: `Budget ${payload.ad_set_id} to $${payload.daily_budget_usd}/day`, table: "decisions" }, "tool", null);
    }
  }
}

export function replayApply(w: ReplayWorld, payload: Record<string, unknown>, text: string, toolCalls: ReplayToolCall[] = []): ReplayOutcome {
  const out: ReplayOutcome = { parsed: { ok: false, reason: "" }, applied: [], held: [], questions: [], refused: [], left: [], items: [], toolCalls };
  const c: Ctx = { w, now: new Date(w.now), out, closed: new Set(), extra: [], seq: 0, heldReasons: new Map(), items: [], blocked: new Set(), leftKeys: new Map() };
  toolWrites(c, toolCalls);
  const parsed = parseGoalMoves(text);
  if (!parsed.ok) {
    out.parsed = parsed;
    return out;
  }
  const moves = parsed.value;
  out.parsed = { ok: true, moves };
  const now = c.now;
  const today = utcDay(now);
  const meta = reviewMetaFromPayload(payload);
  const acts = meta.autopilot;
  const reviewedRevs = reviewedRevsFromPayload(payload);
  const shown = shownCardsFromPayload(payload);
  const serverAsks: QuestionAsk[] = [];
  let goals: GoalRow[] = w.goals.map((g) => ({ ...g }));

  const ended = planGoalEnds(goals, today, acts);
  for (const e of ended) if (e.reason === "met") out.applied.push({ kind: "goal_closed", goal_id: e.goal.id });

  const gc = planGoalChanges({ changes: moves.goal_changes, goals, today, now, run_id: "run-review", acts, reviewedRevs });
  serverAsks.push(...gc.held);
  out.refused.push(...gc.refused);
  const changedGoals = new Set<string>();
  for (const wr of gc.writes) {
    changedGoals.add(wr.goal.id);
    out.applied.push({ kind: "goal_changed", goal_id: wr.goal.id, line: wr.line });
    c.items.push({ section: "changed", text: wr.line, goal_id: wr.goal.id, undoable: true });
    goals = goals.map((g) => (g.id === wr.goal.id ? goalAfterChange(wr) : g));
  }

  const openKeys = new Set<string>();
  const liveGoals = goals.filter((g) => endedReason(g, today) === null);
  const adBudgetNow = acts ? (w.adBudget ?? null) : null;
  const decided = workChannelCards(
    c,
    moves,
    shown,
    liveGoals.find((g) => !reviewedRevs || reviewedRevs.get(g.id) === goalRev(g)) ?? null,
    openKeys,
    evidenceFromPayload(payload) ?? null,
  );

  const openAdvice = new Map<string, AdviceCard[] | "unreadable">();
  if (acts && adBudgetNow) {
    const targets = new Set(moves.goals.flatMap((g) => g.moves.map((m) => m.target_agent_slug.trim())).filter((t) => CGO_AD_TARGETS.has(t)));
    for (const ch of targets) {
      openAdvice.set(
        ch,
        openRows(c, [ch])
          .filter((r) => !decided.has(r.id))
          .map((r) => ({ id: r.id, title: r.title, refs: refsOfRow(r).refs })),
      );
    }
  }

  const removed = founderRemovedChannels(w.channels.map((ch) => ({ channel_slug: ch.slug, plan_selected: ch.in_plan ?? true, plan_selected_set_by: ch.added_by })));
  const allowed = new Set<string>([...CGO_TARGETS, ...(adBudgetNow ? CGO_AD_TARGETS : []), ...(acts ? [...CGO_ORGANIC_TARGETS].filter((t) => !removed.has(t)) : [])]);
  const evidence = evidenceFromPayload(payload) ?? null;
  const planned = planGoalCards({ liveGoals, moves, changedGoals, acts, reviewedRevs, allowed, openKeys, recentKeys: new Set(), rejectedOrders: rejectedOrdersFrom(w.steps ?? []), repo: { repo: "replay/site" }, today, openAdvice, evidence });
  if (!planned.needsRepo) {
    out.refused.push(...planned.refused);
    serverAsks.push(...planned.asks);
    for (const pg of planned.goals) {
      for (const card of pg.cards) {
        const intent = String(card.body.intent);
        const autoRuns = CGO_AUTO_RUN_TARGETS.has(card.target) || CGO_ORGANIC_TARGETS.has(card.target) || (adBudgetNow !== null && CGO_AD_TARGETS.has(card.target));
        if (acts && autoRuns && dispatch(c, card.target, intent, pg.goal.id)) {
          const reason = cleanReason(card.note?.why);
          c.items.push({ section: "working_on", text: `${channelName(card.target)}: ${itemText(card.note?.action, intent)}`, ...(reason ? { reason } : {}), channel_slug: card.target });
          continue;
        }
        out.applied.push({ kind: "card_proposed", target: card.target, intent });
      }
    }
  }

  if (shouldProposeNextGoal(acts, ended.length, moves, false)) out.applied.push({ kind: "next_goal" });

  const pauseChanges: GoalMoves["channel_changes"] = [];
  for (const cc of moves.channel_changes ?? []) {
    const slug = cc.channel_slug.trim();
    const undecided = CGO_AD_CHANNELS.has(slug) ? [...(shown ?? new Map())].filter(([id, s]) => s.channel_slug === slug && !decided.has(id)) : [];
    if (acts && undecided.length > 0) {
      out.refused.push(`Pause ${slug}: ${undecided.length} of its open cards still wait for a decision.`);
      continue;
    }
    pauseChanges.push(cc);
  }
  const neverApproved = new Set(meta.never_approved ?? []);
  const founderChannels = new Set(meta.founder_channels ?? []);
  const pp = planChannelPauses(pauseChanges, acts, neverApproved, founderChannels);
  serverAsks.push(...pp.asks);
  for (const p of pp.pauses) {
    const gate = evaluateUnattended(
      { kind: "channel_pause", channel_slug: p.slug, trigger: "review" },
      channelPauseFacts({ paidChannel: CGO_AD_CHANNELS.has(p.slug), neverApproved: neverApproved.has(p.slug), evidence: organicEvidenceOf(evidence, p.slug), why: p.why }),
    );
    if (gate.verdict !== "allow") {
      out.held.push({ what: `pause ${p.slug}`, verdict: gate.verdict, reasons: gate.reasons });
      if (gate.verdict === "ask_founder") serverAsks.push({ topic_key: `channel:${p.slug}`, ask: `I think ${p.name} should be paused. Pausing it is your call. Should I?`, default_action: null });
      continue;
    }
    if (founderChannels.has(p.slug)) {
      serverAsks.push({ topic_key: `channel:${p.slug}`, ask: `${p.name}: ${p.why} You added it, so I left it running. Pause it if you agree.`, default_action: null });
      continue;
    }
    out.applied.push({ kind: "channel_paused", slug: p.slug });
    c.items.push({ section: "changed", text: `Paused ${p.name}`, ...(cleanReason(p.why) ? { reason: cleanReason(p.why) } : {}), channel_slug: p.slug, undoable: true });
  }

  const modelAsks = planModelQuestions({ moves, goals, today, acts, reviewedRevs, rejected: new Set([...(meta.rejected_channels ?? []), ...founderChannels]), neverApproved });
  out.refused.push(...modelAsks.refused);
  const heldAsks = out.questions.splice(0);
  for (const q of planQuestions([...serverAsks, ...modelAsks.asks], [], now)) if (!q.queued) out.questions.push({ topic_key: q.topic_key, ask: q.ask, default_action: q.default_action });
  out.questions.push(...heldAsks);
  const saidBefore = new Set((meta.last_need ?? []).map(leftCardKey).filter((k): k is string => k !== null));
  out.left = [...new Set(out.left)].filter((l) => !saidBefore.has(leftCardKey(l) ?? ""));
  const told = new Set([...c.leftKeys].filter(([, k]) => saidBefore.has(k)).map(([id]) => id));
  const qItems: NoteItem[] = out.questions.map((q, i) => ({ section: "needs_you", text: q.ask, question_ordinal: i + 1 }));
  const rootOf = (id: string) => {
    let cur = id;
    const seen = new Set([cur]);
    for (let hop = 0; hop < 5; hop++) {
      const p = w.cards.find((x) => x.id === cur)?.repeat_of;
      if (!p || seen.has(p) || !w.cards.some((x) => x.id === p)) break;
      seen.add(p);
      cur = p;
    }
    return cur;
  };
  out.items = buildNoteItems(
    [...c.items.filter((i) => !(i.action_id && told.has(i.action_id))), ...qItems].map((i) => (i.action_id ? { ...i, chain_root_id: rootOf(i.action_id) } : i)),
    c.blocked,
  );
  return out;
}

export function scripted(moves: Record<string, unknown>): string {
  return `<goal_moves>\n${JSON.stringify(moves)}\n</goal_moves>`;
}
