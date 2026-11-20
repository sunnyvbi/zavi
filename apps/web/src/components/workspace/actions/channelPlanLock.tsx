"use client";

import { createContext, useContext, type ReactNode } from "react";
import { ApiError } from "@/lib/workspace/channelActionsApi";
import { isPlanUpgradeRefusal, requiredTierFromBody, type LockTier } from "@/lib/workspace/planUpgrade";

export type ChannelPlanLock = {
  tierName: string | null;
  upgrade: (tier?: LockTier | null, opts?: { clicked?: boolean }) => void;
  soon?: boolean;
};

const ChannelPlanLockContext = createContext<ChannelPlanLock | null>(null);

export function ChannelPlanLockProvider({
  value,
  children,
}: {
  value: ChannelPlanLock | null;
  children: ReactNode;
}) {
  return <ChannelPlanLockContext.Provider value={value}>{children}</ChannelPlanLockContext.Provider>;
}

export function useChannelPlanLock(): ChannelPlanLock | null {
  return useContext(ChannelPlanLockContext);
}

export function planRefusalTier(status: number, body: unknown): { tier: LockTier | null } | null {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (!isPlanUpgradeRefusal(status, typeof code === "string" ? code : null)) return null;
  return { tier: requiredTierFromBody(body) };
}

export function upgradeOnPlanRefusal(lock: ChannelPlanLock | null, e: unknown): boolean {
  if (!lock || !(e instanceof ApiError)) return false;
  const refusal = planRefusalTier(e.status, e.body);
  if (!refusal) return false;
  lock.upgrade(refusal.tier);
  return true;
}
