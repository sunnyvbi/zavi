"use client";

import type { ReactNode } from "react";
import { ActionSection } from "./ActionSection";
import { PriorItemsFold, preSwitchCount, switchSignal } from "./ChannelActionsLane";
import { useChannelHistory } from "./useChannelHistory";
import {
  ActionsEmpty,
  type ChannelRunInfo,
} from "../layout/ChannelEmptyStates";
import type { ChannelDetail } from "../layout/channelDetail";
import { platformFor } from "./platforms";
import { storeUnresolved, useChannelActions } from "./useChannelActions";

const META_CHANNEL = "meta_ads";

export function MetaAdsActions({
  legacy,
  workState,
  lastRunAt,
  actionCount,
  children,
}: {
  legacy: ReactNode;
  workState: ChannelDetail["workState"];
  lastRunAt: string | null;
  actionCount: number;
  children: ReactNode;
}) {
  const channel = useChannelActions(META_CHANNEL);
  const platform = platformFor(META_CHANNEL);
  const couldBeSwitched =
    channel.store === "channel_actions" && channel.actions.length === 0;
  const history = useChannelHistory(META_CHANNEL, { enabled: couldBeSwitched });

  if (storeUnresolved(channel)) {
    return (
      <>
        <h3 className="mt-5 text-[16px] font-semibold text-ink">Next steps</h3>
        <p role="status" className="mt-2 text-[13px] leading-5 text-inkMuted">
          Zavi could not load these actions just now, so none are shown rather
          than the wrong ones.{" "}
          <button
            type="button"
            onClick={channel.reload}
            className="font-medium text-ink underline underline-offset-2"
          >
            Try again
          </button>
        </p>
      </>
    );
  }

  if (channel.store === "decisions") return <>{legacy}</>;

  if (channel.store === "unknown") {
    return (
      <>
        <h3 className="mt-5 text-[16px] font-semibold text-ink">Next steps</h3>
        <div className="mt-2 space-y-2" aria-busy="true" aria-live="polite">
          <span className="sr-only">Reading what is waiting on this channel</span>
          {[0, 1].map((i) => (
            <div key={i} className="rounded-2xl border border-rule bg-white p-3.5 opacity-[.55]" aria-hidden>
              <div className="h-3 w-1/2 animate-pulse rounded bg-bone motion-reduce:animate-none" />
              <div className="mt-2 h-2.5 w-5/6 animate-pulse rounded bg-bone motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      </>
    );
  }

  const run: ChannelRunInfo = {
    slug: META_CHANNEL,
    name: platform.name,
    switched: switchSignal(couldBeSwitched, history),
    priorCount: preSwitchCount(history),
    foldBelow: actionCount > 0,
    onRan: channel.reload,
  };

  return (
    <>
      {channel.notice && (
        <p role="status" className="mt-4 text-[13px] leading-5 text-inkMuted">
          {channel.notice}
        </p>
      )}
      <div className="mt-5">
        <ActionSection
          title="Next steps"
          actions={channel.actions}
          completed={channel.completed}
          platform={platform}
          handlers={channel.handlers}
          busyId={channel.busyId}
          more={channel.more}
          onShowMore={channel.showAll}
          emptyGroups
          empty={
            <ActionsEmpty
              workState={workState}
              lastRunAt={lastRunAt}
              run={run}
            />
          }
        />
      </div>
      <PriorItemsFold count={actionCount}>{children}</PriorItemsFold>
    </>
  );
}
