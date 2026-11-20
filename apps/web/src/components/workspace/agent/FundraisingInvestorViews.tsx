"use client";

import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ExternalLink,
  Flag,
  Link2,
  ListOrdered,
  Mail,
  MessageCircleQuestion,
  Route,
  Search,
  Send,
  Sparkles,
  Target,
  Telescope,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  asHref,
  buildOutreachPlan,
  channelLabel,
  deepRoundFailureNotice,
  hasNamedPartner,
  investorDossier,
  investorOutreachChannel,
  investorStatus,
  investorWriteKey,
  sourceLabel,
  OUTREACH_CHANNELS,
  type DeepRoundFailure,
  type FundraisingInvestor,
  type InvestorStatus,
  type OutreachChannel,
} from "./fundraising-dashboard-util";

export function Btn({
  children,
  onClick,
  ghost,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  ghost?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        ghost
          ? "inline-flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-cta border border-rule bg-cream px-3 py-1.5 text-[16px] font-semibold text-inkSoft transition-colors hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          : "inline-flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-cta border border-ink bg-ink px-3 py-1.5 text-[16px] font-semibold text-cream transition-colors hover:bg-inkSoft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      }
    >
      {children}
    </button>
  );
}

export function Lnk({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer border-none bg-transparent p-0 text-[13px] text-ink underline decoration-inkMuted/60 decoration-1 underline-offset-[3px] transition-colors hover:decoration-ink"
    >
      {children}
    </button>
  );
}

function Sec({ title, icon: Icon, children }: { title: string; icon?: LucideIcon; children: ReactNode }) {
  return (
    <section className="border-t border-rule py-4 first:border-t-0">
      <h4 className="m-0 mb-2 flex items-center gap-2 text-[14px] font-semibold text-ink">
        {Icon ? (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-creamDeep text-inkSoft" aria-hidden="true">
            <Icon className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {title}
      </h4>
      {children}
    </section>
  );
}

function Para({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 mb-2 text-[16px] leading-6 text-inkSoft last:mb-0">
      {children}
    </p>
  );
}

function Lines({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) =>
        line.trim() === "" ? (
          <span key={i} className="block h-2" />
        ) : (
          <span key={i} className="block">
            {line}
          </span>
        ),
      )}
    </>
  );
}

export function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={onBack}
        className="group inline-flex cursor-pointer items-center gap-2 text-[16px] text-inkMuted"
      >
        <ArrowLeft className="h-3.5 w-3.5 shrink-0 group-hover:text-ink" aria-hidden />
        <span className="underline decoration-inkMuted/60 decoration-1 underline-offset-[3px] transition-colors group-hover:text-ink group-hover:decoration-ink">
          Back to the list
        </span>
      </button>
    </div>
  );
}

export const STATUS_TONE: Record<InvestorStatus, string> = {
  new: "bg-bone text-inkMuted",
  researched: "bg-blue-500/15 text-blue-600",
  "reached out": "bg-purple-500/15 text-purple-600",
  replied: "bg-emerald-500/15 text-emerald-600",
  passed: "bg-bone text-inkMuted",
};

export function StatusPill({ status }: { status: InvestorStatus }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-px align-baseline text-[13px] font-medium first-letter:uppercase ${STATUS_TONE[status]}`}
    >
      {status}
    </span>
  );
}

export function Monogram({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  const letters =
    name
      .split(/\s+/)
      .filter((w) => /^[A-Za-z0-9]/.test(w))
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("") || "?";
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-xl bg-bone font-semibold tracking-tight text-inkSoft ${
        size === "lg" ? "h-12 w-12 text-[16px]" : "h-10 w-10 text-[16px]"
      }`}
    >
      {letters}
    </span>
  );
}

const FRAME = "rounded-2xl border border-rule bg-cream px-4";

function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-full bg-bone px-2.5 py-0.5 text-[13px] text-inkMuted first-letter:uppercase">
      {children}
    </span>
  );
}

const MARKABLE: InvestorStatus[] = ["replied", "passed"];

export function InvestorReadView({
  inv,
  researching,
  failure = null,
  onBack,
  onDeepRound,
  onMark,
}: {
  inv: FundraisingInvestor;
  researching: boolean;
  failure?: DeepRoundFailure | null;
  onBack: () => void;
  onDeepRound: (inv: FundraisingInvestor) => void;
  onMark: (
    inv: FundraisingInvestor,
    status: InvestorStatus,
    channel?: OutreachChannel,
  ) => void;
}) {
  const status = investorStatus(inv);
  const warm = hasNamedPartner(inv);
  const d = investorDossier(inv);
  const canMark = investorWriteKey(inv) !== null;
  const statedChannel = investorOutreachChannel(inv);
  const [asking, setAsking] = useState(false);

  return (
    <div>
      <BackLink onBack={onBack} />
      <div className="flex items-start gap-3.5">
        <Monogram name={inv.firm} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[20px] font-semibold leading-7 tracking-tight text-ink">
            {inv.firm}
          </h2>
          <div className="mt-0.5 text-[14px] text-inkSoft">
            {warm ? (
              inv.name
            ) : (
              <span className="text-amber-600">no named partner</span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <MetaChip>Tier {inv.tier || 3}</MetaChip>
            <MetaChip>{sourceLabel(inv.source)}</MetaChip>
            <MetaChip>{inv.durable_email ? inv.durable_email : "no email on file"}</MetaChip>
          </div>
        </div>
      </div>

      <div className={`mt-5 ${FRAME}`}>
        <Sec title="Why they're on your list" icon={Target}>
          <Para>{inv.fit_rationale || "No fit note was recorded for this row."}</Para>
          {asHref(inv.source_url) ? (
            <a
              href={asHref(inv.source_url) as string}
              target="_blank"
              rel="noopener noreferrer"
              className="group break-all text-[13px] text-ink underline decoration-inkMuted/60 decoration-1 underline-offset-[3px] transition-colors hover:decoration-ink"
            >
              {inv.source_url}
              <ExternalLink className="ml-1 inline h-3.5 w-3.5 -translate-y-px align-middle text-inkMuted group-hover:text-ink" aria-hidden />
            </a>
          ) : null}
        </Sec>

        {!d ? (
          <Sec title="Everything else" icon={Telescope}>
            <div className="rounded-2xl border border-dashed border-inkMuted/30 bg-cream px-4 py-6 text-center">
              {researching ? (
                <p
                  className="m-0 text-[14px] font-semibold text-ink"
                  role="status"
                  aria-live="polite"
                >
                  Researching {inv.firm}…
                </p>
              ) : failure ? (
                <>
                  <p
                    className="m-0 mb-3 text-[16px] leading-6 text-amber-600"
                    role="status"
                    aria-live="polite"
                  >
                    {deepRoundFailureNotice(failure, inv.firm)}
                  </p>
                  <Btn onClick={() => onDeepRound(inv)}>
                    Try {inv.firm} again
                  </Btn>
                </>
              ) : (
                <>
                  <p className="mx-auto mb-3 mt-0 max-w-md text-[16px] leading-6 text-inkMuted">
                    Who they are, how to reach them, and what they&apos;ll push
                    on all come from a deep round.
                  </p>
                  <Btn onClick={() => onDeepRound(inv)}>
                    Deep round {inv.firm}
                  </Btn>
                </>
              )}
            </div>
          </Sec>
        ) : (
          <>
            <Sec title="Who they are" icon={UserRound}>
              <Para>{d.who}</Para>
            </Sec>
            <Sec title="Why you, specifically" icon={Sparkles}>
              <Para>{d.why_you}</Para>
            </Sec>
            <Sec title="How to reach them" icon={Route}>
              <div className="rounded-xl bg-emerald-500/10 px-4 py-3 text-[16px] leading-6 text-inkSoft shadow-[inset_3px_0_0_rgb(16_185_129/0.6)]">
                <Lines text={d.how_to_reach} />
              </div>
            </Sec>
            <Sec title="Draft first message" icon={Mail}>
              {d.draft_message.trim() ? (
                <>
                  <div className="whitespace-pre-wrap rounded-xl border border-rule bg-creamDeep px-4 py-3 font-[inherit] text-[16px] leading-6 text-inkSoft shadow-[inset_3px_0_0_rgb(var(--c-ink)/0.25)]">
                    {d.draft_message}
                  </div>
                  <p className="m-0 mt-2 text-[13px] text-inkMuted">
                    Zavi does not send. Copy it and send it yourself.
                  </p>
                </>
              ) : (
                <div className="rounded-xl bg-amber-500/15 px-4 py-3 text-[16px] leading-6 text-amber-600">
                  {}
                  No draft.{" "}
                  {d.no_draft_reason ? (
                    d.no_draft_reason
                  ) : (
                    <>
                      Zavi won&apos;t write a message to a person it
                      couldn&apos;t verify. Name the partner at {inv.firm}{" "}
                      first, then this fills in.
                    </>
                  )}
                </div>
              )}
            </Sec>
            <Sec title="What they'll push on" icon={MessageCircleQuestion}>
              <Para>{d.what_theyll_push_on}</Para>
            </Sec>
            <Sec title="Sources" icon={Link2}>
              <div className="text-[13px] leading-6 text-inkMuted">
                {d.sources.length === 0 ? (
                  <span>No sources were recorded for this dossier.</span>
                ) : (
                  d.sources.map((s, i) => (
                    <span key={`${s}-${i}`} className="flex items-start gap-2">
                      <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-inkLight" aria-hidden />
                      <span className="min-w-0 break-words">{s}</span>
                    </span>
                  ))
                )}
              </div>
              <p className="m-0 mt-2 text-[13px] text-inkMuted">
                Every claim above traces to one of these pages. Nothing is from
                memory.
              </p>
            </Sec>
          </>
        )}

        <Sec title="Where this stands" icon={Flag}>
          <Para>
            Currently: <StatusPill status={status} />. Zavi doesn&apos;t send and
            won&apos;t chase you. Marking it here is what keeps the list honest.
          </Para>
          {canMark ? (
            <div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-rule bg-creamDeep/50 px-4 py-2.5">
                {status !== "reached out" ? (
                  statedChannel ? (
                    <Lnk onClick={() => onMark(inv, "reached out", statedChannel)}>
                      mark reached out via {channelLabel(statedChannel)}
                    </Lnk>
                  ) : (
                    <Lnk onClick={() => setAsking(true)}>mark reached out</Lnk>
                  )
                ) : null}
                {MARKABLE.filter((s) => s !== status).map((s) => (
                  <Lnk key={s} onClick={() => onMark(inv, s)}>
                    mark {s}
                  </Lnk>
                ))}
                {status !== "new" && status !== "researched" ? (
                  <Lnk onClick={() => onMark(inv, "new")}>clear</Lnk>
                ) : null}
              </div>
              {asking ? (
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-rule bg-creamDeep px-4 py-2.5">
                  <span className="text-[13px] text-inkSoft">
                    Which channel? Zavi won&apos;t guess this one.
                  </span>
                  {OUTREACH_CHANNELS.map((c) => (
                    <Lnk
                      key={c.value}
                      onClick={() => {
                        setAsking(false);
                        onMark(inv, "reached out", c.value);
                      }}
                    >
                      {c.label}
                    </Lnk>
                  ))}
                  <Lnk onClick={() => setAsking(false)}>cancel</Lnk>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="m-0 text-[13px] text-inkMuted">
              This row predates the durable investor key, so its status
              can&apos;t be saved yet. Refine the list to re-save it.
            </p>
          )}
        </Sec>
      </div>
    </div>
  );
}

export function OutreachPlanView({
  investors,
  onBack,
  onOpen,
}: {
  investors: FundraisingInvestor[];
  onBack: () => void;
  onOpen: (inv: FundraisingInvestor) => void;
}) {
  const plan = buildOutreachPlan(investors);
  const total = plan.goFirst.length + plan.researchFirst.length;

  return (
    <div>
      <BackLink onBack={onBack} />
      <h2 className="m-0 text-[20px] font-semibold leading-7 tracking-tight text-ink">
        Outreach plan
      </h2>
      <div className="mt-0.5 text-[16px] text-inkMuted">
        Built from {total} deep round{total === 1 ? "" : "s"}. Only investors you
        actually researched appear here.
      </div>

      <div className={`mt-5 ${FRAME}`}>
        <Sec title={`Go first: a named partner (${plan.goFirst.length})`} icon={ListOrdered}>
          {plan.goFirst.length === 0 ? (
            <Para>None yet.</Para>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {plan.goFirst.map((inv, i) => (
                <li
                  key={investorWriteKey(inv) ?? `${inv.firm}-${i}`}
                  className="flex items-start gap-3 rounded-xl border border-rule bg-creamDeep/50 px-3.5 py-3"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-semibold tabular-nums text-cream">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 text-[16px] leading-6 text-inkSoft">
                    <b className="text-ink">{inv.firm}</b>, {inv.name}.{" "}
                    {investorStatus(inv) === "researched"
                      ? "Draft is ready. You send it."
                      : `Status: ${investorStatus(inv)}.`}
                  </div>
                  <Lnk onClick={() => onOpen(inv)}>read</Lnk>
                </li>
              ))}
            </ol>
          )}
        </Sec>

        <Sec title={`Research before contact (${plan.researchFirst.length})`} icon={Search}>
          {plan.researchFirst.length === 0 ? (
            <Para>None.</Para>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {plan.researchFirst.map((inv, i) => (
                <li
                  key={investorWriteKey(inv) ?? `${inv.firm}-${i}`}
                  className="flex items-start gap-3 rounded-xl border border-rule bg-creamDeep/50 px-3.5 py-3"
                >
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600">
                    <Search className="h-3 w-3" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1 text-[16px] leading-6 text-inkSoft">
                    <b className="text-ink">{inv.firm}</b>: no named partner.
                    Find who owns your category on their team page before spending a
                    message.
                  </div>
                  <Lnk onClick={() => onOpen(inv)}>read</Lnk>
                </li>
              ))}
            </ul>
          )}
        </Sec>

        <Sec title="Everyone else" icon={Users}>
          <Para>
            {plan.unresearched} saved investor
            {plan.unresearched === 1 ? " has" : "s have"} no deep round.
            Don&apos;t contact them yet. An un-researched cold message burns a
            name you might want later.
          </Para>
        </Sec>

        <Sec title="Sending" icon={Send}>
          <Para>
            Zavi does not send anything. Every draft on this plan is yours to
            copy and send from your own inbox, then mark here.
          </Para>
        </Sec>
      </div>
    </div>
  );
}
