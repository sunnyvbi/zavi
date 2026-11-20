"use client";

import { useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { actionFooterParts } from "./AdFooter";
import { useExecFailureToast } from "./ActionFooter";
import { useApproving } from "./useApproving";
import { HowTo } from "./HowTo";
import { settingAskOf } from "./settingAsk";
import { useSettingAsk } from "./SettingAskInline";
import { AudienceSheet } from "./AudienceSheet";
import { audienceSheet } from "./audienceParse";
import { isAudienceReviewCard } from "./audienceReview";
import { ActionRemainingProse } from "./ActionRemainingProse";
import { useAdsPresentation } from "./ads/AdsPresentation";
import { revealActionInstructions } from "./ads/revealActionInstructions";
import { PartTabs } from "./PartTabs";
import { EmailDraft, parseEmailDraft } from "./EmailDraft";
import { BlanksFill, useBlankFills } from "./BlanksFill";
import { opensMail } from "./StoredPrimary";
import { cardTag } from "./registry";
import { TopicPickCost, TopicPickList, TopicResearch, topicPickOf } from "./TopicPick";
import { Markdown } from "@/components/workspace/Markdown";
import { ClampedPane, PaneCaption, SplitCard, isLongDeliverable } from "./SplitCard";
import { ImageFrame, VideoFrame } from "./MediaFrame";
import { cardCopy, clean, remainingCardProse } from "./cardCopy";
import { Bullets, ChipHref, RichText, STEP_STATE, chipNames } from "./CopyBlocks";
import { campaignHref, useCampaignLinks, useChannelAccount } from "./campaignLinks";
import { actionLink, actionText, cardEvidence, copyAllParts, deliverableOf, deliverableParts, exactChangeRows, mediaOf, modelSteps, targetKindOf, cardAccountId, cardManagerLink, type ActionBodyProps, type ActionItem } from "./types";
import type { ExactChangeRow } from "@/lib/workspace/channelActionsApi";

function splitMatch(item: string): { term: string; match: string | null } {
  const m = item.match(/^(.*)\s\((exact|phrase|broad)\)$/i);
  return m ? { term: m[1], match: m[2].toLowerCase() } : { term: item, match: null };
}

const MATCH_LABEL: Record<string, string> = {
  phrase: "Any search containing",
  exact: "Only this exact search",
  broad: "Searches with all of these words",
};

export function groupedChange(rows: ExactChangeRow[]): { before: string; after: string; groups: Array<{ label: string; terms: string[] }> } | null {
  if (rows.length < 4) return null;
  const { before, after } = rows[0];
  if (!rows.every((r) => r.before === before && r.after === after)) return null;
  const groups: Array<{ label: string; terms: string[] }> = [];
  for (const r of rows) {
    const { term, match } = splitMatch(r.item);
    const label = match ? MATCH_LABEL[match] : "Items";
    const g = groups.find((x) => x.label === label);
    if (g) g.terms.push(term);
    else groups.push({ label, terms: [term] });
  }
  return { before, after, groups };
}

const NOTHING_BEFORE = /^Not (chosen|created)$/;

export function ExactChange({ rows, skipEmptyBefore }: { rows: ExactChangeRow[]; skipEmptyBefore?: boolean }) {
  if (!rows.length) return null;
  const grouped = groupedChange(rows);
  const noBefore = !!skipEmptyBefore && rows.every((r) => !r.before || NOTHING_BEFORE.test(r.before));
  return (
    <div data-testid="exact-change">
      <PaneCaption>Exact change</PaneCaption>
      {grouped ? (
        <div className="rounded-xl border border-rule bg-cream px-4 py-3">
          <p className="flex flex-wrap items-center gap-2 text-[14px] text-inkMuted">
            {grouped.before}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            <span className="font-medium text-ink">{grouped.after}</span>
          </p>
          {grouped.groups.map((g) => (
            <div key={g.label} className="mt-3">
              <p className="text-[12px] font-medium text-inkSoft">{g.label}</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {g.terms.map((t, i) => (
                  <span key={`${t}-${i}`} className="rounded-md border border-rule bg-bone px-2 py-0.5 text-[14px] text-ink">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-rule bg-cream">
          <table className="w-full table-fixed text-[14px]">
            <colgroup>
              <col className={noBefore ? "w-[36%]" : "w-[24%]"} />
              {!noBefore && <col className="w-[30%]" />}
              <col />
            </colgroup>
            <thead>
              <tr className="border-b border-rule text-[12px] uppercase tracking-wide text-inkMuted">
                <th scope="col" className="px-4 py-2 text-left font-semibold">Item</th>
                {!noBefore && <th scope="col" className="px-4 py-2 text-left font-semibold">Before</th>}
                <th scope="col" className="px-4 py-2 text-left font-semibold">{noBefore ? "Value" : "After"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-rule last:border-b-0">
                  <td colSpan={r.before || noBefore ? 1 : 2} className="px-4 py-2 align-top text-ink [overflow-wrap:anywhere]">{r.item}</td>
                  {r.before && !noBefore && <td className="px-4 py-2 align-top text-inkMuted [overflow-wrap:anywhere]">{r.before}</td>}
                  <td className="px-4 py-2 align-top text-ink [overflow-wrap:anywhere]">
                    <span data-testid="exact-change-after" className="font-medium">{/^https:\/\/www\.linkedin\.com\/feed\/update\/\S+$/.test(r.after) ? <a className="underline" href={r.after} target="_blank" rel="noreferrer">{r.after}</a> : r.after}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const FALLBACK_LABEL: Record<string, string> = {
  text_post: "Post it",
  image_post: "Post it",
  video_post: "Post it",
  reply: "Reply",
  send_message: "Send it",
  create_ad: "Create ad",
  update_ad: "Apply change",
  pause_ad: "Pause",
  fix: "Fix it",
  check: "Do it",
  setup: "Set it up",
  page: "Open the page",
  other: "Do it",
};

function approveLabelFor(a: ActionItem): string {
  const served = a.body?.action_label;
  if (typeof served === "string" && served.trim()) return served;
  return FALLBACK_LABEL[a.action_type] ?? "Do it";
}

const MARKDOWN_KINDS = new Set(["article", "strategy"]);
const MARKDOWN_AT = 1500;

function DeliverableBox({ label, content, kind }: { label: string | null; content: string; kind?: string }) {
  const rendered = (kind && MARKDOWN_KINDS.has(kind)) || content.length > MARKDOWN_AT;
  return (
    <div>
      {label && <PaneCaption>{label}</PaneCaption>}
      <ClampedPane long={isLongDeliverable(content)} testId="action-deliverable">
        {rendered ? (
          <div data-testid="deliverable-markdown" className="rounded-xl border border-rule bg-cream px-4 py-3 text-[14px] leading-relaxed text-ink [overflow-wrap:anywhere]">
            <Markdown source={content} disableActionLinks />
          </div>
        ) : (
          <p className="whitespace-pre-wrap rounded-xl border border-rule bg-cream px-4 py-3 text-[14px] leading-relaxed text-ink [overflow-wrap:anywhere]">{content}</p>
        )}
      </ClampedPane>
    </div>
  );
}

function StepsPane({ caption, groups, more, names }: { caption: string; groups: StepGroup[]; more: number; names: string[] }) {
  return (
    <div data-testid="action-steps">
      <PaneCaption>{caption}</PaneCaption>
      <div className="space-y-3 rounded-xl border border-rule/70 bg-cream px-4 py-3.5 text-[14px] leading-relaxed text-ink shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_-6px_rgb(0_0_0/0.08)]">
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.header && (
              <div className="mb-1.5 [overflow-wrap:anywhere]">
                <RichText text={g.header} names={names} />
              </div>
            )}
            <ol className="space-y-2">
              {g.items.map((s, i) => (
                <li key={i} className="flex gap-2.5">
                  {g.ordered ? (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand/15 text-[11px] font-semibold text-brand">{i + 1}</span>
                  ) : (
                    <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand/50" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <RichText text={s} names={names} />
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
      {more > 0 && <p className="mt-2 text-[13px] text-inkMuted">and {more} more</p>}
    </div>
  );
}

const LIST_MARK = /^([-*•]|\d+[.)])\s+/;

function stepKey(line: string): string {
  return clean(
    line
      .trim()
      .replace(LIST_MARK, "")
      .replace(/\*\*|__|`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim(),
  ).toLowerCase();
}

type StepGroup = { header: string | null; items: string[]; ordered: boolean };

function bodyLists(text: string, lead: string): StepGroup[] {
  const lines = text.split("\n").map((l) => l.trim());
  const groups: StepGroup[] = [];
  let cur: StepGroup | null = null;
  lines.forEach((line, i) => {
    if (!line) {
      if (!(cur?.header && cur.items.length === 0)) cur = null;
      return;
    }
    if (LIST_MARK.test(line)) {
      const item = line.replace(LIST_MARK, "");
      if (!cur) groups.push((cur = { header: null, items: [], ordered: /^\d/.test(line) }));
      if (/^\d/.test(line)) cur.ordered = true;
      if (clean(item) !== lead) cur.items.push(item);
      return;
    }
    const next = lines.slice(i + 1).find(Boolean) ?? "";
    const header = line.split(/(?<=[.!?])\s+/).pop() ?? line;
    cur = /:$/.test(line) && LIST_MARK.test(next) ? { header, items: [], ordered: false } : null;
    if (cur) groups.push(cur);
  });
  return groups.filter((g) => g.items.length > 0);
}

export function ActionCard({
  action: a,
  platform,
  handlers,
  busy,
  isNew,
  redoing,
  hideActions,
  kindLabel,
  deliverableLabel,
  extra,
}: ActionBodyProps & {
  kindLabel?: string;
  deliverableLabel?: string;
  extra?: ReactNode;
}) {
  const [part, setPart] = useState(0);
  const ads = useAdsPresentation();
  const howRef = useRef<HTMLDivElement>(null);
  const rows = exactChangeRows(a);
  const grouped = groupedChange(rows);
  const changeUpFront = rows.length > 0;
  const copy = cardCopy(a, !!grouped || changeUpFront);
  const links = useCampaignLinks(a.channel_slug);
  const account = useChannelAccount(a.channel_slug);
  const accountHref = platform?.taskLink ? (cardManagerLink(a) ?? platform.taskLink(null, cardAccountId(a) ?? account)) : null;
  const hrefFor = (name: string) => campaignHref(name, links) ?? (rows.some((r) => r.item === name) ? null : (accountHref ?? platform?.manageUrl ?? null));
  const names = chipNames([copy.lead, ...copy.why, ...copy.steps], a.channel_slug === "linkedin_ads" ? [] : rows, Object.keys(links));
  const d = deliverableOf(a);
  const pickTopics = topicPickOf(a);
  const pickIndex = pickTopics ? Math.min(part, pickTopics.length - 1) : null;
  const parts = deliverableParts(a);
  const shownPart = parts ? parts[Math.min(part, parts.length - 1)] : null;
  const rawCopy = shownPart?.content ?? d?.content ?? null;
  const subject = d?.label ?? a.title;
  const sheet = d && !parts ? audienceSheet(d.content) : null;
  const review = isAudienceReviewCard(a);
  const fills = useBlankFills(a.executable ? [] : opensMail(a) && !(rawCopy && parseEmailDraft(rawCopy)) ? [subject, rawCopy] : [rawCopy], d?.kind, a.channel_slug, sheet && !a.executable ? { slug: a.channel_slug, cardId: a.id } : null);
  const full = (actionText(a) ?? "").trim();
  const lists = bodyLists(full, copy.leadFull);
  const stepGroups: StepGroup[] = lists.length ? lists : copy.steps.length ? [{ header: null, items: copy.steps, ordered: true }] : [];
  const askField = settingAskOf(a, platform?.settings);
  const taskSteps = !askField && a.card_kind === "task" && !!modelSteps(a) && !!a.how_to?.length && !d && !parts && rows.length === 0;
  const stepsOnRight = !askField && !taskSteps && !d && !parts && rows.length === 0 && stepGroups.length > 0;
  const stepsTitle = a.executable ? "What Zavi will do" : "How to do this";
  const stepLines = new Set(stepsOnRight ? stepGroups.flatMap((g) => [...(g.header ? [g.header] : []), ...g.items]) : []);
  const stepKeys = new Set(Array.from(stepLines, stepKey));
  const howToRepeats = !!a.how_to?.length && a.how_to.every((h) => stepKeys.has(stepKey(h)));
  const hideHowTo = !!askField || taskSteps || (stepsOnRight && (howToRepeats || (a.card_kind === "task" && !modelSteps(a))));
  const summary = [copy.lead, ...copy.why, ...Array.from(stepLines, (line) => clean(line))].join(" ");
  const shownProse = [copy.leadFull, ...copy.why, ...stepLines].join(" ");
  const rest = remainingCardProse(full, summary, shownProse, stepLines);
  const hasDetails = !!rest || copy.leadCut || (copy.steps.length > 0 && !stepsOnRight) || (!!grouped && !changeUpFront) || copy.gain.length > 1;
  const expanded = hasDetails;
  const steps = rest && !rows.length ? [] : copy.steps;
  const why = copy.why;
  const stepState = a.exec_status ? STEP_STATE[a.exec_status] : undefined;
  const bring = cardEvidence(a).estimate[0] ?? null;
  const media = mediaOf(a);
  useExecFailureToast(a, platform?.name ?? "the ad platform", platform?.execCopy);
  const approve = useApproving(a, handlers);
  const ask = useSettingAsk({ slug: a.channel_slug, field: askField, busy: busy || approve.approving, onSaved: async () => { await approve.handlers.onSetStatus(a, "acted"); } });
  const { footer, status, banner } = actionFooterParts({
    a,
    handlers: approve.handlers,
    approving: approve.approving,
    busy: busy || (pickTopics !== null && redoing === "working"),
    pickIndex,
    link: actionLink(a),
    fallbackLink: a.card_kind === "task" && !review ? (platform?.taskLink?.(targetKindOf(a) ?? (sheet ? "audience" : null), account ?? cardAccountId(a)) ?? platform?.manageUrl ?? null) : null,
    fallbackLabel: platform?.taskLinkLabel ?? null,
    platformName: platform?.name ?? "the ad platform",
    execCopy: platform?.execCopy,
    execPartial: platform?.execPartial && accountHref ? { ...platform.execPartial, href: accountHref } : platform?.execPartial,
    campaignWorkspace: platform?.campaignWorkspace,
    approveLabel: approveLabelFor(a),
    copyText: rawCopy === null ? null : fills.fill(rawCopy),
    copyAllText: parts ? copyAllParts(parts.map((p) => ({ label: p.label, content: fills.fill(p.content) }))) : null,
    copyKind: d?.kind ?? null,
    subject: fills.fill(subject),
    onShowSteps: () => revealActionInstructions(howRef.current),
    settingAsk: ask.primary ?? undefined,
    lockPrimary: sheet && fills.left > 0 ? "Fill every blank in the audiences first" : null,
    hideActions,
  });
  const changeNode = changeUpFront ? <ExactChange key="change" rows={rows} skipEmptyBefore={a.channel_slug === "linkedin_ads"} /> : null;
  const blanksNode = fills.blanks.length && !sheet ? <BlanksFill key="blanks" fills={fills} /> : null;
  const topicNode = pickTopics && pickIndex !== null ? (
    <div key="topics">
      <PaneCaption>{`Zavi's research · ${pickTopics[pickIndex].title}`}</PaneCaption>
      <TopicResearch topic={pickTopics[pickIndex]} />
    </div>
  ) : null;
  const deliverableNode = d ? <DeliverableBox key="deliverable" label={d.label ?? deliverableLabel ?? "What to use"} content={fills.fill(d.content)} kind={d.kind} /> : null;
  const rightParts = topicNode ? [topicNode] : [
    extra ? <div key="extra">{extra}</div> : null,
    changeNode,
    media ? (
      <div key="media">
        {media.kind === "video" ? (
          <VideoFrame url={media.url} downloadUrl={a.exec_status === "executed" && platform?.execCopy ? null : media.downloadUrl} />
        ) : (
          <ImageFrame url={media.url} alt={media.alt} />
        )}
      </div>
    ) : null,
    parts && shownPart && parts.every((p) => parseEmailDraft(p.content)) ? (
      <div key="deliverable">
        <PaneCaption>{d?.label ?? deliverableLabel ?? "What to use"}</PaneCaption>
        <EmailDraft
          content={shownPart.content}
          copyText={fills.fill(shownPart.content)}
          copyDisabled={fills.left > 0}
          tabs={{ labels: parts.map((p) => p.label), selected: Math.min(part, parts.length - 1), onSelect: setPart }}
          values={fills.values}
          active={fills.active}
        />
      </div>
    ) : parts && shownPart ? (
      <div key="deliverable">
        <PaneCaption>{d?.label ?? deliverableLabel ?? "What to use"}</PaneCaption>
        <PartTabs labels={parts.map((p) => p.label)} selected={Math.min(part, parts.length - 1)} onSelect={setPart} copyText={fills.fill(shownPart.content)} copyDisabled={fills.left > 0}>
          <DeliverableBox key={part} label={null} content={fills.fill(shownPart.content)} kind={d?.kind} />
        </PartTabs>
      </div>
    ) : d && parseEmailDraft(d.content) ? (
      <div key="deliverable">
        <PaneCaption>{d.label ?? deliverableLabel ?? "What to use"}</PaneCaption>
        <EmailDraft content={d.content} copyText={fills.fill(d.content)} copyDisabled={fills.left > 0} values={fills.values} active={fills.active} />
      </div>
    ) : d && sheet ? (
      <AudienceSheet key="deliverable" label={d.label ?? deliverableLabel ?? "What to use"} intro={sheet.intro} audiences={sheet.audiences} fills={fills} />
    ) : d ? (
      deliverableNode
    ) : null,
    blanksNode,
    taskSteps && !ads ? (
      <div key="how-to" ref={howRef}>
        <HowTo a={a} />
      </div>
    ) : null,
    stepsOnRight ? (
      <div key="steps" ref={hideHowTo ? howRef : undefined}>
        <StepsPane caption={lists.length ? "Details" : stepsTitle} groups={stepGroups} more={lists.length ? 0 : copy.moreSteps} names={names} />
      </div>
    ) : null,
  ].filter(Boolean);
  const right = rightParts.length ? <div className="space-y-4">{rightParts}</div> : null;
  return (
    <ChipHref.Provider value={hrefFor}>
      <SplitCard
        a={a}
        approving={approve.approving}
        icon={platform?.icon}
        kind={cardTag(a, kindLabel)}
        isNew={isNew}
        lead={
          copy.lead ? (
            <RichText text={expanded ? copy.leadFull : copy.lead} names={names} />
          ) : null
        }
        why={<Bullets lines={why} names={names} quiet />}
        bring={bring}
        below={
          hasDetails || rest || (a.how_to?.length && (!hideHowTo || (ads && !askField))) ? (
            <>
              {(!hideHowTo || (ads && !askField)) && (
                <div ref={howRef}>
                  <HowTo a={a} />
                </div>
              )}
              <ActionRemainingProse text={rest} names={names} advertising={!!ads} />
              {expanded && (
                <>
                  {!stepsOnRight && <Bullets title={stepsTitle} lines={steps} names={names} state={stepState} more={rest ? 0 : copy.moreSteps} />}
                  {grouped && !changeUpFront && <ExactChange rows={rows} />}
                  <Bullets title="What you get" lines={copy.gain.slice(1)} names={names} />
                </>
              )}
            </>
          ) : null
        }
        right={right}
        footer={ask.panel ? <div className="space-y-4">{ask.panel}{footer}</div> : footer}
        status={status}
        banner={banner}
        pick={
          pickTopics && pickIndex !== null ? (
            <>
              <TopicPickList topics={pickTopics} selected={pickIndex} onSelect={setPart} />
              <TopicPickCost />
            </>
          ) : undefined
        }
      />
    </ChipHref.Provider>
  );
}
