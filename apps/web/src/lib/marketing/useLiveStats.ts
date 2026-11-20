"use client";

import { useSyncExternalStore } from "react";
import { getLiveStatsSettled, getLiveStatsSnapshot, subscribeLiveStats, type LiveStatsState } from "./liveStats";

export function useLiveStats(): LiveStatsState {
  return useSyncExternalStore(subscribeLiveStats, getLiveStatsSnapshot, () => null);
}

export function useLiveStatsSettled(): boolean {
  return useSyncExternalStore(subscribeLiveStats, getLiveStatsSettled, () => false);
}
