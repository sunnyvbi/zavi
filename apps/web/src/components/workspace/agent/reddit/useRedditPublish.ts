"use client";

import { useEffect, useSyncExternalStore } from "react";
import { startRailConnect } from "@/app/connectors/connectStrategies";
import type { ActionItem } from "../../actions/types";
import { redditPublishBlocked } from "../../actions/platforms/_shared";
import { redditPublishViewAlias } from "./publish";
import { publishRedditAction } from "./redditPublishCoordinator";
import {
  REDDIT_PUBLISH_IDLE, REDDIT_PUBLISH_POSTED, redditPublishSnapshot,
  restoreRedditPublishStates, subscribeRedditPublish, writeRedditPublishState,
  type RedditPublishState,
} from "./redditPublishStore";

export { resetRedditPublishStates, type RedditPublishState } from "./redditPublishStore";

export function useRedditPublish(key: string, connected: boolean, alreadyPosted = false) {
  const fallback = alreadyPosted ? REDDIT_PUBLISH_POSTED : REDDIT_PUBLISH_IDLE;
  const alias = redditPublishViewAlias(key);
  const snapshot = () => redditPublishSnapshot(key) ?? redditPublishSnapshot(alias) ?? fallback;
  const state = useSyncExternalStore(subscribeRedditPublish, snapshot, () => fallback);

  useEffect(() => { void restoreRedditPublishStates().catch(() => undefined); }, []);

  const connect = async () => {
    try {
      await startRailConnect("reddit", "reddit_social");
    } catch {
      writeRedditPublishState(key, { ...(redditPublishSnapshot(key) ?? fallback), error: "Couldn't start connecting Reddit. Try again from Settings." }, false);
    }
  };

  const publish = async (action: ActionItem, text: string, after?: () => Promise<string | null>, beforeSubmit?: () => Promise<void>): Promise<boolean> => {
    const current = snapshot();
    if (current.status === "posting" || current.status === "posted") return false;
    if (!connected && current.status !== "unconfirmed" && current.status !== "scheduled") {
      await connect();
      return false;
    }
    const blocked = redditPublishBlocked(action, text);
    if (blocked) {
      writeRedditPublishState(key, { ...current, error: blocked }, false);
      return false;
    }
    writeRedditPublishState(key, { status: "posting", error: null, decisionId: current.decisionId }, false);
    try {
      const delivery = await publishRedditAction(action, { text }, { ownProposal: false, publishNow: true, beforeSubmit });
      if (delivery.status === "scheduled") return false;
      const error = after
        ? await after().catch(() => "Posted to Reddit, but Zavi could not update this card. Check again after refreshing.")
        : null;
      try {
        writeRedditPublishState(key, { ...redditPublishSnapshot(key), status: "posted", error, decisionId: delivery.decisionId });
      } catch {
        writeRedditPublishState(key, { ...redditPublishSnapshot(key), status: "posted", error, decisionId: delivery.decisionId }, false);
      }
      return true;
    } catch (error) {
      if (!redditPublishSnapshot(key)?.error) {
        writeRedditPublishState(key, { ...current, error: error instanceof Error ? error.message : "Could not post to Reddit." }, false);
      }
      return false;
    }
  };

  return { state, publish, connect };
}

export function redditPublishLabel(state: RedditPublishState, connected: boolean): string {
  if (state.status === "unconfirmed" || state.status === "scheduled") return "Check again";
  if (!connected) return "Connect Reddit to post";
  return state.status === "posting" ? "Posting…" : "Approve & post";
}
