import { subredditOf, topActionModeOf } from "@/services/channels/top-actions";
import {
  channelRecipeStepEnvelopeSchema,
  hasRecipeSteps,
} from "./channel-recipe-step";

function isRedditDraftPost(payload: unknown): boolean {
  const mode = topActionModeOf(payload);
  return mode?.valid === true && mode.channel_slug === "reddit_organic" && mode.key === "draft_post";
}

export function shouldEmitRedditOrganic(parsed: unknown, payload: unknown): boolean {
  return hasRecipeSteps(parsed) || isRedditDraftPost(payload);
}

const FALLBACK_STEP = {
  title: "Reddit post could not be drafted",
  body: "Zavi finished the draft run but did not produce a safe post. Review the run summary, then try again.",
  blocking: false,
  effort: "minutes",
  evidence: ["The completed Reddit draft run contained no valid post step."],
  action_type: "check",
};

function isOtherDeliverable(step: { deliverable?: { presentation?: unknown } }): boolean {
  const p = step.deliverable?.presentation as { type?: unknown } | undefined;
  return typeof p?.type === "string" && p.type !== "reddit_post";
}

const TITLE_LINE = /^\s*(?:\*\*)?title(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?\s*$/i;
const BODY_LABEL = /^\s*(?:\*\*)?body(?:\*\*)?\s*:\s*(?:\*\*)?\s*/i;
const DISCLOSED = /\b(?:full disclosure|disclosure:|i (?:run|own|built|founded|work (?:at|on|for)|am (?:the )?(?:founder|owner)))\b/i;

type DraftStep = { deliverable?: { content?: unknown; presentation?: unknown } & Record<string, unknown> } & Record<string, unknown>;

function withPostPresentation(step: DraftStep, subreddit: string | null): DraftStep {
  const d = step.deliverable;
  if (!d || d.presentation !== undefined || typeof d.content !== "string" || !subreddit) return step;
  const lines = d.content.split("\n");
  const first = lines.findIndex((line) => line.trim());
  const match = first >= 0 ? TITLE_LINE.exec(lines[first]) : null;
  const title = match?.[1]?.trim() ?? "";
  if (title.length < 8 || title.length > 300) return step;
  const body = lines.slice(first + 1).join("\n").trim().replace(BODY_LABEL, "").trim();
  if (!body) return step;
  const firstBodyLine = body.split("\n").find((line) => line.trim())?.trim() ?? "";
  return {
    ...step,
    deliverable: {
      ...d,
      content: body,
      presentation: {
        type: "reddit_post",
        subreddit,
        title,
        post_type: "text",
        style: "discussion",
        affiliation_disclosure: DISCLOSED.test(firstBodyLine) ? "first_line" : "not_applicable",
        rule_status: "verify_manually",
        potential: { level: "moderate", confidence: "low", reasons: ["Written for this community's rules and recent posts"] },
      },
    },
  };
}

export function ensureRedditDraftPostStep(parsed: unknown, payload: unknown): unknown {
  if (!isRedditDraftPost(payload)) return parsed;
  const result = channelRecipeStepEnvelopeSchema.safeParse(parsed);
  if (!result.success) return parsed;
  const steps = result.data.steps as DraftStep[];
  if (steps.length === 0) return { ...result.data, steps: [FALLBACK_STEP] };
  const mode = topActionModeOf(payload);
  const community = mode?.valid ? mode.inputs.community : null;
  const subreddit = typeof community === "string" ? subredditOf(community) : null;
  const shaped = steps.map((s) => withPostPresentation(s, subreddit));
  const changed = shaped.some((s, i) => s !== steps[i]);
  if (!changed && !shaped.some(isOtherDeliverable)) return parsed;
  const kept = shaped.filter((s) => !isOtherDeliverable(s));
  return { ...result.data, steps: kept.some((s) => s.deliverable) ? kept : [FALLBACK_STEP] };
}

export async function transformRedditDraftPost(
  parsed: unknown,
  payload: unknown,
  transform: (envelope: unknown) => Promise<{ envelope: unknown }>,
): Promise<{ envelope: unknown }> {
  const gated = await transform(parsed);
  const ensured = ensureRedditDraftPostStep(gated.envelope, payload);
  return ensured === gated.envelope ? gated : transform(ensured);
}
