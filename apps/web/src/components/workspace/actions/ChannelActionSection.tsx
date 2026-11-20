"use client";

import { useRef, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChannelActionCard } from "./ChannelActionCard";
import type { ActionSectionProps } from "./actionSectionTypes";
import type { ActionItem } from "./types";
import { AdsPresentation, isAdsChannel } from "./ads/AdsPresentation";
import { CardGroup } from "./CardGroup";
import { CardButton } from "./card/CardButton";
import { KeptCardsProvider, useKeptCardList } from "./card/keptCards";
import { partitionAds } from "./ads/adSections";
import { EmptySectionNote } from "../layout/ChannelEmptyCard";
import { ChannelOverviewPanels } from "../email/EmailSettingsPanels";
import { EmailPlanBridge } from "../email/EmailWorkDesign";
import { EmailCardAsk, type EmailCardAskFinder } from "../email/emailCardAsk";
import { useHiddenEmailCards } from "@/lib/workspace/emailCardHidden";
import { base } from "../agent/cardViews";
import { cn } from "@/lib/cn";

const SAME_RUN_MS = 60_000;
const RISE_IN = "motion-safe:[&>*]:animate-ca-rise [&>*]:[animation-fill-mode:backwards] [&>*:nth-child(2)]:[animation-delay:70ms] [&>*:nth-child(3)]:[animation-delay:140ms] [&>*:nth-child(n+4)]:[animation-delay:210ms]";

function sectionActions({ actions, entries, kinds }: ActionSectionProps): ActionItem[] {
  const result = new Map(actions.map((action) => [action.id, action]));
  for (const entry of [...(entries ?? []), ...(kinds?.flatMap((kind) => kind.entries) ?? [])]) {
    for (const action of entry.kind === "card" ? [entry.card] : entry.members) {
      if (!result.has(action.id)) result.set(action.id, action);
    }
  }
  return [...result.values()];
}

export function ChannelActionSection(props: ActionSectionProps) {
  const { handlers, platform, busyId, redoState, newIds, more = 0, onShowMore, onShowLess, lead = [], extra, empty, cooking, emptyGroups = false, keepEmpty = false } = props;
  const email = platform?.headTools === "email_campaign";
  const [planned, setPlanned] = useState<string[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const hiddenCards = useHiddenEmailCards();
  const all = sectionActions(props).filter((action) => !(email && action.email_card === true && hiddenCards.has(action.id)));
  const plannedSet = new Set(email ? [...planned, ...closed] : []);
  const actions = plannedSet.size ? all.filter((action) => !plannedSet.has(action.id)) : all;
  const bridge = useMemo(() => ({
    setPlannedCards: (ids: string[]) => setPlanned((prev) => (prev.length === ids.length && prev.every((id, n) => id === ids[n]) ? prev : ids)),
    setClosedCards: setClosed,
    sentInDone: platform?.doneHistory === true,
  }), [platform?.doneHistory]);
  const findAsk = useMemo<EmailCardAskFinder>(() => (cardId: string, title: string) => {
    const open = handlers.onOpenChat;
    if (!open) return null;
    const action = all.find((a) => a.id === cardId) ?? props.completed?.find((a) => a.id === cardId)
      ?? { ...base(cardId, "email_marketing", "send_message", title, ""), body: {} };
    return () => open(action);
  }, [handlers, all, props.completed]);
  const { kept, value: keptValue } = useKeptCardList();
  const liveIds = new Set(actions.map((action) => action.id));
  const keptIds = new Set(kept.map((action) => action.id));
  const goneRef = useRef(new Set<string>());
  const [epochs, setEpochs] = useState<Record<string, number>>({});
  const liveKey = actions.map((action) => action.id).join("\n");
  useEffect(() => {
    for (const card of kept) {
      if (!liveKey.split("\n").includes(card.id)) {
        goneRef.current.add(card.id);
      } else if (goneRef.current.has(card.id)) {
        goneRef.current.delete(card.id);
        keptValue.release(card.id);
        setEpochs((all) => ({ ...all, [card.id]: (all[card.id] ?? 0) + 1 }));
      }
    }
  }, [kept, liveKey, keptValue]);
  const groups = partitionAds([...actions, ...kept.filter((action) => !liveIds.has(action.id))]);
  const settledIds = new Set((props.completed ?? []).filter((action) => action.status !== "pending" && action.status !== "snoozed").map((action) => action.id));
  const closedIds = new Set([...settledIds].filter((id) => !keptIds.has(id)));
  const stillOpen = (cards: ActionItem[]) => (closedIds.size > 0 ? cards.filter((action) => !closedIds.has(action.id)) : cards);
  const fixCards = stillOpen(groups.fix);
  const readyCards = stillOpen([...groups.ready, ...groups.improve, ...(email ? [] : groups.completed)]);
  const extras = extra?.cards ?? [];
  const renderCard = (action: ActionItem) => {
    const value = { action, platform, handlers, busy: busyId === action.id, redoing: redoState?.[action.id], isNew: newIds?.has(action.id), settled: settledIds.has(action.id) };
    const cardKey = `${action.id}:${epochs[action.id] ?? 0}`;
    return isAdsChannel(action.channel_slug) ? <AdsPresentation key={cardKey} value={value}><ChannelActionCard {...value} /></AdsPresentation> : <ChannelActionCard key={cardKey} {...value} />;
  };
  const groupedCards = (cards: ActionItem[]) => {
    const entries = [...(props.entries ?? []), ...(props.kinds?.flatMap((kind) => kind.entries) ?? [])].filter((entry) => entry.kind === "card" || !entry.members.some((member) => plannedSet.has(member.id)));
    const used = new Set<string>();
    return cards.flatMap((action) => {
      if (used.has(action.id)) return [];
      const group = entries.find((entry) => entry.kind === "group" && entry.members.some((member) => member.id === action.id) && entry.members.every((member) => cards.some((card) => card.id === member.id)));
      if (!isAdsChannel(action.channel_slug) && group?.kind === "group") {
        group.members.forEach((member) => used.add(member.id));
        return [<CardGroup key={group.key} members={group.members} targetKind={group.targetKind} platform={platform} handlers={handlers} busyId={busyId} redoState={redoState} newIds={newIds} />];
      }
      used.add(action.id);
      return [renderCard(action)];
    });
  };
  const noOpen = fixCards.length + readyCards.length === 0 && lead.length === 0 && extras.length === 0 && planned.length === 0;
  const isCooking = !!cooking;
  const wasCooking = useRef(false);
  const before = useRef<Set<string> | null>(null);
  const cookedAt = useRef(0);
  if (isCooking && !wasCooking.current && Date.now() - cookedAt.current > SAME_RUN_MS) before.current = new Set([...fixCards, ...readyCards].map((action) => action.id));
  if (isCooking || wasCooking.current) cookedAt.current = Date.now();
  wasCooking.current = isCooking;
  const fresh = (action: ActionItem) => before.current !== null && !before.current.has(action.id);
  const settledCards = (cards: ActionItem[]) => cards.filter((action) => !fresh(action));
  const designGroups: Array<{ id: "new" | "fix" | "ready"; title: string; cards: ActionItem[]; none?: string }> = [
    { id: "new", title: "New suggestions", cards: [...fixCards, ...readyCards].filter(fresh) },
    { id: "fix", title: "Fix first", cards: settledCards(fixCards), none: "Nothing to fix right now." },
    { id: "ready", title: "Ready for you", cards: settledCards(readyCards), none: "Nothing ready right now." },
  ];
  const section = (
    <section aria-label="What Zavi wants to do" data-testid="action-section" data-design="channel-cards" className="min-w-0">
      {platform?.sectionLead && <p className="mb-5 text-ca-action text-ca-secondary">{platform.sectionLead}</p>}
      {platform?.actionsLeadPanels && platform.actionsLeadPanels.length > 0 && <div data-testid="actions-lead" className="mb-8"><ChannelOverviewPanels panels={platform.actionsLeadPanels} /></div>}
      <div className="flex flex-col gap-8 empty:hidden">
        {isCooking && <div key="cooking" className="motion-safe:animate-ca-rise">{cooking}</div>}
        {noOpen && empty && (!isCooking || keepEmpty) && <div key="empty" hidden={isCooking} className="motion-safe:animate-ca-rise">{empty}</div>}
        {designGroups.map(({ id, title, cards, none }) => {
          const withExtras = id === "ready" && (lead.length > 0 || extras.length > 0);
          const bare = cards.length === 0 && !withExtras;
          if (bare && !(emptyGroups && noOpen && none)) return null;
          return (
            <section key={id} aria-label={title} className="min-w-0" data-ad-section={id}>
              <h3 className="text-ca-section font-semibold tracking-tight text-ca-xdark">{title}</h3>
              {bare ? <div className="mt-4"><EmptySectionNote>{none}</EmptySectionNote></div> : (
                <div className={cn("mt-4 flex flex-col gap-3", id === "new" && RISE_IN)}>{id === "ready" && lead}{id === "ready" && extra?.position === "before" && extras}{groupedCards(cards)}{id === "ready" && extra?.position === "after" && extras}</div>
              )}
            </section>
          );
        })}
        {!noOpen && ((more > 0 && onShowMore) || onShowLess) ? (
          <div className="flex gap-2">
            {more > 0 && onShowMore && <CardButton onClick={onShowMore}>Show more</CardButton>}
            {onShowLess && <CardButton onClick={onShowLess}>Show less</CardButton>}
          </div>
        ) : null}
      </div>
    </section>
  );
  const wrapped: ReactNode = email ? (
    <EmailPlanBridge.Provider value={bridge}>
      <EmailCardAsk.Provider value={findAsk}>{section}</EmailCardAsk.Provider>
    </EmailPlanBridge.Provider>
  ) : section;
  return <KeptCardsProvider value={keptValue}>{wrapped}</KeptCardsProvider>;
}
