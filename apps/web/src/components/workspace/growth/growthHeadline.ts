
export const LOADING = "loading" as const;
type Loadable<T> = T | null | typeof LOADING;

export type MeasurementNeed =
  | { kind: "none" }
  | { kind: "manual"; goalId: string }
  | { kind: "connect"; slug: string; name: string }
  | { kind: "other" };

export type HeadlineInputs = {
  pending: Loadable<number>;
  pendingCapped?: boolean;
  activeGoals: number | null;
  measurement: Loadable<MeasurementNeed>;
  channels: Loadable<Array<{ slug: string; name: string; ranAt: string | null; running: boolean; locked?: boolean }>>;
  rivals: Loadable<number>;
  brandVoiceSet: Loadable<boolean>;
  noGoalFirst?: boolean;
};

export type HeadlineAction =
  | { kind: "review"; label: string }
  | { kind: "add_goal"; label: string }
  | { kind: "connect"; label: string; slug: string }
  | { kind: "enter_number"; label: string; goalId: string }
  | { kind: "start_run"; label: string; slug: string }
  | { kind: "add_rivals"; label: string }
  | { kind: "set_voice"; label: string }
  | { kind: "ask"; label: string; question: string }
  | { kind: "recheck"; label: string };

export type Headline = { kind: "loading" } | ReadyHeadline;

export type ReadyHeadline = {
  kind:
    | "review"
    | "no_goal"
    | "unmeasured"
    | "nothing_ran"
    | "needs_plan"
    | "no_rivals"
    | "no_voice"
    | "waiting"
    | "clear"
    | "unknown";
  text: string;
  action: HeadlineAction;
};

const noGoal = (): ReadyHeadline => ({
  kind: "no_goal",
  text: "I have no goal to work toward yet.",
  action: { kind: "add_goal", label: "Add a goal" },
});

export function growthHeadline(i: HeadlineInputs): Headline {
  const loading = { kind: "loading" } as const;
  if (i.noGoalFirst && i.activeGoals === 0) return noGoal();
  if (i.pending === LOADING) return loading;
  if (i.pending !== null && i.pending > 0) {
    const n = i.pendingCapped ? `${i.pending}+` : String(i.pending);
    return {
      kind: "review",
      text: `${n} ${n === "1" ? "action waits" : "actions wait"} for your OK.`,
      action: { kind: "review", label: `Review ${n}` },
    };
  }
  if (i.activeGoals === 0) return noGoal();
  const m = i.measurement;
  if (m === LOADING) return loading;
  if (m?.kind === "manual") {
    return {
      kind: "unmeasured",
      text: "I need this week's number for your goal.",
      action: { kind: "enter_number", label: "Enter this week's number", goalId: m.goalId },
    };
  }
  if (m?.kind === "connect") {
    return {
      kind: "unmeasured",
      text: "I can't measure your goal yet.",
      action: { kind: "connect", label: `Connect ${m.name}`, slug: m.slug },
    };
  }
  if (m?.kind === "other") {
    return {
      kind: "unmeasured",
      text: "I can't measure your goal yet.",
      action: { kind: "ask", label: "Ask how to measure it", question: "How can you start measuring my goal?" },
    };
  }
  const channels = i.channels;
  if (channels === LOADING) return loading;
  const nothingRan =
    channels !== null && channels.every((c) => c.ranAt === null && !c.running);
  const firstIdle = nothingRan ? channels.find((c) => !c.locked) : undefined;
  if (firstIdle) {
    return {
      kind: "nothing_ran",
      text: `Nothing has run yet. Start ${firstIdle.name}?`,
      action: { kind: "start_run", label: `Start ${firstIdle.name}`, slug: firstIdle.slug },
    };
  }
  if (
    channels !== null &&
    channels.length > 0 &&
    channels.every((c) => c.locked) &&
    !channels.some((c) => c.running)
  ) {
    return {
      kind: "needs_plan",
      text: "Your plan's channels need a higher plan.",
      action: { kind: "ask", label: "Ask which plan", question: "Which plan do my channels need, and what can Zavi do on my current plan?" },
    };
  }
  if (i.rivals === LOADING) return loading;
  if (i.rivals === 0) {
    return {
      kind: "no_rivals",
      text: "I don't know your rivals yet.",
      action: { kind: "add_rivals", label: "Add rivals" },
    };
  }
  if (i.brandVoiceSet === LOADING) return loading;
  if (i.brandVoiceSet === false) {
    return {
      kind: "no_voice",
      text: "I don't know how you sound yet.",
      action: { kind: "set_voice", label: "Set brand voice" },
    };
  }
  if (Object.values(i).some((v) => v === null)) {
    return {
      kind: "unknown",
      text: "I couldn't check everything just now.",
      action: { kind: "recheck", label: "Check again" },
    };
  }
  const known = channels ?? [];
  if (known.some((c) => c.running) || known.every((c) => c.ranAt === null)) {
    return {
      kind: "waiting",
      text: "Waiting for the first run. Nothing else needs you.",
      action: { kind: "ask", label: "Ask what happens next", question: "What will you do first, and when?" },
    };
  }
  return {
    kind: "clear",
    text: "Nothing needs you right now.",
    action: { kind: "ask", label: "Ask what happens next", question: "What will you do next, and when?" },
  };
}

export function autonomyLine(channels: Array<{ name: string; autorun: boolean }>): string | null {
  if (channels.length === 0) return null;
  const alone = channels.filter((c) => c.autorun);
  if (alone.length === 0) return "Every channel asks you first.";
  if (alone.length === channels.length) return "CGO may run every channel.";
  const who =
    alone.length === 1
      ? `CGO may run ${alone[0].name}.`
      : alone.length === 2
        ? `CGO may run ${alone[0].name} and ${alone[1].name}.`
        : `CGO may run ${alone.length} channels.`;
  return `${who} The rest ask you first.`;
}
