"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cx, FOCUS_RING } from "./shared";
import { Markdown } from "@/components/workspace/Markdown";
import { PostPreview } from "../PostPreview";
import { RECIPE_STEP_CLASS, singleRecipeStep } from "@/lib/workspace/recipeStep";
import { parseProposalView } from "@/components/agents/proposalView";
import { isExactActionCard } from "@/app/approvals/approvalsHelpers";
import { BlockingPill } from "../actions/BlockingPill";

export const SOCIAL_PUBLISH_CLASS = "social.publish.v2";

type InlineDecision = {
  decision_class: string;
  body: Record<string, unknown>;
};

const CLAMP_CLASS = {
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
} as const;

export function ClampedText({ text, lines = 4 }: { text: string; lines?: 2 | 3 | 4 }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => {
      if (el.scrollHeight === 0 && el.clientHeight === 0) return;
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded, lines]);

  return (
    <div>
      <div
        ref={ref}
        className={cx(
          "text-ca-xdark [overflow-wrap:anywhere] [&_li]:text-ca-body [&_p]:text-ca-body",
          !expanded && CLAMP_CLASS[lines],
        )}
      >
        <Markdown source={text} breaks disableActionLinks />
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cx(
            "mt-1 rounded-cta text-ca-action font-semibold text-ca-primary underline underline-offset-4 hover:no-underline",
            FOCUS_RING,
          )}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function exactFields(d: InlineDecision) {
  if (!isExactActionCard(d.decision_class, d.body)) return [];
  return parseProposalView(d.decision_class, null, d.body).fields;
}

export function hasInlineBody(d: InlineDecision): boolean {
  if (exactFields(d).length > 0) return true;
  if (d.decision_class === SOCIAL_PUBLISH_CLASS) return isSocialBody(d.body);
  if (d.decision_class === RECIPE_STEP_CLASS) return singleRecipeStep(d.body) !== null;
  return false;
}

function isSocialBody(body: Record<string, unknown>) {
  return (
    typeof body.channel === "string" &&
    !!body.payload &&
    typeof body.payload === "object" &&
    !Array.isArray(body.payload)
  );
}

export function InlineActionBody({
  decision: d,
  editText,
  editFields,
  recheck,
  onEditPost,
}: {
  decision: InlineDecision;
  editText?: string;
  editFields?: Record<string, unknown>;
  recheck?: boolean;
  onEditPost?: (next: { text: string }) => void;
}) {
  const exact = exactFields(d);
  if (exact.length > 0) {
    return (
      <dl className="mt-2 flex flex-col gap-2">
        {exact.map((f, i) => (
          <div key={`${f.label}-${i}`} className="min-w-0">
            <dt className="text-ca-eyebrow font-medium text-ca-secondary">{f.label}</dt>
            <dd className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-ca-subtle px-3 py-2 text-ca-action text-ca-xdark">
              {f.value}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (d.decision_class === SOCIAL_PUBLISH_CLASS && isSocialBody(d.body)) {
    return (
      <PostPreview
        channel={d.body.channel as string}
        payload={
          editText === undefined
            ? (d.body.payload as Record<string, unknown>)
            : { ...(d.body.payload as Record<string, unknown>), ...editFields, text: editText }
        }
        scheduledAt={d.body.scheduled_at}
        readiness={d.body.readiness}
        recheck={recheck}
        chrome={d.body.channel !== "pinterest_pin"}
        onEdit={onEditPost}
      />
    );
  }
  const step = d.decision_class === RECIPE_STEP_CLASS ? singleRecipeStep(d.body) : null;
  if (!step) return null;
  return (
    <div className="mt-2">
      {(step.blocking || step.effort) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          {}
          {step.blocking && <BlockingPill />}
          {step.effort && (
            <span className="rounded-full bg-ca-subtle px-2 py-0.5 text-ca-eyebrow text-ca-secondary">
              {step.effort}
            </span>
          )}
        </div>
      )}
      {step.body && <ClampedText text={step.body} />}
      {step.evidence.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {step.evidence.map((e, i) => (
            <li key={i} className="text-ca-action text-ca-secondary [overflow-wrap:anywhere]">
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
