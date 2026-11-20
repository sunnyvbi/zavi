"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { creatorFeeBreakdown, MAX_PRICE_CENTS, type CreatorFeeBreakdown } from "@zavi/shared";
import {
  CHANNEL_DRAWER_PARAMS,
  FIND_FILTER_PARAMS,
  pushWorkspaceLocation,
  readWorkspaceLocation,
  replaceWorkspaceLocation,
  WORKSPACE_LOCATION_EVENT,
} from "../navigation/workspaceRoutes";

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(WORKSPACE_LOCATION_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(WORKSPACE_LOCATION_EVENT, listener);
  };
}

export const DRAWERS = ["find", "hire", "applicants", "brief", "thread", "review", "job", "inbox"] as const;
export type DrawerName = (typeof DRAWERS)[number];

export const DRAWER_KEYS = CHANNEL_DRAWER_PARAMS;
export type DrawerKey = (typeof DRAWER_KEYS)[number];
export type DrawerParams = Partial<Record<Exclude<DrawerKey, "drawer">, string>>;

export type DrawerState = { name: DrawerName | null; params: DrawerParams };

export function readDrawer(search: string): DrawerState {
  const q = new URLSearchParams(search);
  const raw = q.get("drawer");
  const name = (DRAWERS as readonly string[]).includes(raw ?? "") ? (raw as DrawerName) : null;
  const params: DrawerParams = {};
  for (const k of DRAWER_KEYS) {
    if (k === "drawer") continue;
    const v = q.get(k);
    if (v) params[k] = v;
  }
  return { name, params };
}

export function drawerUrl(current: string, name: DrawerName | null, params: DrawerParams = {}): string {
  const url = new URL(current, "https://workspace.local");
  for (const k of DRAWER_KEYS) url.searchParams.delete(k);
  if (name) {
    url.searchParams.set("drawer", name);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function overFind(name: DrawerName, params: DrawerParams, current: DrawerParams): DrawerParams {
  if (name === "find" || (params.over !== "find" && current.over !== "find")) return params;
  const next: DrawerParams = { ...params, over: "find" };
  for (const k of FIND_FILTER_PARAMS) if (current[k] && !next[k]) next[k] = current[k];
  return next;
}

export function closeUrl(current: string): string {
  const url = new URL(current, "https://workspace.local");
  const { name, params } = readDrawer(url.search);
  if (!name || name === "find" || params.over !== "find") return drawerUrl(current, null);
  const filters: DrawerParams = {};
  for (const k of FIND_FILTER_PARAMS) if (params[k]) filters[k] = params[k];
  return drawerUrl(current, "find", filters);
}

export const UGC_BRIEFS_CHANGED_EVENT = "zavi:ugc-briefs-changed";

export function notifyBriefsChanged() {
  window.dispatchEvent(new Event(UGC_BRIEFS_CHANGED_EVENT));
}

export function useUgcDrawer() {
  const location = useSyncExternalStore(subscribe, readWorkspaceLocation, () => "");
  const search = location.includes("?") ? location.slice(location.indexOf("?")).split("#")[0] : "";
  const state = useMemo(() => readDrawer(search), [search]);
  const open = useCallback((name: DrawerName, params: DrawerParams = {}) => {
    const current = readDrawer(window.location.search).params;
    pushWorkspaceLocation(drawerUrl(window.location.href, name, overFind(name, params, current)));
  }, []);
  const close = useCallback(() => {
    replaceWorkspaceLocation(closeUrl(window.location.href));
  }, []);
  const replace = useCallback((name: DrawerName, params: DrawerParams = {}) => {
    replaceWorkspaceLocation(drawerUrl(window.location.href, name, params));
  }, []);
  return { ...state, open, close, replace };
}

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const whole = cents % 100 === 0;
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function shortDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function dayTimeUtc(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day}, ${hm} UTC`;
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export function feesFor(price_cents: number): CreatorFeeBreakdown | null {
  if (!Number.isInteger(price_cents) || price_cents <= 0 || price_cents > MAX_PRICE_CENTS) return null;
  try {
    return creatorFeeBreakdown(price_cents);
  } catch {
    return null;
  }
}
