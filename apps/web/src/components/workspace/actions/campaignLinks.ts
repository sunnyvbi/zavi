import { useSyncExternalStore } from "react";
import type { LinkedinCampaignState } from "../agent/linkedinAdsTables";

export type CampaignLinks = Record<string, string>;
export type LinkedinCampaignStates = Record<string, LinkedinCampaignState>;

const EMPTY: CampaignLinks = {};
const store = new Map<string, CampaignLinks>();
const listeners = new Set<() => void>();

export function setCampaignLinks(slug: string, links: CampaignLinks): void {
  const prev = store.get(slug);
  if (prev && JSON.stringify(prev) === JSON.stringify(links)) return;
  store.set(slug, links);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCampaignLinks(slug: string): CampaignLinks {
  return useSyncExternalStore(
    subscribe,
    () => store.get(slug) ?? EMPTY,
    () => EMPTY,
  );
}

const accounts = new Map<string, string | null>();

export function setChannelAccount(slug: string, id: string | null): void {
  if ((accounts.get(slug) ?? null) === id) return;
  accounts.set(slug, id);
  listeners.forEach((l) => l());
}

export function useChannelAccount(slug: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => accounts.get(slug) ?? null,
    () => null,
  );
}

const NO_STATES: LinkedinCampaignStates = {};
const campaignStates = new Map<string, LinkedinCampaignStates>();

export function setCampaignStates(slug: string, states: LinkedinCampaignStates): void {
  const prev = campaignStates.get(slug);
  if (prev && JSON.stringify(prev) === JSON.stringify(states)) return;
  campaignStates.set(slug, states);
  listeners.forEach((l) => l());
}

export function useCampaignStates(slug: string): LinkedinCampaignStates {
  return useSyncExternalStore(
    subscribe,
    () => campaignStates.get(slug) ?? NO_STATES,
    () => NO_STATES,
  );
}

export const CHANNEL_DASHBOARD_STALE_EVENT = "zavi:channel-dashboard-stale";

export function announceChannelDashboardStale(slug: string, scope?: "selection"): void {
  window.dispatchEvent(new CustomEvent(CHANNEL_DASHBOARD_STALE_EVENT, { detail: scope ? { slug, scope } : { slug } }));
}

export function campaignHref(name: string, links: CampaignLinks): string | null {
  return links[name] ?? links[Object.keys(links).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ""] ?? null;
}
