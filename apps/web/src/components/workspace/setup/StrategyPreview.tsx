"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import * as copy from "./setupQuestionsCopy";

export type PreviewAnswers = Partial<Record<copy.SetupQuestionKey, string[]>>;

const KEYS: readonly copy.SetupQuestionKey[] = copy.SETUP_STEP_KEYS;

function Row({ label, k, children }: { label: string; k: string | null; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 px-4 py-3.5">
      <dt className="text-xs font-semibold leading-4 text-onboarding-muted">{label}</dt>
      <dd className="text-[15px] leading-[22px]">
        {k ? (
          <span key={k} className="block animate-strategy-write motion-reduce:animate-none">{children}</span>
        ) : (
          <span role="img" aria-label={copy.PREVIEW_NOT_ANSWERED} className="block space-y-1.5">
            <span className="block h-3 w-4/5 animate-strategy-shine rounded-full bg-[linear-gradient(90deg,#f4f4f4_25%,#e9e9e9_50%,#f4f4f4_75%)] bg-[length:200%_100%] motion-reduce:animate-none" />
            <span className="block h-3 w-1/2 rounded-full bg-onboarding-subtle" />
          </span>
        )}
      </dd>
    </div>
  );
}

export function StrategyPreview({ answers }: { answers: PreviewAnswers }) {
  const metric = answers.metric?.[0] ?? null;
  const constraint = answers.constraint?.[0] ?? null;
  const channels = answers.channels ?? [];
  const answered = KEYS.filter((key) => (answers[key] ?? []).length > 0).length;
  const ready = answered === KEYS.length;
  const goal = metric ? copy.PREVIEW_GOALS[metric] : null;
  const blocker = constraint ? copy.PREVIEW_BLOCKERS[constraint] : null;
  const starts = channels.map((c) => copy.PREVIEW_STARTS[c]).filter(Boolean).slice(0, 2);
  return (
    <div data-testid="strategy-preview" className="w-full max-w-[460px] rounded-3xl border border-onboarding-rule bg-white p-6 shadow-onboarding-card">
      <div className="flex items-center gap-3">
        <Image src={ready ? "/mascots/poses/zavi-star-eyes.webp" : "/mascots/poses/zavi-front.webp"} alt="" width={44} height={44} className="size-11 object-contain" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-4 text-onboarding-muted">{copy.PREVIEW_EYEBROW}</p>
          <p aria-live="polite" className="text-base font-semibold leading-6">
            {ready ? copy.PREVIEW_READY : answered ? copy.PREVIEW_WRITING : copy.PREVIEW_EMPTY}
          </p>
        </div>
      </div>
      <dl className="mt-5 divide-y divide-onboarding-rule rounded-2xl border border-onboarding-rule">
        <Row label={copy.PREVIEW_GOAL} k={goal ? metric : null}>
          {goal && <>
            <span className="block font-semibold">{goal.text}</span>
            <span className="mt-0.5 block text-onboarding-secondary">{goal.measure}</span>
          </>}
        </Row>
        <Row label={copy.PREVIEW_BLOCKER} k={blocker ? constraint : null}>
          {blocker && <>
            <span className="block font-semibold">{blocker.text}</span>
            <span className="mt-0.5 block text-onboarding-secondary">{blocker.fix}</span>
          </>}
        </Row>
        <Row label={copy.PREVIEW_START} k={starts.length ? starts.join("|") : null}>
          <span className="block space-y-0.5">
            {starts.map((s) => <span key={s} className="block font-semibold">{s}</span>)}
          </span>
        </Row>
      </dl>
      <div
        role="progressbar"
        aria-label="Strategy written"
        aria-valuemin={0}
        aria-valuemax={KEYS.length}
        aria-valuenow={answered}
        className="mt-4 h-2 overflow-hidden rounded-full bg-onboarding-subtle"
      >
        <span
          className="block h-full rounded-full bg-onboarding-ink transition-[width] duration-300 ease-onboarding-control motion-reduce:transition-none"
          style={{ width: `${(answered / KEYS.length) * 100}%` }}
        />
      </div>
    </div>
  );
}
